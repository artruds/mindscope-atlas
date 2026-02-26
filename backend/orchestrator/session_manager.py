"""Session lifecycle manager — rudiments, processing, end rudiments."""

from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Callable, Awaitable, TYPE_CHECKING

from .r3r import R3RStateMachine
from ..ipc.protocol import Message, MessageType
from ..meter_engine.events import MeterEvent, NeedleAction

if TYPE_CHECKING:
    from ..pc_model.database import DatabaseManager
    from ..ai.auditor import AIAuditor

log = logging.getLogger("mindscope.session")


class SessionMode:
    STRUCTURED = "structured"
    CONVERSATIONAL = "conversational"


class SessionPhase:
    SETUP = "SETUP"
    START_RUDIMENTS = "START_RUDIMENTS"
    PROCESSING = "PROCESSING"
    END_RUDIMENTS = "END_RUDIMENTS"
    COMPLETE = "COMPLETE"


# Start rudiments — 4 questions
START_RUDIMENTS = [
    "What are your goals for this session?",
    "Look around the room. Can you have that wall? That ceiling? That floor? Good.",
    "Is there anything you'd like to say to me before we start?",
    "Has anything been suppressed or invalidated since last session?",
]

# End rudiments — 5 questions
END_RUDIMENTS = [
    "Have your goals for this session been met?",
    "Is there anything you'd like to say to me?",
    "Look around the room. Can you have that wall? That ceiling? That floor? Good.",
    "Has anything been suppressed or invalidated this session?",
    "Is it all right with you if we end this session?",
]


class SessionManager:
    """Manages the full lifecycle of an auditing session."""

    def __init__(
        self,
        pc_id: str,
        session_id: str,
        db: DatabaseManager,
        broadcast_fn: Callable[[Message], Awaitable[None]],
        ai_auditor: AIAuditor | None = None,
        session_mode: str = SessionMode.STRUCTURED,
    ) -> None:
        self.pc_id = pc_id
        self.session_id = session_id
        self.db = db
        self.broadcast_fn = broadcast_fn
        self.ai_auditor = ai_auditor
        self.session_mode = session_mode

        self.phase = SessionPhase.SETUP
        self.r3r = R3RStateMachine()
        self.current_command = ""
        self.turn_number = 0
        self.transcript: list[dict] = []

        # Charge tracker (set by router after creation)
        self.charge_tracker = None

        # Timer
        self._start_time = 0.0
        self._pause_start = 0.0
        self._total_paused = 0.0
        self.is_paused = False

        # Rudiment tracking
        self._rudiment_index = 0

    async def start(self) -> None:
        """Begin the session — enter start rudiments."""
        self._start_time = time.monotonic()
        self.phase = SessionPhase.START_RUDIMENTS
        self._rudiment_index = 0
        self.current_command = START_RUDIMENTS[0]

        # Reset AI auditor history for new session
        if self.ai_auditor:
            self.ai_auditor.reset()

        self._add_transcript("auditor", self.current_command)
        await self._persist_entry(self.transcript[-1])
        await self._broadcast_chat("auditor", self.current_command)
        await self._broadcast_state()
        log.info("Session %s started for PC %s", self.session_id, self.pc_id)

    async def end(self) -> None:
        """End the session and persist data."""
        self.phase = SessionPhase.COMPLETE
        elapsed = self._elapsed_seconds()

        # Persist session updates
        await self.db.update_session(self.pc_id, self.session_id, {
            "phase": "complete",
            "durationSeconds": int(elapsed),
        })

        # Transcript entries already persisted individually via _persist_entry

        # Broadcast charge map in conversational mode
        if self.session_mode == SessionMode.CONVERSATIONAL and self.charge_tracker:
            charge_map = self.charge_tracker.get_charge_map()
            if charge_map:
                await self.broadcast_fn(Message(
                    type=MessageType.CHARGE_MAP.value,
                    data={"entries": charge_map, "sessionId": self.session_id},
                ))

        await self._broadcast_state()
        log.info("Session %s ended (%.0fs)", self.session_id, elapsed)

    def pause(self) -> None:
        """Pause the session timer."""
        if not self.is_paused:
            self.is_paused = True
            self._pause_start = time.monotonic()
            log.info("Session %s paused", self.session_id)

    def resume(self) -> None:
        """Resume the session timer."""
        if self.is_paused:
            self._total_paused += time.monotonic() - self._pause_start
            self.is_paused = False
            log.info("Session %s resumed", self.session_id)

    async def process_pc_input(
        self, text: str, meter_event: MeterEvent | None = None
    ) -> dict:
        """Process a PC response and advance the session.

        Returns the updated session state dict.
        """
        self.turn_number += 1
        needle_action = meter_event.needle_action if meter_event else None
        tone_arm = meter_event.tone_arm if meter_event else None
        sensitivity = meter_event.sensitivity if meter_event else None

        # Get charge analysis before advancing (for PC's message display)
        charge_score = None
        body_movement = None
        if self.charge_tracker:
            charge_analysis = self.charge_tracker.get_analysis()
            charge_score = charge_analysis.get("chargeScore", 0)
            body_movement = charge_analysis.get("bodyMovement", False)

        # Record PC's response
        self._add_transcript("pc", text, needle_action, tone_arm)
        await self._persist_entry(self.transcript[-1])

        # Broadcast PC chat message (server echo — frontend waits for this)
        await self._broadcast_chat(
            "pc", text,
            needle_action=needle_action.value if needle_action else None,
            tone_arm=tone_arm,
            sensitivity=sensitivity,
            charge_score=charge_score,
            body_movement=body_movement,
        )

        # Determine next command based on phase
        if self.phase == SessionPhase.START_RUDIMENTS:
            await self._advance_start_rudiments(text, meter_event)
        elif self.phase == SessionPhase.PROCESSING:
            if self.session_mode == SessionMode.CONVERSATIONAL:
                await self._advance_conversational(text, meter_event)
            else:
                await self._advance_processing(text, meter_event)
        elif self.phase == SessionPhase.END_RUDIMENTS:
            await self._advance_end_rudiments(text, meter_event)

        await self._broadcast_state()
        return self.get_state()

    async def _advance_start_rudiments(
        self, text: str, meter: MeterEvent | None
    ) -> None:
        """Advance through start rudiments."""
        self._rudiment_index += 1
        if self._rudiment_index < len(START_RUDIMENTS):
            self.current_command = START_RUDIMENTS[self._rudiment_index]
        else:
            # Transition to processing
            self.phase = SessionPhase.PROCESSING
            self._rudiment_index = 0
            self.current_command = self.r3r.get_command()
            log.info("Session %s entering PROCESSING phase", self.session_id)

        self._add_transcript("auditor", self.current_command)
        await self._persist_entry(self.transcript[-1])
        await self._broadcast_chat("auditor", self.current_command)

    async def _advance_processing(
        self, text: str, meter: MeterEvent | None
    ) -> None:
        """Advance the R3R state machine, optionally using AI for response."""
        fn_detected = False
        if meter and meter.is_floating_needle():
            fn_detected = True

        new_state, command = self.r3r.transition(
            pc_response=text,
            fn_detected=fn_detected,
        )

        # Try AI auditor for natural language response
        is_ai = False
        if self.ai_auditor:
            try:
                meter_data = meter.to_dict() if meter else None
                session_info = self.get_state()
                ai_response = await self.ai_auditor.respond(
                    pc_text=text,
                    r3r_state=new_state.value,
                    r3r_command=command,
                    meter_data=meter_data,
                    session_info=session_info,
                )
                self.current_command = ai_response
                is_ai = True
            except Exception:
                log.exception("AI auditor error, falling back to R3R command")
                self.current_command = command
        else:
            self.current_command = command

        self._add_transcript("auditor", self.current_command)
        await self._persist_entry(self.transcript[-1])
        await self._broadcast_chat("auditor", self.current_command, is_ai_generated=is_ai)

        # Broadcast state change
        await self.broadcast_fn(Message(
            type=MessageType.STATE_CHANGE.value,
            data={"r3rState": new_state.value, "command": command},
        ))

    async def _advance_conversational(
        self, text: str, meter: MeterEvent | None
    ) -> None:
        """Advance in conversational mode — free-form AI chat with charge data."""
        is_ai = False
        charge_data = None
        if self.charge_tracker:
            charge_data = self.charge_tracker.get_analysis()

        if self.ai_auditor:
            try:
                meter_data = meter.to_dict() if meter else None
                session_info = self.get_state()
                ai_response = await self.ai_auditor.respond_conversational(
                    pc_text=text,
                    meter_data=meter_data,
                    session_info=session_info,
                    charge_data=charge_data,
                )
                self.current_command = ai_response
                is_ai = True
            except Exception:
                log.exception("AI auditor conversational error, falling back to default")
                self.current_command = "Thank you. Tell me more about that."
        else:
            self.current_command = "Thank you. Tell me more about that."

        self._add_transcript("auditor", self.current_command)
        await self._persist_entry(self.transcript[-1])
        await self._broadcast_chat("auditor", self.current_command, is_ai_generated=is_ai)

    async def _advance_end_rudiments(
        self, text: str, meter: MeterEvent | None
    ) -> None:
        """Advance through end rudiments."""
        self._rudiment_index += 1
        if self._rudiment_index < len(END_RUDIMENTS):
            self.current_command = END_RUDIMENTS[self._rudiment_index]
        else:
            self.current_command = "That is the end of this session. Thank you."
            self.phase = SessionPhase.COMPLETE

        self._add_transcript("auditor", self.current_command)
        await self._persist_entry(self.transcript[-1])
        await self._broadcast_chat("auditor", self.current_command)

    def start_end_rudiments(self) -> None:
        """Transition from processing to end rudiments."""
        self.phase = SessionPhase.END_RUDIMENTS
        self._rudiment_index = 0
        self.current_command = END_RUDIMENTS[0]
        self._add_transcript("auditor", self.current_command)

    def get_state(self) -> dict:
        """Get current session state as a dict for broadcasting."""
        return {
            "phase": self.phase,
            "step": self.current_command,
            "r3rState": self.r3r.state.value if self.phase == SessionPhase.PROCESSING and self.session_mode == SessionMode.STRUCTURED else None,
            "elapsed": self._elapsed_seconds(),
            "isPaused": self.is_paused,
            "pcId": self.pc_id,
            "sessionId": self.session_id,
            "currentCommand": self.current_command,
            "turnNumber": self.turn_number,
            "sessionMode": self.session_mode,
        }

    def _elapsed_seconds(self) -> float:
        """Get elapsed session time, excluding paused periods."""
        if self._start_time == 0:
            return 0.0
        now = time.monotonic()
        paused = self._total_paused
        if self.is_paused:
            paused += now - self._pause_start
        return now - self._start_time - paused

    def _add_transcript(
        self,
        speaker: str,
        text: str,
        needle_action: NeedleAction | None = None,
        tone_arm: float | None = None,
    ) -> None:
        """Add an entry to the in-memory transcript."""
        entry = {
            "timestamp": datetime.utcnow().isoformat(),
            "speaker": speaker,
            "text": text,
            "needleAction": needle_action.value if needle_action else None,
            "toneArm": tone_arm,
            "turnNumber": self.turn_number,
        }
        self.transcript.append(entry)

    async def _persist_entry(self, entry: dict) -> None:
        """Persist a single transcript entry immediately."""
        try:
            case_db = await self.db._open_case_db(self.pc_id)
            try:
                await case_db.execute(
                    """INSERT OR IGNORE INTO transcript_entries
                       (session_id, turn_number, speaker, text, needle_action, tone_arm, timestamp)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (self.session_id, entry["turnNumber"], entry["speaker"],
                     entry["text"], entry["needleAction"], entry["toneArm"],
                     entry["timestamp"]),
                )
                await case_db.commit()
            finally:
                await case_db.close()
        except Exception:
            log.exception("Failed to persist transcript entry")

    async def _broadcast_chat(
        self,
        speaker: str,
        text: str,
        needle_action: str | None = None,
        tone_arm: float | None = None,
        sensitivity: float | None = None,
        is_ai_generated: bool = False,
        charge_score: int | None = None,
        body_movement: bool | None = None,
    ) -> None:
        """Broadcast a CHAT_MESSAGE to all clients."""
        data: dict = {
            "speaker": speaker,
            "text": text,
            "timestamp": datetime.utcnow().isoformat(),
            "turnNumber": self.turn_number,
            "needleAction": needle_action,
            "toneArm": tone_arm,
            "sensitivity": sensitivity,
            "isAiGenerated": is_ai_generated,
        }
        # Include charge data if present
        if charge_score is not None:
            data["chargeScore"] = charge_score
        if body_movement is not None:
            data["bodyMovement"] = body_movement
        # Mark auditor questions with epoch timestamp for signal chart markers
        if speaker == "auditor":
            data["questionDroppedAt"] = time.time()
            # Notify charge tracker about the question being dropped
            if self.charge_tracker:
                self.charge_tracker.question_dropped(text)
        await self.broadcast_fn(Message(
            type=MessageType.CHAT_MESSAGE.value,
            data=data,
        ))

    async def _broadcast_state(self) -> None:
        """Broadcast current session state to all clients."""
        state = self.get_state()
        await self.broadcast_fn(Message(
            type=MessageType.SESSION_STATE.value,
            data=state,
        ))

        # Also broadcast latest transcript entry
        if self.transcript:
            await self.broadcast_fn(Message(
                type=MessageType.TRANSCRIPT_UPDATE.value,
                data={"entry": self.transcript[-1]},
            ))

    async def _persist_transcript(self) -> None:
        """Save transcript entries to the per-PC case database."""
        try:
            case_db = await self.db._open_case_db(self.pc_id)
            try:
                for entry in self.transcript:
                    await case_db.execute(
                        """INSERT INTO transcript_entries
                           (session_id, turn_number, speaker, text, needle_action, tone_arm, timestamp)
                           VALUES (?, ?, ?, ?, ?, ?, ?)""",
                        (
                            self.session_id,
                            entry["turnNumber"],
                            entry["speaker"],
                            entry["text"],
                            entry["needleAction"],
                            entry["toneArm"],
                            entry["timestamp"],
                        ),
                    )
                await case_db.commit()
            finally:
                await case_db.close()
            log.info("Persisted %d transcript entries", len(self.transcript))
        except Exception:
            log.exception("Failed to persist transcript")
