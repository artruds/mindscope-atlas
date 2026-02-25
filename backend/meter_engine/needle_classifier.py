"""FFT-based needle classification from raw GSR signal windows."""

import numpy as np

from .events import NeedleAction

# Constants
WINDOW_SIZE = 200       # samples (2s at 100Hz)
SAMPLE_RATE = 100       # Hz
STUCK_THRESHOLD = 0.0005  # variance threshold for stuck
FALL_THRESHOLD = -0.001   # per-sample slope (= -0.1/s at 100Hz)
RISE_THRESHOLD = 0.001    # per-sample slope (= 0.1/s at 100Hz)


class NeedleClassifier:
    """Classifies needle action from a rolling window of GSR samples."""

    def classify(self, window: np.ndarray) -> tuple[NeedleAction, float]:
        """Classify needle action from a signal window.

        Priority cascade — first match wins:
        1. rock_slam
        2. stuck
        3. floating_needle
        4. theta_bop
        5. stage_four
        6. fall (subclassified by duration)
        7. rise
        8. dirty_needle
        9. default: free_needle
        """
        if len(window) < WINDOW_SIZE:
            return NeedleAction.IDLE, 0.0

        variance = float(np.var(window))
        amplitude = float(np.max(window) - np.min(window))
        freqs, power = self._fft(window)
        slope = float(np.polyfit(np.arange(len(window)), window, 1)[0])
        zero_crossings = self._find_zero_crossings(window)

        # 1. Rock slam — large amplitude oscillation (not monotonic)
        if self._is_rock_slam(amplitude, zero_crossings, freqs, power):
            conf = min(1.0, amplitude / 0.5)
            return NeedleAction.ROCK_SLAM, conf

        # 2. Stuck — near-zero variance
        if variance < STUCK_THRESHOLD:
            conf = 1.0 - (variance / STUCK_THRESHOLD)
            return NeedleAction.STUCK, conf

        # 3. Fall — negative slope (check before oscillatory to avoid false positives)
        if slope < FALL_THRESHOLD:
            action = self._classify_fall(window, slope)
            conf = min(1.0, abs(slope) / 0.01)
            return action, conf

        # 4. Rise — positive slope
        if slope > RISE_THRESHOLD:
            conf = min(1.0, slope / 0.01)
            return NeedleAction.RISE, conf

        # 5. Floating needle — rhythmic 0.15–0.6Hz, dominant band energy
        if self._is_floating_needle(freqs, power, zero_crossings, amplitude):
            return NeedleAction.FLOATING, 0.85

        # 6. Theta bop — 4.5–11Hz periodic with significant amplitude
        if amplitude > 0.03:
            periodicity = self._periodicity(freqs, power, 4.5, 11.0)
            band_power_ratio = self._band_power_ratio(freqs, power, 4.5, 11.0)
            if periodicity > 3.0 and band_power_ratio > 0.2:
                conf = min(1.0, periodicity / 5.0)
                return NeedleAction.THETA_BLINK, conf

        # 7. Stage four — 0.8–1.5Hz periodic with significant amplitude
        if amplitude > 0.05:
            periodicity_s4 = self._periodicity(freqs, power, 0.8, 1.5)
            band_ratio_s4 = self._band_power_ratio(freqs, power, 0.8, 1.5)
            if periodicity_s4 > 3.0 and band_ratio_s4 > 0.2:
                conf = min(1.0, periodicity_s4 / 5.0)
                return NeedleAction.STAGE_FOUR, conf

        # 8. Dirty needle — moderate variance, low periodicity
        if self._is_dirty(variance, freqs, power):
            return NeedleAction.DIRTY_NEEDLE, 0.6

        # 9. Default: free needle
        return NeedleAction.FREE_NEEDLE, 0.5

    def _fft(self, window: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Compute FFT frequencies and power spectrum."""
        n = len(window)
        centered = window - np.mean(window)
        fft_vals = np.fft.rfft(centered)
        power = np.abs(fft_vals) ** 2
        freqs = np.fft.rfftfreq(n, d=1.0 / SAMPLE_RATE)
        return freqs, power

    def _find_zero_crossings(self, window: np.ndarray) -> int:
        """Count zero crossings (around mean)."""
        centered = window - np.mean(window)
        signs = np.sign(centered)
        crossings = np.sum(np.abs(np.diff(signs)) > 0)
        return int(crossings)

    def _band_power_ratio(
        self, freqs: np.ndarray, power: np.ndarray, f_low: float, f_high: float
    ) -> float:
        """Fraction of total power in a frequency band."""
        band_mask = (freqs >= f_low) & (freqs <= f_high)
        total = np.sum(power[1:])
        if total < 1e-10:
            return 0.0
        return float(np.sum(power[band_mask]) / total)

    def _is_floating_needle(
        self,
        freqs: np.ndarray,
        power: np.ndarray,
        zero_crossings: int,
        amplitude: float,
    ) -> bool:
        """Detect floating needle: 0.15–0.6Hz dominant, rhythmic oscillation."""
        if amplitude < 0.05:
            return False

        band_mask = (freqs >= 0.15) & (freqs <= 0.6)
        if not np.any(band_mask):
            return False

        band_power = power[band_mask]
        total_power = np.sum(power[1:])
        if total_power < 1e-10:
            return False

        # Band must contain dominant energy
        band_ratio = np.sum(band_power) / total_power
        if band_ratio < 0.25:
            return False

        # Must have rhythmic crossings (at least ~1 full cycle in 2s at 0.3Hz = ~1.2 crossings)
        if zero_crossings < 2:
            return False

        # Check that band peak is strong vs rest of spectrum
        peak_in_band = float(np.max(band_power))
        mean_outside = float(np.mean(power[1:][~band_mask[1:]])) if np.sum(~band_mask[1:]) > 0 else 0
        if mean_outside > 0 and peak_in_band / mean_outside < 3.0:
            return False

        return True

    def _is_rock_slam(
        self, amplitude: float, zero_crossings: int, freqs: np.ndarray, power: np.ndarray
    ) -> bool:
        """Detect rock slam: large amplitude oscillation (not monotonic fall/rise)."""
        if amplitude <= 0.3:
            return False

        # Must have oscillation — monotonic fall/rise won't have many zero crossings
        if zero_crossings < 6:
            return False

        return True

    def _classify_fall(self, window: np.ndarray, slope: float) -> NeedleAction:
        """Subclassify fall by duration and speed."""
        fall_duration = self._fall_duration(window)

        if fall_duration > 2.0:
            return NeedleAction.LONG_FALL_BLOWDOWN
        if fall_duration > 0.5:
            return NeedleAction.LONG_FALL
        if self._is_speeded(slope):
            return NeedleAction.SPEEDED_FALL
        return NeedleAction.FALL

    def _fall_duration(self, window: np.ndarray) -> float:
        """Estimate fall duration in seconds by finding consecutive negative slope."""
        diff = np.diff(window)
        is_neg = diff < 0
        max_run = 0
        current_run = 0
        for val in is_neg:
            if val:
                current_run += 1
                max_run = max(max_run, current_run)
            else:
                current_run = 0
        return max_run / SAMPLE_RATE

    def _is_speeded(self, slope: float) -> bool:
        """Speeded fall has rapid slope (per-sample)."""
        return slope < -0.005

    def _is_dirty(
        self, variance: float, freqs: np.ndarray, power: np.ndarray
    ) -> bool:
        """Dirty needle: moderate variance, low periodicity."""
        if variance <= 0.01:
            return False
        total = np.sum(power[1:])
        if total < 1e-10:
            return False
        peak = float(np.max(power[1:]))
        periodicity = peak / (total / len(power[1:]))
        return periodicity < 2.0

    def _periodicity(
        self, freqs: np.ndarray, power: np.ndarray, f_low: float, f_high: float
    ) -> float:
        """Compute periodicity score in a frequency band (peak / mean ratio)."""
        band_mask = (freqs >= f_low) & (freqs <= f_high)
        if not np.any(band_mask):
            return 0.0
        band_power = power[band_mask]
        mean_power = np.mean(band_power)
        if mean_power < 1e-10:
            return 0.0
        return float(np.max(band_power) / mean_power)
