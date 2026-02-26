"""Theta-Meter 3G Solo USB HID reader + signal processing pipeline.

Ported from mindscope v1 JavaScript:
  - theta-meter.js: HID report parsing (24-bit ADC)
  - signal-processor.js: biquad lowpass + spring-mass-damper + SET/sensitivity

Device sends ~62Hz HID reports. We read them on a background thread
and push processed samples to an asyncio queue.
"""

from __future__ import annotations

import logging
import math
import os
import queue
import threading
import time

log = logging.getLogger("mindscope.hid_reader")

# ADC conversion factor: 1,650,000 / 2^23 (from native app disassembly)
ADC_SCALE = 1_650_000 / 8_388_608

# Device rate
POLL_RATE_HZ = 62
DT = 1.0 / POLL_RATE_HZ

# Baseline EMA alpha (~30s window at 62Hz)
BASELINE_ALPHA = 1.0 / (30 * POLL_RATE_HZ)
BASELINE_MIN_SAMPLES = 120
RECONNECT_DELAY_SECONDS = 0.75

# Needle scale: units of filtered deviation = full scale at sensitivity 1
# Frontend stacks its own sensitivity (1-32) * SCALE (0.08) * SIGNAL_RANGE (300)
# so backend must NOT over-amplify. 2000 gives good range for typical GSR signals.
NEEDLE_SCALE = 2000


class BiquadFilter:
    """Second-order IIR biquad lowpass (Butterworth, Direct Form II Transposed)."""

    def __init__(self, fc: float, fs: float, q: float = 0.707) -> None:
        w0 = 2 * math.pi * fc / fs
        alpha = math.sin(w0) / (2 * q)
        cosw = math.cos(w0)
        a0 = 1 + alpha
        self.b0 = ((1 - cosw) / 2) / a0
        self.b1 = (1 - cosw) / a0
        self.b2 = ((1 - cosw) / 2) / a0
        self.a1 = (-2 * cosw) / a0
        self.a2 = (1 - alpha) / a0
        self.z1 = 0.0
        self.z2 = 0.0
        self._initialized = False

    def process(self, inp: float) -> float:
        if not self._initialized:
            self.reset(inp)
            self._initialized = True
            return inp
        out = self.b0 * inp + self.z1
        self.z1 = self.b1 * inp - self.a1 * out + self.z2
        self.z2 = self.b2 * inp - self.a2 * out
        return out

    def reset(self, value: float = 0.0) -> None:
        self.z1 = value * (1 - self.b0)
        self.z2 = value * (self.b2 - self.a2)
        self._initialized = True


class SpringMassDamper:
    """Spring-mass-damper with symplectic Euler integration.

    Operates in the raw ADC value domain (~3.2M). No clamping here —
    clamping happens after SET reference subtraction and scaling.
    """

    def __init__(
        self,
        mass: float = 1.0,
        damping: float = 14.1,
        spring: float = 50.0,
        dt: float = DT,
    ) -> None:
        self.mass = mass
        self.damping = damping
        self.spring = spring
        self.dt = dt
        self.velocity = 0.0
        self.position = 0.0
        self._initialized = False

    def step(self, inp: float) -> float:
        if not self._initialized:
            self.position = inp
            self.velocity = 0.0
            self._initialized = True
            return inp
        accel = (
            self.spring * (inp - self.position) - self.damping * self.velocity
        ) / self.mass
        self.velocity += self.dt * accel
        self.position += self.dt * self.velocity
        return self.position


class HIDMeterReader:
    """Reads from Theta-Meter 3G Solo USB HID and processes the signal.

    Produces samples in the same format as MeterSimulator:
        (timestamp, position, tone_arm)
    where position is 0.0–1.0 (0.5 = center/SET).
    """

    def __init__(
        self,
        vid: int = 0x1FC9,
        pid: int = 0x0003,
    ) -> None:
        self.vid = vid
        self.pid = pid
        # Queue items: (timestamp, position, tone_arm, smooth_signal, raw_adc)
        # Use threading.Queue because this reader pushes samples from a background
        # thread while the broadcaster consumes them in the asyncio loop.
        self.queue: queue.Queue[tuple[float, float, float, float, float]] = queue.Queue(
            maxsize=1000
        )
        self._running = False
        self._thread: threading.Thread | None = None

        # Signal processing
        self._biquad = BiquadFilter(3, POLL_RATE_HZ, 0.707)
        self._smd = SpringMassDamper(1.0, 14.1, 50.0, DT)
        self._set_point: float | None = None
        self._baseline: float | None = None
        self._baseline_samples = 0
        self._tone_arm = 2.5
        self._sample_count = 0

    @staticmethod
    def create() -> HIDMeterReader | None:
        """Factory: returns None if device not found or hid not available."""
        try:
            import hid
        except ImportError:
            log.warning("hid package not installed — hardware meter unavailable")
            return None

        vid_str = os.environ.get("THETA_METER_VID", "0x1fc9")
        pid_str = os.environ.get("THETA_METER_PID", "0x0003")
        vid = int(vid_str, 16)
        pid = int(pid_str, 16)

        # Check if device is actually connected
        devices = hid.enumerate(vid, pid)
        if not devices:
            log.info(
                "Theta-Meter not found (VID=0x%04x PID=0x%04x) — using simulator",
                vid, pid,
            )
            return None

        log.info(
            "Theta-Meter found: %s (VID=0x%04x PID=0x%04x)",
            devices[0].get("product_string", "unknown"),
            vid, pid,
        )
        return HIDMeterReader(vid, pid)

    async def start(self) -> None:
        """Start reading HID reports on a background thread."""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()
        log.info("HID meter reader started")

    async def stop(self) -> None:
        """Stop reading."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=2.0)
            self._thread = None
        log.info("HID meter reader stopped")

    def _read_loop(self) -> None:
        """Background thread: open HID device and read reports."""
        import hid

        while self._running:
            try:
                device = hid.Device(self.vid, self.pid)
            except Exception as exc:
                log.warning("Unable to open HID device (%s), retrying in %.2fs", exc, RECONNECT_DELAY_SECONDS)
                time.sleep(RECONNECT_DELAY_SECONDS)
                continue

            log.info("HID device opened")

            try:
                while self._running:
                    try:
                        data = device.read(64, timeout=100)
                    except hid.HIDException:
                        # "Success" exception on macOS for empty/timeout reads
                        continue

                    if not data or len(data) < 5:
                        continue

                    now = time.monotonic()
                    reading = self._parse_report(data)
                    if reading is None:
                        continue

                    processed = self._process_signal(reading, now)
                    if processed is None:
                        continue

                    ts, position, ta, raw_smooth, raw_adc = processed
                    try:
                        self.queue.put_nowait((ts, position, ta, raw_smooth, raw_adc))
                    except queue.Full:
                        try:
                            self.queue.get_nowait()
                        except queue.Empty:
                            pass
                        self.queue.put_nowait((ts, position, ta, raw_smooth, raw_adc))
            except Exception:
                log.exception("HID read loop fatal error")
            finally:
                try:
                    device.close()
                except Exception:
                    pass
                log.info("HID device closed")

            if self._running:
                time.sleep(RECONNECT_DELAY_SECONDS)

        log.info("HID read thread exiting")

    def _parse_report(self, data: bytes) -> float | None:
        """Parse a raw HID report → converted ADC value."""
        if data[0] != 0x01:
            return None
        # 24-bit ADC: bytes [2][3][4] big-endian
        raw24 = (data[2] << 16) | (data[3] << 8) | data[4]
        return raw24 * ADC_SCALE

    def _process_signal(
        self, value: float, timestamp: float
    ) -> tuple[float, float, float, float, float] | None:
        """Run biquad → SMD → SET/sensitivity → 0-1 position.

        Returns (timestamp, position, tone_arm, smooth_signal, raw_adc).
        """
        # 1. Biquad lowpass (operates on raw ADC values ~3.2M)
        filtered = self._biquad.process(value)

        # 2. Spring-mass-damper (also in raw ADC domain, no clamping)
        smooth = self._smd.step(filtered)

        # 3. Baseline tracking (slow EMA)
        if self._baseline is None:
            self._baseline = smooth
        else:
            self._baseline = (
                BASELINE_ALPHA * smooth + (1 - BASELINE_ALPHA) * self._baseline
            )
        self._baseline_samples += 1

        # 4. Auto-SET: capture first stable reading as reference
        if self._set_point is None and self._baseline_samples >= BASELINE_MIN_SAMPLES:
            self._set_point = smooth
            log.info("Auto-SET reference captured: %.2f", smooth)

        # 5. Needle position: deviation from SET reference, scaled
        #    Before auto-SET: use baseline (produces small movements)
        #    After auto-SET: use fixed SET point (deviations show as needle movement)
        #    Inverted: lower signal (squeeze/fall) → positive (right)
        #    Higher signal (release/rise) → negative (left)
        set_ref = self._set_point if self._set_point is not None else self._baseline
        signal_diff = set_ref - smooth
        # sensitivity=1 here; frontend applies its own sensitivity via SCALE
        raw_needle = signal_diff / NEEDLE_SCALE
        needle_pos = max(-1.0, min(1.0, raw_needle))

        # Convert from [-1, +1] needle to [0, 1] position for broadcaster
        # -1 (full left/rise) → 1.0, +1 (full right/fall) → 0.0, center → 0.5
        position = 0.5 - (needle_pos * 0.5)

        # Log first few samples for debugging
        self._sample_count += 1
        if self._sample_count <= 3 or self._sample_count % 620 == 0:
            log.info(
                "HID sample #%d: raw=%.1f smooth=%.1f set_ref=%.1f diff=%.1f needle=%.4f pos=%.4f",
                self._sample_count, value, smooth, set_ref, signal_diff,
                needle_pos, position,
            )

        return (timestamp, position, self._tone_arm, smooth, value)

    def set_reference(self) -> None:
        """Capture current SMD output as the SET reference point."""
        pos = self._smd.position
        if pos != 0 or self._baseline is not None:
            self._set_point = pos
            log.info("SET reference captured: %.2f", pos)
