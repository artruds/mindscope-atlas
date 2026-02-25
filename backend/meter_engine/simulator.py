"""Generates realistic 100Hz GSR signals for testing without hardware."""

import asyncio
import logging
import math
import random
import time

from .events import NeedleAction

log = logging.getLogger("mindscope.simulator")

SAMPLE_RATE = 100  # Hz
SAMPLE_INTERVAL = 1.0 / SAMPLE_RATE


class MeterSimulator:
    """Simulates a 100Hz GSR meter signal with configurable needle actions."""

    def __init__(self) -> None:
        # Queue items: (timestamp, position, tone_arm, smooth_signal, raw_adc)
        self.queue: asyncio.Queue[tuple[float, float, float, float, float]] = asyncio.Queue(
            maxsize=1000
        )
        self._running = False
        self._task: asyncio.Task | None = None

        # Current state
        self._action = NeedleAction.IDLE
        self._action_duration = float('inf')
        self._action_start = 0.0
        self._position = 0.5  # needle position 0-1
        self._tone_arm = 2.5  # TA value

    def set_action(self, action: NeedleAction, duration: float = 5.0) -> None:
        """Manually trigger a specific needle action pattern."""
        self._action = action
        self._action_duration = duration
        self._action_start = time.monotonic()
        log.info("Simulator action set: %s for %.1fs", action.value, duration)

    async def start(self) -> None:
        """Start generating samples."""
        if self._running:
            return
        self._running = True
        self._action_start = time.monotonic()
        self._task = asyncio.create_task(self._run())
        log.info("Meter simulator started (fallback — no hardware)")

    async def stop(self) -> None:
        """Stop generating samples."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        log.info("Meter simulator stopped")

    async def _run(self) -> None:
        """Main generation loop at 100Hz."""
        next_sample = time.monotonic()

        while self._running:
            now = time.monotonic()

            # Check if current action has expired
            elapsed = now - self._action_start
            if elapsed >= self._action_duration:
                self._advance_action(now)

            t = elapsed  # time within current action
            value = self._generate_sample(t)

            # Slowly drift TA based on action
            self._update_tone_arm(t)

            # Queue: (timestamp, position_value, tone_arm)
            try:
                self.queue.put_nowait((now, value, self._tone_arm, value, value))
            except asyncio.QueueFull:
                # Drop oldest if full
                try:
                    self.queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                self.queue.put_nowait((now, value, self._tone_arm, value, value))

            # Maintain 100Hz timing
            next_sample += SAMPLE_INTERVAL
            sleep_time = next_sample - time.monotonic()
            if sleep_time > 0:
                await asyncio.sleep(sleep_time)
            else:
                next_sample = time.monotonic()

    def _advance_action(self, now: float) -> None:
        """Return to idle when current action expires."""
        self._action = NeedleAction.IDLE
        self._action_duration = float('inf')
        self._action_start = now

    def _generate_sample(self, t: float) -> float:
        """Generate a single sample value for the current action at time t."""
        noise = random.gauss(0, 0.005)

        if self._action == NeedleAction.IDLE:
            return self._position + random.gauss(0, 0.008)

        if self._action == NeedleAction.FALL:
            # Linear ramp down with noise
            rate = -0.08
            self._position = max(0.05, self._position + rate / SAMPLE_RATE)
            return self._position + noise

        if self._action in (
            NeedleAction.LONG_FALL,
            NeedleAction.LONG_FALL_BLOWDOWN,
            NeedleAction.SPEEDED_FALL,
        ):
            rate = -0.12
            self._position = max(0.02, self._position + rate / SAMPLE_RATE)
            return self._position + noise

        if self._action == NeedleAction.RISE:
            rate = 0.06
            self._position = min(0.95, self._position + rate / SAMPLE_RATE)
            return self._position + noise

        if self._action == NeedleAction.FLOATING:
            # Sine wave at 0.3Hz (rhythmic sweep)
            return self._position + 0.12 * math.sin(2 * math.pi * 0.3 * t) + noise

        if self._action == NeedleAction.ROCK_SLAM:
            # High-freq large-amplitude oscillation
            freq = 3.0 + random.random()
            return self._position + 0.25 * math.sin(
                2 * math.pi * freq * t
            ) + random.gauss(0, 0.04)

        if self._action == NeedleAction.THETA_BLINK:
            # Periodic pulses ~7Hz
            return self._position + 0.06 * math.sin(
                2 * math.pi * 7.0 * t
            ) + noise

        if self._action == NeedleAction.STAGE_FOUR:
            # ~1Hz oscillation
            return self._position + 0.10 * math.sin(
                2 * math.pi * 1.0 * t
            ) + noise

        if self._action == NeedleAction.DIRTY_NEEDLE:
            # High-freq random walk
            self._position += random.gauss(0, 0.015)
            self._position = max(0.1, min(0.9, self._position))
            return self._position + random.gauss(0, 0.02)

        if self._action == NeedleAction.FREE_NEEDLE:
            # Very smooth, slight drift
            self._position += random.gauss(0, 0.002)
            self._position = max(0.2, min(0.8, self._position))
            return self._position + noise

        if self._action == NeedleAction.STUCK:
            # Nearly flat
            return self._position + random.gauss(0, 0.0005)

        # Default
        return self._position + noise

    def _update_tone_arm(self, t: float) -> None:
        """Slowly drift TA based on action type."""
        if self._action in (NeedleAction.FALL, NeedleAction.LONG_FALL,
                            NeedleAction.LONG_FALL_BLOWDOWN):
            self._tone_arm = max(1.0, self._tone_arm - 0.002)
        elif self._action == NeedleAction.RISE:
            self._tone_arm = min(5.0, self._tone_arm + 0.002)
        elif self._action == NeedleAction.FLOATING:
            # TA tends toward 2.0 during floating needle
            diff = 2.0 - self._tone_arm
            self._tone_arm += diff * 0.001
        else:
            # Random micro-drift
            self._tone_arm += random.gauss(0, 0.0005)
            self._tone_arm = max(1.0, min(5.5, self._tone_arm))
