"""Instant read detector — captures needle action within ±200ms of a command end."""

import numpy as np

from .events import NeedleAction
from .needle_classifier import NeedleClassifier, SAMPLE_RATE


class InstantReadDetector:
    """Detects the needle action at the instant a command ends (±200ms window)."""

    WINDOW_MS = 200  # ±200ms

    def __init__(self) -> None:
        self._classifier = NeedleClassifier()

    def check_for_read(
        self,
        command_end_timestamp: float,
        meter_data: list[tuple[float, float]],
    ) -> NeedleAction | None:
        """Check for an instant read at the command end time.

        Args:
            command_end_timestamp: Monotonic time when the command ended.
            meter_data: List of (timestamp, value) tuples from the meter buffer.

        Returns:
            NeedleAction if a significant read is detected, None otherwise.
        """
        if not meter_data:
            return None

        window_s = self.WINDOW_MS / 1000.0
        start = command_end_timestamp - window_s
        end = command_end_timestamp + window_s

        # Filter data to the ±200ms window
        window_values = [
            value for ts, value in meter_data
            if start <= ts <= end
        ]

        if len(window_values) < 10:
            return None

        arr = np.array(window_values)
        action, confidence = self._classifier.classify(arr)

        # Only return significant reads
        if action in (NeedleAction.IDLE, NeedleAction.FREE_NEEDLE):
            return None
        if confidence < 0.3:
            return None

        return action
