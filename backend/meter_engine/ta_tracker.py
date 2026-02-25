"""Tone Arm position and trend tracking."""

from collections import deque
from dataclasses import dataclass, field

import numpy as np


@dataclass
class TAReading:
    ta_value: float
    timestamp: float  # monotonic seconds


TA_NOISE_THRESHOLD = 0.001  # Ignore deltas below this


class TATracker:
    """Tracks TA position over time for trend analysis and session readiness."""

    MAX_HISTORY = 30000  # 5 minutes at 100Hz

    def __init__(self) -> None:
        self._history: deque[TAReading] = deque(maxlen=self.MAX_HISTORY)
        self.current: float = 2.0
        # Cumulative session TA motion
        self._session_start_ta: float | None = None
        self._total_down_motion: float = 0.0
        self._total_up_motion: float = 0.0
        self._prev_ta: float | None = None

    def update(self, ta_value: float, timestamp: float) -> None:
        """Append a new TA reading."""
        self.current = ta_value
        self._history.append(TAReading(ta_value, timestamp))

        # Accumulate TA motion
        if self._prev_ta is not None:
            delta = ta_value - self._prev_ta
            if abs(delta) >= TA_NOISE_THRESHOLD:
                if delta > 0:
                    self._total_up_motion += delta
                else:
                    self._total_down_motion += abs(delta)
        self._prev_ta = ta_value

    def reset_session(self) -> None:
        """Reset cumulative TA motion for a new session."""
        self._session_start_ta = self.current
        self._total_down_motion = 0.0
        self._total_up_motion = 0.0

    def session_ta_motion(self) -> dict:
        """Return cumulative TA motion stats."""
        start = self._session_start_ta if self._session_start_ta is not None else self.current
        return {
            "totalDownMotion": round(self._total_down_motion, 3),
            "totalUpMotion": round(self._total_up_motion, 3),
            "netMotion": round(self._total_up_motion - self._total_down_motion, 3),
            "startTA": round(start, 2),
            "currentTA": round(self.current, 2),
        }

    def can_start_session(self) -> tuple[bool, str]:
        """Check if TA is in valid range to start a session."""
        if self.current > 4.0:
            return False, f"TA too high ({self.current:.2f}), must be <= 4.0"
        if self.current < 1.5:
            return False, f"TA too low ({self.current:.2f}), must be >= 1.5"
        return True, "TA in range"

    def is_moving(self, window_seconds: float = 60.0) -> bool:
        """Check if TA has been moving in the recent window."""
        if len(self._history) < 10:
            return False
        readings = self._recent(window_seconds)
        if len(readings) < 2:
            return False
        values = [r.ta_value for r in readings]
        return float(np.std(values)) > 0.05

    def trend(self) -> str:
        """Determine TA trend over last 60 seconds: RISING, FALLING, or STABLE."""
        readings = self._recent(60.0)
        if len(readings) < 10:
            return "STABLE"

        times = np.array([r.timestamp for r in readings])
        values = np.array([r.ta_value for r in readings])

        # Normalize times to start at 0
        times = times - times[0]
        if times[-1] < 1.0:
            return "STABLE"

        slope = float(np.polyfit(times, values, 1)[0])

        if slope > 0.005:
            return "RISING"
        if slope < -0.005:
            return "FALLING"
        return "STABLE"

    def _recent(self, window_seconds: float) -> list[TAReading]:
        """Get readings from the last N seconds."""
        if not self._history:
            return []
        latest_ts = self._history[-1].timestamp
        cutoff = latest_ts - window_seconds
        return [r for r in self._history if r.timestamp >= cutoff]
