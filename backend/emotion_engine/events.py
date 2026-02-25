"""Emotion engine event types for Hume AI integration."""

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class EmotionEvent:
    """A snapshot of emotion readings from Hume AI."""
    timestamp: datetime = field(default_factory=datetime.utcnow)
    session_id: str | None = None
    # Top emotions with scores (0.0 – 1.0)
    emotions: dict[str, float] = field(default_factory=dict)
    # Dominant emotion name
    dominant: str = ""
    # Confidence in dominant classification
    confidence: float = 0.0
    # Raw prosody features
    prosody: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp.isoformat(),
            "sessionId": self.session_id,
            "emotions": self.emotions,
            "dominant": self.dominant,
            "confidence": self.confidence,
            "prosody": self.prosody,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "EmotionEvent":
        return cls(
            timestamp=datetime.fromisoformat(data["timestamp"]),
            session_id=data.get("sessionId"),
            emotions=data.get("emotions", {}),
            dominant=data.get("dominant", ""),
            confidence=data.get("confidence", 0.0),
            prosody=data.get("prosody", {}),
        )
