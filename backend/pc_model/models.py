"""PC (preclear) data models."""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
import uuid


class SessionPhase(Enum):
    """Session lifecycle phases."""
    SETUP = "setup"
    IN_SESSION = "in_session"
    REVIEW = "review"
    EXAM = "exam"
    COMPLETE = "complete"


class CaseStatus(Enum):
    """Overall case status for a PC."""
    ACTIVE = "active"
    ON_HOLD = "on_hold"
    COMPLETED = "completed"
    ARCHIVED = "archived"


@dataclass
class PCModel:
    """A preclear profile."""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    first_name: str = ""
    last_name: str = ""
    case_status: CaseStatus = CaseStatus.ACTIVE
    current_grade: str = ""
    notes: str = ""
    created_at: datetime = field(default_factory=datetime.utcnow)
    updated_at: datetime = field(default_factory=datetime.utcnow)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "firstName": self.first_name,
            "lastName": self.last_name,
            "caseStatus": self.case_status.value,
            "currentGrade": self.current_grade,
            "notes": self.notes,
            "createdAt": self.created_at.isoformat(),
            "updatedAt": self.updated_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "PCModel":
        return cls(
            id=data.get("id", str(uuid.uuid4())),
            first_name=data.get("firstName", ""),
            last_name=data.get("lastName", ""),
            case_status=CaseStatus(data.get("caseStatus", "active")),
            current_grade=data.get("currentGrade", ""),
            notes=data.get("notes", ""),
            created_at=datetime.fromisoformat(data["createdAt"]) if "createdAt" in data else datetime.utcnow(),
            updated_at=datetime.fromisoformat(data["updatedAt"]) if "updatedAt" in data else datetime.utcnow(),
        )

    @classmethod
    def from_row(cls, row: dict) -> "PCModel":
        """Create from SQLite row dict."""
        return cls(
            id=row["id"],
            first_name=row["first_name"],
            last_name=row["last_name"],
            case_status=CaseStatus(row["case_status"]),
            current_grade=row["current_grade"],
            notes=row["notes"],
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )


@dataclass
class SessionRecord:
    """A session record for a PC."""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    pc_id: str = ""
    phase: SessionPhase = SessionPhase.SETUP
    session_number: int = 0
    duration_seconds: int = 0
    ta_start: float = 0.0
    ta_end: float = 0.0
    ta_motion: float = 0.0
    indicators: str = ""
    notes: str = ""
    created_at: datetime = field(default_factory=datetime.utcnow)
    updated_at: datetime = field(default_factory=datetime.utcnow)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "pcId": self.pc_id,
            "phase": self.phase.value,
            "sessionNumber": self.session_number,
            "durationSeconds": self.duration_seconds,
            "taStart": self.ta_start,
            "taEnd": self.ta_end,
            "taMotion": self.ta_motion,
            "indicators": self.indicators,
            "notes": self.notes,
            "createdAt": self.created_at.isoformat(),
            "updatedAt": self.updated_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "SessionRecord":
        return cls(
            id=data.get("id", str(uuid.uuid4())),
            pc_id=data.get("pcId", ""),
            phase=SessionPhase(data.get("phase", "setup")),
            session_number=data.get("sessionNumber", 0),
            duration_seconds=data.get("durationSeconds", 0),
            ta_start=data.get("taStart", 0.0),
            ta_end=data.get("taEnd", 0.0),
            ta_motion=data.get("taMotion", 0.0),
            indicators=data.get("indicators", ""),
            notes=data.get("notes", ""),
            created_at=datetime.fromisoformat(data["createdAt"]) if "createdAt" in data else datetime.utcnow(),
            updated_at=datetime.fromisoformat(data["updatedAt"]) if "updatedAt" in data else datetime.utcnow(),
        )

    @classmethod
    def from_row(cls, row: dict) -> "SessionRecord":
        """Create from SQLite row dict."""
        return cls(
            id=row["id"],
            pc_id=row["pc_id"],
            phase=SessionPhase(row["phase"]),
            session_number=row["session_number"],
            duration_seconds=row["duration_seconds"],
            ta_start=row["ta_start"],
            ta_end=row["ta_end"],
            ta_motion=row["ta_motion"],
            indicators=row["indicators"],
            notes=row["notes"],
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )


@dataclass
class GradeCompletion:
    """Tracks grade progress for a PC."""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    pc_id: str = ""
    grade: str = ""
    status: str = "in_progress"  # in_progress, completed
    started_at: datetime = field(default_factory=datetime.utcnow)
    completed_at: datetime | None = None
    notes: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "pcId": self.pc_id,
            "grade": self.grade,
            "status": self.status,
            "startedAt": self.started_at.isoformat(),
            "completedAt": self.completed_at.isoformat() if self.completed_at else None,
            "notes": self.notes,
        }
