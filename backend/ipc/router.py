"""Message router — dispatches incoming messages to handler functions."""

from __future__ import annotations

import base64
import logging
from typing import Any, TYPE_CHECKING

from .protocol import Message, MessageType
from ..pc_model.database import DatabaseManager
from ..pc_model.models import PCModel, SessionRecord

if TYPE_CHECKING:
    from ..app import MindScopeServer
    from ..ai.auditor import AIAuditor

log = logging.getLogger("mindscope.router")


class MessageRouter:
    """Routes WebSocket messages to the appropriate handler."""

    def __init__(self, db: DatabaseManager, server: MindScopeServer | None = None, ai_auditor: AIAuditor | None = None):
        self.db = db
        self.server = server
        self.ai_auditor = ai_auditor
        self._starting_session = False
        self._handlers: dict[str, Any] = {
            MessageType.PING.value: self._handle_ping,
            MessageType.PC_CREATE.value: self._handle_pc_create,
            MessageType.PC_GET.value: self._handle_pc_get,
            MessageType.PC_LIST.value: self._handle_pc_list,
            MessageType.PC_UPDATE.value: self._handle_pc_update,
            MessageType.PC_DELETE.value: self._handle_pc_delete,
            MessageType.SESSION_CREATE.value: self._handle_session_create,
            MessageType.SESSION_LIST.value: self._handle_session_list,
            MessageType.DB_STATUS.value: self._handle_db_status,
            # Phase 2: session lifecycle
            MessageType.SESSION_START.value: self._handle_session_start,
            MessageType.SESSION_END.value: self._handle_session_end,
            MessageType.SESSION_PAUSE.value: self._handle_session_pause,
            MessageType.SESSION_RESUME.value: self._handle_session_resume,
            # Phase 2: meter
            MessageType.METER_HISTORY.value: self._handle_meter_history,
            # Phase 2: PC input
            MessageType.PC_INPUT.value: self._handle_pc_input,
            # Audio
            MessageType.AUDIO_INPUT.value: self._handle_audio_input,
            # Session recovery
            MessageType.SESSION_RECOVER.value: self._handle_session_recover,
        }

    async def route(self, msg: Message) -> Message:
        """Route a message to the appropriate handler."""
        handler = self._handlers.get(msg.type)
        if handler is None:
            log.warning("Unknown message type: %s", msg.type)
            return Message.error(f"Unknown message type: {msg.type}", msg.request_id)

        try:
            return await handler(msg)
        except Exception as e:
            log.exception("Error handling %s", msg.type)
            return Message.error(str(e), msg.request_id)

    # --- Helpers ---

    async def _broadcast(self, msg: Message) -> None:
        """Broadcast via server if available."""
        if self.server:
            await self.server.broadcast(msg)

    # --- Phase 1 Handlers ---

    async def _handle_ping(self, msg: Message) -> Message:
        return Message.pong(msg.request_id)

    async def _handle_pc_create(self, msg: Message) -> Message:
        pc = PCModel.from_dict(msg.data)
        pc = await self.db.create_pc(pc)
        return Message(
            type=MessageType.PC_CREATED.value,
            data=pc.to_dict(),
            request_id=msg.request_id,
        )

    async def _handle_pc_get(self, msg: Message) -> Message:
        pc_id = msg.data.get("id", "")
        pc = await self.db.get_pc(pc_id)
        if pc is None:
            return Message.error(f"PC not found: {pc_id}", msg.request_id)
        return Message(
            type=MessageType.PC_DATA.value,
            data=pc.to_dict(),
            request_id=msg.request_id,
        )

    async def _handle_pc_list(self, msg: Message) -> Message:
        pcs = await self.db.list_pcs()
        return Message(
            type=MessageType.PC_LIST_DATA.value,
            data={"profiles": [pc.to_dict() for pc in pcs]},
            request_id=msg.request_id,
        )

    async def _handle_pc_update(self, msg: Message) -> Message:
        pc_id = msg.data.get("id", "")
        pc = await self.db.update_pc(pc_id, msg.data)
        if pc is None:
            return Message.error(f"PC not found: {pc_id}", msg.request_id)
        return Message(
            type=MessageType.PC_UPDATED.value,
            data=pc.to_dict(),
            request_id=msg.request_id,
        )

    async def _handle_pc_delete(self, msg: Message) -> Message:
        pc_id = msg.data.get("id", "")
        deleted = await self.db.delete_pc(pc_id)
        if not deleted:
            return Message.error(f"PC not found: {pc_id}", msg.request_id)
        return Message(
            type=MessageType.PC_DELETED.value,
            data={"id": pc_id},
            request_id=msg.request_id,
        )

    async def _handle_session_create(self, msg: Message) -> Message:
        session = SessionRecord.from_dict(msg.data)
        session = await self.db.create_session(session)
        return Message(
            type=MessageType.SESSION_CREATED.value,
            data=session.to_dict(),
            request_id=msg.request_id,
        )

    async def _handle_session_list(self, msg: Message) -> Message:
        pc_id = msg.data.get("pcId", "")
        sessions = await self.db.list_sessions(pc_id)
        return Message(
            type=MessageType.SESSION_LIST_DATA.value,
            data={"pcId": pc_id, "sessions": [s.to_dict() for s in sessions]},
            request_id=msg.request_id,
        )

    async def _handle_db_status(self, msg: Message) -> Message:
        status = await self.db.get_status()
        status = dict(status)
        status["aiModel"] = (
            self.ai_auditor.model_name
            if self.ai_auditor
            else "unavailable (missing ANTHROPIC_API_KEY)"
        )
        return Message(
            type=MessageType.DB_STATUS_DATA.value,
            data=status,
            request_id=msg.request_id,
        )

    # --- Phase 2: Session Lifecycle Handlers ---

    async def _handle_session_start(self, msg: Message) -> Message:
        """Start an auditing session for a PC."""
        if self.server and self._starting_session:
            return Message.error("Session start already in progress", msg.request_id)

        # Serialise session startup so we can't enter SESSION_START twice if users click repeatedly.
        if self.server:
            self._starting_session = True

        session_id: str | None = None
        sm = None
        try:
            pc_id = msg.data.get("pcId", "")
            if not pc_id:
                return Message.error("pcId is required", msg.request_id)

            pc = await self.db.get_pc(pc_id)
            if pc is None:
                return Message.error(f"PC not found: {pc_id}", msg.request_id)

            if self.server and self.server.active_session:
                # Auto-replace any stale active session without emitting a visible closure message.
                old_sm = self.server.active_session
                log.warning(
                    "Ending stale session %s before starting new one for PC %s",
                    old_sm.session_id, pc_id,
                )
                try:
                    if getattr(old_sm, "db", None) is not None:
                        await old_sm.db.update_session(
                            old_sm.pc_id,
                            old_sm.session_id,
                            {
                                "phase": "complete",
                                "durationSeconds": int(old_sm._elapsed_seconds()),
                            },
                        )
                except Exception:
                    log.exception("Error ending stale session %s", old_sm.session_id)
                self.server.active_session = None
                if self.server.broadcaster:
                    self.server.broadcaster.session_id = None

            # Create session record
            session = SessionRecord(pc_id=pc_id)
            session = await self.db.create_session(session)
            session_id = session.id

            # Create and start session manager
            from ..orchestrator.session_manager import SessionManager, SessionMode
            session_mode = msg.data.get(
                "sessionMode", msg.data.get("session_mode", SessionMode.STRUCTURED)
            )
            if not isinstance(session_mode, str):
                session_mode = str(session_mode or "").strip()
            else:
                session_mode = session_mode.strip()
            normalized_session_mode = session_mode.lower()
            if normalized_session_mode not in (SessionMode.CONVERSATIONAL, SessionMode.STRUCTURED):
                normalized_session_mode = SessionMode.STRUCTURED
            session_mode = normalized_session_mode
            sm = SessionManager(
                pc_id=pc_id,
                session_id=session.id,
                db=self.db,
                broadcast_fn=self._broadcast,
                ai_auditor=self.ai_auditor,
                session_mode=session_mode,
            )
            if self.server:
                self.server.active_session = sm
                # Link session to broadcaster and reset TA motion before first AI call.
                if self.server.broadcaster:
                    self.server.broadcaster.session_id = session.id
                    self.server.broadcaster.ta_tracker.reset_session()
                    # Wire charge tracker from broadcaster to session manager
                    sm.charge_tracker = self.server.broadcaster.charge_tracker

            await sm.start()
            return Message(
                type=MessageType.SESSION_STARTED.value,
                data={
                    "sessionId": session.id,
                    "pcId": pc_id,
                    "pcName": f"{pc.first_name} {pc.last_name}",
                    **sm.get_state(),
                },
                request_id=msg.request_id,
            )
        except Exception as e:
            if self.server and self.server.active_session is sm:
                self.server.active_session = None
            if self.server and self.server.broadcaster:
                self.server.broadcaster.session_id = None
            log.exception("Error starting session %s", session_id or "unknown")
            raise e
        finally:
            if self.server:
                self._starting_session = False

    async def _handle_session_end(self, msg: Message) -> Message:
        """End the active auditing session."""
        if not self.server or not self.server.active_session:
            return Message.error("No active session", msg.request_id)

        sm = self.server.active_session
        await sm.end()
        self.server.active_session = None

        if self.server.broadcaster:
            self.server.broadcaster.session_id = None

        return Message(
            type=MessageType.SESSION_ENDED.value,
            data={"sessionId": sm.session_id},
            request_id=msg.request_id,
        )

    async def _handle_session_pause(self, msg: Message) -> Message:
        """Pause the active session."""
        if not self.server or not self.server.active_session:
            return Message.error("No active session", msg.request_id)

        sm = self.server.active_session
        sm.pause()

        return Message(
            type=MessageType.SESSION_PAUSED.value,
            data=sm.get_state(),
            request_id=msg.request_id,
        )

    async def _handle_session_resume(self, msg: Message) -> Message:
        """Resume the active session."""
        if not self.server or not self.server.active_session:
            return Message.error("No active session", msg.request_id)

        sm = self.server.active_session
        sm.resume()

        return Message(
            type=MessageType.SESSION_RESUMED.value,
            data=sm.get_state(),
            request_id=msg.request_id,
        )

    async def _handle_meter_history(self, msg: Message) -> Message:
        """Return recent meter history."""
        # Placeholder — returns empty for now, will be populated when we store readings
        return Message(
            type=MessageType.METER_HISTORY_DATA.value,
            data={"readings": []},
            request_id=msg.request_id,
        )

    async def _handle_pc_input(self, msg: Message) -> Message:
        """Handle manual PC response input during a session."""
        if not self.server or not self.server.active_session:
            return Message.error("No active session", msg.request_id)

        text = msg.data.get("text", "").strip()
        if not text:
            return Message.error("text is required", msg.request_id)

        # Extract optional TA/sensitivity from frontend
        front_ta = msg.data.get("toneArm")
        front_sensitivity = msg.data.get("sensitivity")

        # Broadcast typing indicator before processing
        await self._broadcast(Message(
            type=MessageType.CHAT_TYPING.value,
            data={"typing": True},
        ))

        sm = self.server.active_session
        meter_event = None
        if self.server.broadcaster:
            from ..meter_engine.events import MeterEvent
            meter_event = MeterEvent(
                needle_action=self.server.broadcaster.current_action,
                position=self.server.broadcaster.current_position,
                tone_arm=front_ta if front_ta is not None else self.server.broadcaster.current_ta,
                sensitivity=front_sensitivity if front_sensitivity is not None else 16.0,
                confidence=self.server.broadcaster.current_confidence,
            )

        result = await sm.process_pc_input(text, meter_event)

        return Message(
            type=MessageType.SESSION_STATE.value,
            data=result,
            request_id=msg.request_id,
        )

    # --- Audio (Whisper STT) ---

    async def _handle_audio_input(self, msg: Message) -> Message:
        """Decode base64 audio, transcribe via Whisper, optionally send as PC input."""
        if not self.server:
            return Message.error("Server not available", msg.request_id)

        whisper = self.server.whisper
        if not whisper.available:
            return Message.error("Whisper STT not configured (no OPENAI_API_KEY)", msg.request_id)

        audio_b64 = msg.data.get("audio", "")
        fmt = msg.data.get("format", "webm")
        auto_send = msg.data.get("autoSend", False)
        if not audio_b64:
            return Message.error("audio (base64) is required", msg.request_id)

        log.info("Audio input: base64 length=%d, format=%s, autoSend=%s", len(audio_b64), fmt, auto_send)

        try:
            audio_bytes = base64.b64decode(audio_b64)
        except Exception:
            log.exception("Failed to decode base64 audio")
            return Message.error("Invalid base64 audio data", msg.request_id)

        log.info("Audio decoded: %d bytes (%.1f KB)", len(audio_bytes), len(audio_bytes) / 1024)

        text = await whisper.transcribe(audio_bytes, fmt)
        log.info("Whisper transcribed (autoSend=%s): '%s'", auto_send, text[:120])

        if auto_send and self.server.active_session:
            # Auto-send mode: delegate directly to PC input, don't broadcast transcription
            pc_msg = Message(
                type=MessageType.PC_INPUT.value,
                data={"text": text, **{k: v for k, v in msg.data.items() if k not in ("audio", "format", "autoSend")}},
                request_id=msg.request_id,
            )
            return await self._handle_pc_input(pc_msg)

        # Transcribe-only mode: broadcast transcription for input box, don't send as PC input
        await self._broadcast(Message(
            type=MessageType.AUDIO_TRANSCRIBED.value,
            data={"text": text, "autoSent": False},
        ))

        return Message(
            type=MessageType.AUDIO_TRANSCRIBED.value,
            data={"text": text, "autoSent": False},
            request_id=msg.request_id,
        )

    # --- Session Recovery ---

    async def _handle_session_recover(self, msg: Message) -> Message:
        """Recover transcript entries and session state for a previous session."""
        session_id = msg.data.get("sessionId", "")
        pc_id = msg.data.get("pcId", "")
        if not session_id or not pc_id:
            return Message.error("sessionId and pcId are required", msg.request_id)

        try:
            case_db = await self.db._open_case_db(pc_id)
            try:
                # Fetch transcript entries
                cursor = await case_db.execute(
                    """SELECT turn_number, speaker, text, needle_action, tone_arm, timestamp
                       FROM transcript_entries
                       WHERE session_id = ?
                       ORDER BY id ASC""",
                    (session_id,),
                )
                rows = await cursor.fetchall()
                messages = [
                    {
                        "turnNumber": row[0],
                        "speaker": row[1],
                        "text": row[2],
                        "needleAction": row[3],
                        "toneArm": row[4],
                        "timestamp": row[5],
                    }
                    for row in rows
                ]

                # Fetch session record for state restoration
                cursor = await case_db.execute(
                    """SELECT phase, duration_seconds, session_number
                       FROM sessions
                       WHERE id = ?""",
                    (session_id,),
                )
                session_row = await cursor.fetchone()
                session_state = None
                if session_row:
                    phase = session_row[0].upper() if session_row[0] else "COMPLETE"
                    session_state = {
                        "phase": phase,
                        "step": "",
                        "r3rState": None,
                        "elapsed": session_row[1] or 0,
                        "isPaused": True,  # recovered sessions start paused
                        "pcId": pc_id,
                        "sessionId": session_id,
                        "currentCommand": "",
                        "turnNumber": len(messages),
                    }
            finally:
                await case_db.close()
        except Exception:
            log.exception("Failed to recover session transcript")
            return Message.error("Failed to recover session", msg.request_id)

        data: dict = {"sessionId": session_id, "messages": messages}
        if session_state:
            data["sessionState"] = session_state

        return Message(
            type=MessageType.SESSION_RECOVERED.value,
            data=data,
            request_id=msg.request_id,
        )
