"""Charge tracker — measures signal changes correlated with questions."""

import time
import logging
from collections import deque
from dataclasses import dataclass, field

import numpy as np

log = logging.getLogger("mindscope.charge_tracker")


@dataclass
class QuestionCharge:
    """Charge measurement for a single question."""

    question_text: str
    question_time: float  # monotonic timestamp when question was asked
    baseline_signal: float  # average signal in 1s before question
    peak_deviation: float = 0.0  # max deviation from baseline within reaction window
    signal_delta: float = 0.0  # net signal change (baseline → post-question average)
    charge_score: int = 0  # 0-100 composite score
    body_movement: bool = False  # whether reaction was likely body movement
    reaction_window_ms: int = 3000  # how long after question to measure (default 3s)
    needle_action_at_peak: str = "idle"


class ChargeTracker:
    """Tracks signal changes correlated with auditor questions.

    Algorithm:
    1. When an auditor question is broadcast, record the timestamp and capture
       a 1-second baseline of the raw signal preceding the question.
    2. For the next 3 seconds after the question, track the signal:
       - Compute peak deviation from baseline
       - Compute net signal delta (mean of post-question signal vs baseline)
       - Check for body movement pattern (spike shape analysis)
    3. Score the charge 0-100 based on weighted factors:
       - Signal delta magnitude (40%)
       - Peak deviation (30%)
       - Duration of sustained deviation (20%)
       - Not body movement bonus (10%)
    """

    BASELINE_WINDOW_S = 1.0  # 1 second before question for baseline
    REACTION_WINDOW_S = 3.0  # 3 seconds after question to measure reaction
    BODY_MOVEMENT_THRESHOLD = 0.15  # spike amplitude threshold for body movement
    BODY_MOVEMENT_DECAY_MS = 200  # body movement spikes resolve within 200ms
    MIN_SAMPLES_FOR_ANALYSIS = 20  # need at least 20 samples (200ms at 100Hz)

    def __init__(self) -> None:
        # Rolling signal buffer: (monotonic_timestamp, raw_signal_value)
        self._signal_buffer: deque[tuple[float, float]] = deque(maxlen=1000)  # ~10s at 100Hz
        self._questions: list[QuestionCharge] = []
        self._current_question: QuestionCharge | None = None

    def feed_signal(self, timestamp: float, raw_value: float) -> None:
        """Feed raw signal data from the broadcaster. Call at ~100Hz.

        This is the HOT PATH — O(1) constant time: one deque append +
        one float comparison + one subtraction.
        """
        self._signal_buffer.append((timestamp, raw_value))

        # If we have a pending question, check if reaction window has elapsed
        if self._current_question:
            elapsed_ms = (timestamp - self._current_question.question_time) * 1000
            if elapsed_ms >= self._current_question.reaction_window_ms:
                self._finalize_question()

    def question_dropped(self, question_text: str) -> None:
        """Called when the auditor asks a question. Captures baseline and starts tracking."""
        now = time.monotonic()

        # Finalize previous question if still pending
        if self._current_question:
            self._finalize_question()

        # Compute baseline: average signal over the last 1 second
        baseline_samples = [
            val for ts, val in self._signal_buffer
            if now - ts <= self.BASELINE_WINDOW_S
        ]
        baseline = float(np.mean(baseline_samples)) if baseline_samples else 0.0

        self._current_question = QuestionCharge(
            question_text=question_text,
            question_time=now,
            baseline_signal=baseline,
        )

    def _finalize_question(self) -> None:
        """Analyze the signal reaction to the current question."""
        q = self._current_question
        if q is None:
            return

        # Get signal samples from question_time to question_time + reaction_window
        reaction_end = q.question_time + (q.reaction_window_ms / 1000.0)
        reaction_samples = [
            (ts, val) for ts, val in self._signal_buffer
            if q.question_time <= ts <= reaction_end
        ]

        if len(reaction_samples) < self.MIN_SAMPLES_FOR_ANALYSIS:
            q.charge_score = 0
            self._questions.append(q)
            self._current_question = None
            return

        values = np.array([val for _, val in reaction_samples])
        timestamps = np.array([ts for ts, _ in reaction_samples])

        # Peak deviation from baseline
        deviations = np.abs(values - q.baseline_signal)
        q.peak_deviation = float(np.max(deviations))

        # Net signal delta (mean post-question vs baseline)
        q.signal_delta = float(np.mean(values) - q.baseline_signal)

        # Check for body movement
        q.body_movement = self._is_body_movement(values, timestamps, q.baseline_signal)

        # Compute charge score (0-100)
        q.charge_score = self._compute_charge_score(q, values, timestamps)

        self._questions.append(q)
        self._current_question = None

        log.info(
            "Charge for '%s': score=%d, delta=%.4f, peak=%.4f, body=%s",
            q.question_text[:40], q.charge_score, q.signal_delta,
            q.peak_deviation, q.body_movement,
        )

    def _is_body_movement(
        self, values: np.ndarray, timestamps: np.ndarray, baseline: float
    ) -> bool:
        """Detect body movement: sharp spike that resolves quickly.

        Body movement characteristics:
        1. Sudden large amplitude change (> BODY_MOVEMENT_THRESHOLD)
        2. Resolves back to near-baseline within BODY_MOVEMENT_DECAY_MS
        3. Signal shape is V-shaped (spike then return) rather than sustained

        Real charge characteristics:
        1. Gradual onset (100-500ms to develop)
        2. Sustained deviation (stays away from baseline)
        3. May have smaller amplitude than body movement
        """
        if len(values) < 10:
            return False

        deviations = np.abs(values - baseline)

        # Check if peak is above body movement threshold
        peak_dev = float(np.max(deviations))
        if peak_dev < self.BODY_MOVEMENT_THRESHOLD:
            return False  # not large enough to be body movement

        peak_idx = int(np.argmax(deviations))

        # Check onset speed: how fast did it reach 80% of peak?
        threshold_80 = peak_dev * 0.8
        onset_idx = 0
        for i in range(peak_idx):
            if deviations[i] >= threshold_80:
                onset_idx = i
                break

        if peak_idx > 0 and onset_idx < peak_idx:
            onset_time_ms = (timestamps[peak_idx] - timestamps[onset_idx]) * 1000
        else:
            onset_time_ms = 0

        # Body movement: onset < 50ms (nearly instantaneous)
        # Real charge: onset > 100ms (builds up)
        fast_onset = onset_time_ms < 50

        # Check decay: does signal return to within 30% of baseline within DECAY_MS?
        decay_threshold = peak_dev * 0.3
        decay_resolved = False
        if peak_idx < len(values) - 1:
            post_peak = deviations[peak_idx:]
            post_times = timestamps[peak_idx:]
            for dev, t in zip(post_peak, post_times):
                elapsed_ms = (t - timestamps[peak_idx]) * 1000
                if elapsed_ms > self.BODY_MOVEMENT_DECAY_MS:
                    break
                if dev < decay_threshold:
                    decay_resolved = True
                    break

        # Body movement = fast onset + quick resolution
        # Need BOTH characteristics to classify as body movement
        return fast_onset and decay_resolved

    def _compute_charge_score(
        self, q: QuestionCharge, values: np.ndarray, timestamps: np.ndarray
    ) -> int:
        """Compute 0-100 charge score from signal analysis.

        Factors:
        - Signal delta magnitude (40%): How much the signal moved
        - Peak deviation (30%): The strongest single reaction
        - Sustained deviation (20%): How long signal stayed away from baseline
        - Not body movement bonus (10%): Real charge gets full credit
        """
        if q.body_movement:
            return 0  # Body movement = no real charge

        # Normalize factors to 0-1 range
        # Signal delta: 0.001 = barely detectable, 0.01 = moderate, 0.05+ = strong
        delta_score = min(1.0, abs(q.signal_delta) / 0.03)

        # Peak deviation: similar scale
        peak_score = min(1.0, q.peak_deviation / 0.05)

        # Sustained deviation: fraction of samples that deviate > 20% of peak
        if q.peak_deviation > 0:
            threshold = q.peak_deviation * 0.2
            deviations = np.abs(values - q.baseline_signal)
            sustained_fraction = float(np.mean(deviations > threshold))
        else:
            sustained_fraction = 0.0

        # Weighted composite
        raw_score = (
            delta_score * 0.40
            + peak_score * 0.30
            + sustained_fraction * 0.20
            + 0.10  # not body movement
        )

        return max(0, min(100, int(raw_score * 100)))

    def get_analysis(self) -> dict:
        """Get the latest charge analysis for the AI auditor."""
        if not self._questions:
            return {
                "signalDelta": 0.0,
                "peakReaction": 0.0,
                "chargeScore": 0,
                "bodyMovement": False,
                "lastQuestionCharge": "N/A",
                "questionHistory": [],
            }

        latest = self._questions[-1]

        # Build question charge history (last 10 questions)
        history = []
        for q in self._questions[-10:]:
            history.append({
                "question": q.question_text[:60],
                "chargeScore": q.charge_score,
                "signalDelta": round(q.signal_delta, 4),
                "bodyMovement": q.body_movement,
            })

        return {
            "signalDelta": latest.signal_delta,
            "peakReaction": latest.peak_deviation,
            "chargeScore": latest.charge_score,
            "bodyMovement": latest.body_movement,
            "lastQuestionCharge": f"{latest.charge_score}/100",
            "questionHistory": history,
        }

    def get_charge_map(self) -> list[dict]:
        """Get the full charge map for session review — all questions with scores."""
        return [
            {
                "question": q.question_text,
                "chargeScore": q.charge_score,
                "signalDelta": round(q.signal_delta, 4),
                "peakDeviation": round(q.peak_deviation, 4),
                "bodyMovement": q.body_movement,
                "timestamp": q.question_time,
            }
            for q in self._questions
        ]
