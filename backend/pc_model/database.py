"""SQLite database manager using aiosqlite.

Two-tier storage:
- Central index: ~/.mindscope/mindscope.db (pc_profiles table)
- Per-PC case: ~/.mindscope/case_folders/{pc_id}/case.db (12 tables)
"""

import os
import aiosqlite
from pathlib import Path
from datetime import datetime

from .models import PCModel, SessionRecord, CaseStatus

MINDSCOPE_DIR = Path.home() / ".mindscope"
CENTRAL_DB = MINDSCOPE_DIR / "mindscope.db"
CASE_FOLDERS = MINDSCOPE_DIR / "case_folders"

# --- Central Index Schema ---

CENTRAL_SCHEMA = """
CREATE TABLE IF NOT EXISTS pc_profiles (
    id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    case_status TEXT NOT NULL DEFAULT 'active',
    current_grade TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

# --- Per-PC Case Schema (12 tables) ---

CASE_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    pc_id TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'setup',
    session_number INTEGER NOT NULL DEFAULT 0,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    ta_start REAL NOT NULL DEFAULT 0.0,
    ta_end REAL NOT NULL DEFAULT 0.0,
    ta_motion REAL NOT NULL DEFAULT 0.0,
    indicators TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transcript_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    turn_number INTEGER NOT NULL DEFAULT 0,
    speaker TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    needle_action TEXT DEFAULT NULL,
    tone_arm REAL DEFAULT NULL,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS meter_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    needle_action TEXT NOT NULL DEFAULT 'idle',
    position REAL NOT NULL DEFAULT 0.0,
    tone_arm REAL NOT NULL DEFAULT 2.0,
    sensitivity REAL NOT NULL DEFAULT 16.0,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_meter_session_ts ON meter_readings(session_id, timestamp);

CREATE TABLE IF NOT EXISTS cognitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    meter_confirmed INTEGER NOT NULL DEFAULT 0,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    item_type TEXT NOT NULL DEFAULT 'general',
    description TEXT NOT NULL DEFAULT '',
    reading_before TEXT DEFAULT NULL,
    reading_after TEXT DEFAULT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS chains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    chain_type TEXT NOT NULL DEFAULT 'basic_incident',
    description TEXT NOT NULL DEFAULT '',
    incidents_count INTEGER NOT NULL DEFAULT 0,
    erasure_reached INTEGER NOT NULL DEFAULT 0,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS cs_programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pc_id TEXT NOT NULL,
    program_text TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cs_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    review_text TEXT NOT NULL DEFAULT '',
    examiner_notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS exam_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    exam_type TEXT NOT NULL DEFAULT '',
    passed INTEGER NOT NULL DEFAULT 0,
    score REAL DEFAULT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS tone_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    tone_level REAL NOT NULL DEFAULT 0.0,
    tone_name TEXT NOT NULL DEFAULT '',
    timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emotion_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    dominant TEXT NOT NULL DEFAULT '',
    confidence REAL NOT NULL DEFAULT 0.0,
    emotions_json TEXT NOT NULL DEFAULT '{}',
    prosody_json TEXT NOT NULL DEFAULT '{}',
    timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS grade_completions (
    id TEXT PRIMARY KEY,
    pc_id TEXT NOT NULL,
    grade TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'in_progress',
    started_at TEXT NOT NULL,
    completed_at TEXT DEFAULT NULL,
    notes TEXT NOT NULL DEFAULT ''
);
"""


class DatabaseManager:
    """Manages central index and per-PC case databases."""

    def __init__(self):
        self._central_db: aiosqlite.Connection | None = None

    async def initialize(self) -> None:
        """Create dirs and initialize central index DB."""
        MINDSCOPE_DIR.mkdir(parents=True, exist_ok=True)
        CASE_FOLDERS.mkdir(parents=True, exist_ok=True)

        self._central_db = await aiosqlite.connect(str(CENTRAL_DB))
        self._central_db.row_factory = aiosqlite.Row
        await self._central_db.execute("PRAGMA journal_mode=WAL")
        await self._central_db.executescript(CENTRAL_SCHEMA)
        await self._central_db.commit()

    async def close(self) -> None:
        """Close central DB connection."""
        if self._central_db:
            await self._central_db.close()
            self._central_db = None

    # --- Central DB helpers ---

    @property
    def central(self) -> aiosqlite.Connection:
        assert self._central_db is not None, "Database not initialized"
        return self._central_db

    async def _open_case_db(self, pc_id: str) -> aiosqlite.Connection:
        """Open (or create) a per-PC case database."""
        folder = CASE_FOLDERS / pc_id
        folder.mkdir(parents=True, exist_ok=True)
        db_path = folder / "case.db"

        db = await aiosqlite.connect(str(db_path))
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA journal_mode=WAL")
        await db.executescript(CASE_SCHEMA)
        await db.commit()
        return db

    # --- PC CRUD ---

    async def create_pc(self, pc: PCModel) -> PCModel:
        """Create a new PC profile in central index and init case DB."""
        now = datetime.utcnow().isoformat()
        pc.created_at = datetime.fromisoformat(now)
        pc.updated_at = datetime.fromisoformat(now)

        await self.central.execute(
            """INSERT INTO pc_profiles (id, first_name, last_name, case_status,
               current_grade, notes, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (pc.id, pc.first_name, pc.last_name, pc.case_status.value,
             pc.current_grade, pc.notes, now, now),
        )
        await self.central.commit()

        # Initialize per-PC case database
        case_db = await self._open_case_db(pc.id)
        await case_db.close()

        return pc

    async def get_pc(self, pc_id: str) -> PCModel | None:
        """Get a PC profile by ID."""
        cursor = await self.central.execute(
            "SELECT * FROM pc_profiles WHERE id = ?", (pc_id,)
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        return PCModel.from_row(dict(row))

    async def list_pcs(self) -> list[PCModel]:
        """List all PC profiles."""
        cursor = await self.central.execute(
            "SELECT * FROM pc_profiles ORDER BY updated_at DESC"
        )
        rows = await cursor.fetchall()
        return [PCModel.from_row(dict(row)) for row in rows]

    async def update_pc(self, pc_id: str, updates: dict) -> PCModel | None:
        """Update PC profile fields. `updates` uses camelCase keys."""
        pc = await self.get_pc(pc_id)
        if pc is None:
            return None

        if "firstName" in updates:
            pc.first_name = updates["firstName"]
        if "lastName" in updates:
            pc.last_name = updates["lastName"]
        if "caseStatus" in updates:
            pc.case_status = CaseStatus(updates["caseStatus"])
        if "currentGrade" in updates:
            pc.current_grade = updates["currentGrade"]
        if "notes" in updates:
            pc.notes = updates["notes"]

        pc.updated_at = datetime.utcnow()

        await self.central.execute(
            """UPDATE pc_profiles SET first_name=?, last_name=?, case_status=?,
               current_grade=?, notes=?, updated_at=? WHERE id=?""",
            (pc.first_name, pc.last_name, pc.case_status.value,
             pc.current_grade, pc.notes, pc.updated_at.isoformat(), pc.id),
        )
        await self.central.commit()
        return pc

    async def delete_pc(self, pc_id: str) -> bool:
        """Delete a PC profile and its case folder."""
        pc = await self.get_pc(pc_id)
        if pc is None:
            return False

        await self.central.execute("DELETE FROM pc_profiles WHERE id = ?", (pc_id,))
        await self.central.commit()

        # Remove case folder
        case_dir = CASE_FOLDERS / pc_id
        if case_dir.exists():
            case_db_path = case_dir / "case.db"
            # Remove WAL/SHM files too
            for suffix in ("", "-wal", "-shm"):
                p = Path(str(case_db_path) + suffix)
                if p.exists():
                    p.unlink()
            if case_dir.exists():
                try:
                    case_dir.rmdir()
                except OSError:
                    pass  # non-empty dir, leave it

        return True

    # --- Session CRUD (per-PC case DB) ---

    async def create_session(self, session: SessionRecord) -> SessionRecord:
        """Create a new session in the PC's case database."""
        now = datetime.utcnow().isoformat()
        session.created_at = datetime.fromisoformat(now)
        session.updated_at = datetime.fromisoformat(now)

        case_db = await self._open_case_db(session.pc_id)
        try:
            # Auto-increment session number
            cursor = await case_db.execute(
                "SELECT COALESCE(MAX(session_number), 0) FROM sessions WHERE pc_id = ?",
                (session.pc_id,),
            )
            row = await cursor.fetchone()
            session.session_number = (row[0] if row else 0) + 1

            await case_db.execute(
                """INSERT INTO sessions (id, pc_id, phase, session_number,
                   duration_seconds, ta_start, ta_end, ta_motion, indicators,
                   notes, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (session.id, session.pc_id, session.phase.value,
                 session.session_number, session.duration_seconds,
                 session.ta_start, session.ta_end, session.ta_motion,
                 session.indicators, session.notes, now, now),
            )
            await case_db.commit()
        finally:
            await case_db.close()

        return session

    async def get_session(self, pc_id: str, session_id: str) -> SessionRecord | None:
        """Get a session by ID from the PC's case database."""
        case_db = await self._open_case_db(pc_id)
        try:
            cursor = await case_db.execute(
                "SELECT * FROM sessions WHERE id = ?", (session_id,)
            )
            row = await cursor.fetchone()
            if row is None:
                return None
            return SessionRecord.from_row(dict(row))
        finally:
            await case_db.close()

    async def list_sessions(self, pc_id: str) -> list[SessionRecord]:
        """List all sessions for a PC."""
        case_db = await self._open_case_db(pc_id)
        try:
            cursor = await case_db.execute(
                "SELECT * FROM sessions WHERE pc_id = ? ORDER BY session_number DESC",
                (pc_id,),
            )
            rows = await cursor.fetchall()
            return [SessionRecord.from_row(dict(row)) for row in rows]
        finally:
            await case_db.close()

    async def update_session(self, pc_id: str, session_id: str, updates: dict) -> SessionRecord | None:
        """Update session fields."""
        session = await self.get_session(pc_id, session_id)
        if session is None:
            return None

        from .models import SessionPhase
        if "phase" in updates:
            session.phase = SessionPhase(updates["phase"])
        if "durationSeconds" in updates:
            session.duration_seconds = updates["durationSeconds"]
        if "taStart" in updates:
            session.ta_start = updates["taStart"]
        if "taEnd" in updates:
            session.ta_end = updates["taEnd"]
        if "taMotion" in updates:
            session.ta_motion = updates["taMotion"]
        if "indicators" in updates:
            session.indicators = updates["indicators"]
        if "notes" in updates:
            session.notes = updates["notes"]

        session.updated_at = datetime.utcnow()

        case_db = await self._open_case_db(pc_id)
        try:
            await case_db.execute(
                """UPDATE sessions SET phase=?, duration_seconds=?, ta_start=?,
                   ta_end=?, ta_motion=?, indicators=?, notes=?, updated_at=?
                   WHERE id=?""",
                (session.phase.value, session.duration_seconds,
                 session.ta_start, session.ta_end, session.ta_motion,
                 session.indicators, session.notes,
                 session.updated_at.isoformat(), session.id),
            )
            await case_db.commit()
        finally:
            await case_db.close()

        return session

    # --- DB Status ---

    async def get_status(self) -> dict:
        """Get database health status."""
        status = {
            "centralDb": str(CENTRAL_DB),
            "centralExists": CENTRAL_DB.exists(),
            "caseFoldersDir": str(CASE_FOLDERS),
        }

        if self._central_db:
            try:
                cursor = await self.central.execute("SELECT COUNT(*) FROM pc_profiles")
                row = await cursor.fetchone()
                status["pcCount"] = row[0] if row else 0
                status["ready"] = True
            except Exception as e:
                status["ready"] = False
                status["error"] = str(e)
        else:
            status["ready"] = False
            status["error"] = "Database not initialized"

        return status
