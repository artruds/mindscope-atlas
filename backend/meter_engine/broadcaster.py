"""Async pipeline: simulator -> classifier -> WebSocket broadcast."""

import asyncio
import logging
import os
import time
from collections import deque
from queue import Empty
from typing import Callable, Awaitable

import numpy as np

from .events import MeterEvent, NeedleAction
from .needle_classifier import NeedleClassifier, WINDOW_SIZE
from .ta_tracker import TATracker
from .charge_tracker import ChargeTracker
from .simulator import MeterSimulator
from .hid_reader import HIDMeterReader

log = logging.getLogger("mindscope.broadcaster")


class MeterBroadcaster:
    """Consumes simulator output, classifies, and broadcasts meter events."""

    CLASSIFY_INTERVAL = 2.0   # classify every 2s
    BROADCAST_RATE = 10       # Hz (send events at 10Hz)
    STORE_INTERVAL = 1.0      # store readings every 1s
    HARDWARE_STALL_TIMEOUT = 3.0
    RECONNECT_COOLDOWN = 4.0

    @staticmethod
    def _use_demo_signal_mode() -> bool:
        """Return True when demo/simulator mode is explicitly requested."""
        mode = os.getenv("MINDSCOPE_METER_MODE", "").strip().lower()
        return mode in {"demo", "sim", "simulator", "mock"}

    def __init__(
        self,
        broadcast_fn: Callable[[dict], Awaitable[None]],
        db_manager: object | None = None,
        session_id: str | None = None,
    ) -> None:
        self.broadcast_fn = broadcast_fn
        self.db_manager = db_manager
        self.session_id = session_id
        demo_mode = self._use_demo_signal_mode()
        self._prefer_hardware = not demo_mode

        # Allow explicit demo mode, otherwise try hardware then fallback to simulator.
        if demo_mode:
            self.hid_reader = None
            self.simulator = MeterSimulator()
            self.using_hardware = False
            log.info("Meter mode: simulator (MINDSCOPE_METER_MODE)")
        else:
            self.hid_reader = HIDMeterReader.create()
            self.simulator = MeterSimulator() if self.hid_reader is None else None
            self.using_hardware = self.hid_reader is not None
        self.classifier = NeedleClassifier()
        self.ta_tracker = TATracker()
        self.charge_tracker = ChargeTracker()

        self._running = False
        self._task: asyncio.Task | None = None
        self._rolling_window: deque[float] = deque(maxlen=WINDOW_SIZE)
        self._raw_buffer: list[tuple[float, float]] = []  # (ts, value) for instant read

        # Current state
        self.current_action = NeedleAction.IDLE
        self.current_confidence = 0.0
        self.current_position = 0.5
        self.current_ta = 2.5
        self.current_raw_signal = 0.0
        self.current_raw_unfiltered = 0.0
        self.samples_received = 0
        self._last_classify_time = 0.0
        self._last_sample_time = time.monotonic()
        self._next_reconnect = 0.0

    async def start(self) -> None:
        """Start simulator and broadcast pipeline."""
        if self._running:
            return
        self._running = True
        if self.hid_reader:
            await self.hid_reader.start()
            log.info("MeterBroadcaster started (hardware)")
        else:
            await self.simulator.start()
            log.info("MeterBroadcaster started (simulator)")
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        """Stop broadcasting."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        if self.hid_reader:
            await self.hid_reader.stop()
        if self.simulator:
            await self.simulator.stop()
        log.info("MeterBroadcaster stopped")

    async def _run(self) -> None:
        """Main loop: consume samples, classify, broadcast."""
        last_classify = time.monotonic()
        last_broadcast = time.monotonic()
        broadcast_interval = 1.0 / self.BROADCAST_RATE

        while self._running:
            now = time.monotonic()

            # Drain sample queue (from HID reader or simulator)
            source_queue = self.hid_reader.queue if self.hid_reader else self.simulator.queue
            drained = 0
            while drained < 20:
                try:
                    ts, value, ta, raw_sig, raw_adc = source_queue.get_nowait()
                    self._rolling_window.append(value)
                    self._raw_buffer.append((ts, value))
                    self.current_position = value
                    self.current_ta = ta
                    self.current_raw_signal = raw_sig
                    self.current_raw_unfiltered = raw_adc
                    self.ta_tracker.update(ta, ts)
                    self.charge_tracker.feed_signal(ts, value)
                    self.samples_received += 1
                    self._last_sample_time = time.monotonic()
                    drained += 1
                except (Empty, asyncio.QueueEmpty):
                    break

            if self._prefer_hardware and now - self._last_sample_time >= self.HARDWARE_STALL_TIMEOUT:
                await self._reconnect_hardware_reader()

            # Trim raw buffer to last 5s
            if self._raw_buffer:
                cutoff = now - 5.0
                self._raw_buffer = [
                    (ts, v) for ts, v in self._raw_buffer if ts >= cutoff
                ]

            # Classify every 2s
            if now - last_classify >= self.CLASSIFY_INTERVAL:
                if len(self._rolling_window) >= WINDOW_SIZE:
                    arr = np.array(list(self._rolling_window))
                    action, conf = self.classifier.classify(arr)
                    self.current_action = action
                    self.current_confidence = conf
                self._last_classify_time = now
                last_classify = now

            # Broadcast at 10Hz
            if now - last_broadcast >= broadcast_interval:
                event = MeterEvent(
                    needle_action=self.current_action,
                    position=self.current_position,
                    tone_arm=self.current_ta,
                    session_id=self.session_id,
                    ta_trend=self.ta_tracker.trend(),
                    confidence=self.current_confidence,
                )
                event_data = event.to_dict()
                event_data["hardwareConnected"] = self.using_hardware
                event_data["samplesReceived"] = self.samples_received
                event_data["rawSignal"] = self.current_raw_signal
                event_data["rawUnfiltered"] = self.current_raw_unfiltered
                event_data["classifiedAt"] = self._last_classify_time
                event_data["classifyWindow"] = self.CLASSIFY_INTERVAL
                event_data["taMotion"] = self.ta_tracker.session_ta_motion()
                await self.broadcast_fn(event_data)
                last_broadcast = now

            await asyncio.sleep(0.01)  # 100Hz check rate

    async def _reconnect_hardware_reader(self) -> None:
        now = time.monotonic()
        if now < self._next_reconnect:
            return
        self._next_reconnect = now + self.RECONNECT_COOLDOWN

        log.warning(
            "No HID samples for %.2fs, attempting hardware reconnect",
            self.HARDWARE_STALL_TIMEOUT,
        )
        self.using_hardware = False

        if self.hid_reader:
            await self.hid_reader.stop()

        self.hid_reader = HIDMeterReader.create()
        if self.hid_reader is None:
            log.warning(
                "Cannot reconnect HID meter; falling back to simulator until reconnect succeeds",
            )
            if self.simulator is None:
                self.simulator = MeterSimulator()
            if not getattr(self.simulator, "_running", False):
                await self.simulator.start()
            self._last_sample_time = time.monotonic()
            return

        self.simulator = None
        self.using_hardware = True
        self._last_sample_time = time.monotonic()
        await self.hid_reader.start()
        log.info("Meter HID reader reconnected")
