"""Meter engine event types for needle classification."""

from dataclasses import dataclass, field
from enum import Enum
from datetime import datetime


class NeedleAction(Enum):
    """21 needle actions from FFT-based classification."""
    IDLE = "idle"
    FALL = "fall"
    LONG_FALL = "long_fall"
    LONG_FALL_BLOWDOWN = "long_fall_blowdown"
    SPEEDED_FALL = "speeded_fall"
    RISE = "rise"
    THETA_BLINK = "theta_blink"
    ROCK_SLAM = "rock_slam"
    STUCK = "stuck"
    FLOATING = "floating"
    FREE_NEEDLE = "free_needle"
    STAGE_FOUR = "stage_four"
    BODY_MOTION = "body_motion"
    SQUEEZE = "squeeze"
    DIRTY_NEEDLE = "dirty_needle"
    NULL_TA = "null_ta"
    ROCKET_READ = "rocket_read"
    TICK = "tick"
    DOUBLE_TICK = "double_tick"
    STICKY = "sticky"
    NULL = "null"


@dataclass
class MeterEvent:
    """A single meter reading event."""
    timestamp: datetime = field(default_factory=datetime.utcnow)
    needle_action: NeedleAction = NeedleAction.IDLE
    position: float = 0.0          # 0.0 – 1.0 scale position
    tone_arm: float = 2.0          # TA value (0.0 – 6.0)
    sensitivity: float = 16.0      # sensitivity setting
    session_id: str | None = None
    ta_trend: str = "STABLE"       # RISING, FALLING, STABLE
    is_instant_read: bool = False
    context: str = ""              # additional context info
    confidence: float = 0.0        # classification confidence 0-1

    def is_floating_needle(self) -> bool:
        """Check if current action is a floating needle."""
        return self.needle_action == NeedleAction.FLOATING

    def is_end_phenomena_candidate(self) -> bool:
        """Check if current action could indicate end phenomena."""
        return self.needle_action in (
            NeedleAction.FLOATING,
            NeedleAction.FREE_NEEDLE,
        )

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp.isoformat(),
            "needleAction": self.needle_action.value,
            "position": self.position,
            "toneArm": self.tone_arm,
            "sensitivity": self.sensitivity,
            "sessionId": self.session_id,
            "taTrend": self.ta_trend,
            "isInstantRead": self.is_instant_read,
            "context": self.context,
            "confidence": self.confidence,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "MeterEvent":
        return cls(
            timestamp=datetime.fromisoformat(data["timestamp"]),
            needle_action=NeedleAction(data["needleAction"]),
            position=data.get("position", 0.0),
            tone_arm=data.get("toneArm", 2.0),
            sensitivity=data.get("sensitivity", 16.0),
            session_id=data.get("sessionId"),
            ta_trend=data.get("taTrend", "STABLE"),
            is_instant_read=data.get("isInstantRead", False),
            context=data.get("context", ""),
            confidence=data.get("confidence", 0.0),
        )
