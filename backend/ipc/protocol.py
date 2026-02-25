"""WebSocket IPC message protocol."""

import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class MessageType(Enum):
    """All IPC message types."""
    # Heartbeat
    PING = "ping"
    PONG = "pong"
    # Connection
    INIT = "init"
    ERROR = "error"
    # PC CRUD
    PC_CREATE = "pc.create"
    PC_CREATED = "pc.created"
    PC_GET = "pc.get"
    PC_DATA = "pc.data"
    PC_LIST = "pc.list"
    PC_LIST_DATA = "pc.list.data"
    PC_UPDATE = "pc.update"
    PC_UPDATED = "pc.updated"
    PC_DELETE = "pc.delete"
    PC_DELETED = "pc.deleted"
    # Sessions
    SESSION_CREATE = "session.create"
    SESSION_CREATED = "session.created"
    SESSION_LIST = "session.list"
    SESSION_LIST_DATA = "session.list.data"
    # Session lifecycle (Phase 2)
    SESSION_START = "session.start"
    SESSION_STARTED = "session.started"
    SESSION_END = "session.end"
    SESSION_ENDED = "session.ended"
    SESSION_PAUSE = "session.pause"
    SESSION_PAUSED = "session.paused"
    SESSION_RESUME = "session.resume"
    SESSION_RESUMED = "session.resumed"
    SESSION_STATE = "session.state"
    # Meter
    METER_EVENT = "meter.event"
    METER_HISTORY = "meter.history"
    METER_HISTORY_DATA = "meter.history.data"
    # State & transcript
    STATE_CHANGE = "state.change"
    TRANSCRIPT_UPDATE = "transcript.update"
    # PC input (manual)
    PC_INPUT = "pc.input"
    # Chat
    CHAT_MESSAGE = "chat.message"
    CHAT_TYPING = "chat.typing"
    # Audio
    AUDIO_INPUT = "audio.input"
    AUDIO_TRANSCRIBED = "audio.transcribed"
    # Session recovery
    SESSION_RECOVER = "session.recover"
    SESSION_RECOVERED = "session.recovered"
    # Database
    DB_STATUS = "db.status"
    DB_STATUS_DATA = "db.status.data"


@dataclass
class Message:
    """A WebSocket IPC message."""
    type: str
    data: dict[str, Any] = field(default_factory=dict)
    request_id: str | None = None

    def to_json(self) -> str:
        payload: dict[str, Any] = {"type": self.type, "data": self.data}
        if self.request_id:
            payload["requestId"] = self.request_id
        return json.dumps(payload)

    @classmethod
    def from_json(cls, raw: str) -> "Message":
        payload = json.loads(raw)
        return cls(
            type=payload.get("type", ""),
            data=payload.get("data", {}),
            request_id=payload.get("requestId"),
        )

    @classmethod
    def error(cls, message: str, request_id: str | None = None) -> "Message":
        return cls(
            type=MessageType.ERROR.value,
            data={"message": message},
            request_id=request_id,
        )

    @classmethod
    def pong(cls, request_id: str | None = None) -> "Message":
        return cls(type=MessageType.PONG.value, request_id=request_id)

    @classmethod
    def init(cls, version: str, db_status: dict) -> "Message":
        return cls(
            type=MessageType.INIT.value,
            data={"version": version, "dbStatus": db_status},
        )
