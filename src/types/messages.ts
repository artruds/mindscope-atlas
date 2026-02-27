/** IPC message types matching Python backend protocol. */

export enum MessageType {
  // Heartbeat
  PING = "ping",
  PONG = "pong",
  // Connection
  INIT = "init",
  ERROR = "error",
  // PC CRUD
  PC_CREATE = "pc.create",
  PC_CREATED = "pc.created",
  PC_GET = "pc.get",
  PC_DATA = "pc.data",
  PC_LIST = "pc.list",
  PC_LIST_DATA = "pc.list.data",
  PC_UPDATE = "pc.update",
  PC_UPDATED = "pc.updated",
  PC_DELETE = "pc.delete",
  PC_DELETED = "pc.deleted",
  // Sessions
  SESSION_CREATE = "session.create",
  SESSION_CREATED = "session.created",
  SESSION_LIST = "session.list",
  SESSION_LIST_DATA = "session.list.data",
  // Session lifecycle (Phase 2)
  SESSION_START = "session.start",
  SESSION_STARTED = "session.started",
  SESSION_END = "session.end",
  SESSION_ENDED = "session.ended",
  SESSION_PAUSE = "session.pause",
  SESSION_PAUSED = "session.paused",
  SESSION_RESUME = "session.resume",
  SESSION_RESUMED = "session.resumed",
  SESSION_STATE = "session.state",
  // Meter
  METER_EVENT = "meter.event",
  METER_HISTORY = "meter.history",
  METER_HISTORY_DATA = "meter.history.data",
  // State & transcript
  STATE_CHANGE = "state.change",
  TRANSCRIPT_UPDATE = "transcript.update",
  // PC input
  PC_INPUT = "pc.input",
  // Chat
  CHAT_MESSAGE = "chat.message",
  CHAT_TYPING = "chat.typing",
  // Audio
  AUDIO_INPUT = "audio.input",
  AUDIO_TRANSCRIBED = "audio.transcribed",
  // Session recovery
  SESSION_RECOVER = "session.recover",
  SESSION_RECOVERED = "session.recovered",
  // Charge
  CHARGE_MAP = "charge.map",
  // Database
  DB_STATUS = "db.status",
  DB_STATUS_DATA = "db.status.data",
}

export interface WSMessage {
  type: string;
  data: Record<string, unknown>;
  requestId?: string;
}

export interface PCProfile {
  id: string;
  firstName: string;
  lastName: string;
  caseStatus: "active" | "on_hold" | "completed" | "archived";
  currentGrade: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionData {
  id: string;
  pcId: string;
  phase: "setup" | "in_session" | "review" | "exam" | "complete";
  sessionNumber: number;
  durationSeconds: number;
  taStart: number;
  taEnd: number;
  taMotion: number;
  indicators: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface DBStatus {
  centralDb: string;
  centralExists: boolean;
  caseFoldersDir: string;
  pcCount: number;
  ready: boolean;
  aiModel?: string;
  error?: string;
}

// --- Phase 2 types ---

export enum NeedleActionType {
  IDLE = "idle",
  FALL = "fall",
  LONG_FALL = "long_fall",
  LONG_FALL_BLOWDOWN = "long_fall_blowdown",
  SPEEDED_FALL = "speeded_fall",
  RISE = "rise",
  THETA_BLINK = "theta_blink",
  ROCK_SLAM = "rock_slam",
  STUCK = "stuck",
  FLOATING = "floating",
  FREE_NEEDLE = "free_needle",
  STAGE_FOUR = "stage_four",
  BODY_MOTION = "body_motion",
  SQUEEZE = "squeeze",
  DIRTY_NEEDLE = "dirty_needle",
  NULL_TA = "null_ta",
  ROCKET_READ = "rocket_read",
  TICK = "tick",
  DOUBLE_TICK = "double_tick",
  STICKY = "sticky",
  NULL = "null",
}

export interface TAMotionData {
  totalDownMotion: number;
  totalUpMotion: number;
  netMotion: number;
  startTA: number;
  currentTA: number;
}

export interface MeterEventData {
  timestamp: string;
  needleAction: NeedleActionType;
  position: number;
  toneArm: number;
  sensitivity: number;
  sessionId: string | null;
  taTrend: "RISING" | "FALLING" | "STABLE";
  isInstantRead: boolean;
  context: string;
  confidence: number;
  hardwareConnected: boolean;
  samplesReceived: number;
  rawSignal: number;
  rawUnfiltered: number;
  classifiedAt: number;
  classifyWindow: number;
  taMotion: TAMotionData;
}

export type R3RState =
  | "LOCATE_INCIDENT"
  | "WHAT_HAPPENED"
  | "MOVE_THROUGH"
  | "DURATION"
  | "BEGINNING"
  | "MOVE_THROUGH_AGAIN"
  | "WHATS_HAPPENING"
  | "ANYTHING_ADDED"
  | "TELL_ME_ABOUT"
  | "ABCD_A_RECALL"
  | "ABCD_B_WHEN"
  | "ABCD_C_WHAT_DID_YOU_DO"
  | "ABCD_D_ANYTHING_ELSE"
  | "ABCD_ERASING_OR_SOLID"
  | "EARLIER_SIMILAR"
  | "CHAIN_EP"
  | "CHECK_NEXT_FLOW"
  | "ITEM_COMPLETE";

export type SessionMode = "structured" | "conversational";

export interface SessionState {
  phase: string;
  step: string;
  r3rState: R3RState | null;
  elapsed: number;
  isPaused: boolean;
  pcId: string;
  sessionId: string;
  currentCommand: string;
  turnNumber: number;
  sessionMode?: SessionMode;
}

export interface TranscriptEntry {
  timestamp: string;
  speaker: "auditor" | "pc";
  text: string;
  needleAction: NeedleActionType | null;
  toneArm: number | null;
  turnNumber: number;
}

export interface ChatMessage {
  speaker: "auditor" | "pc";
  text: string;
  timestamp: string;
  turnNumber: number;
  sessionId?: string | null;
  needleAction?: NeedleActionType;
  toneArm?: number;
  sensitivity?: number;
  isAiGenerated?: boolean;
  questionDroppedAt?: number; // epoch seconds (auditor questions only)
  chargeScore?: number; // 0-100 charge score (conversational mode)
  bodyMovement?: boolean; // whether this was a body movement artifact
}

export interface ChargeMapEntry {
  question: string;
  chargeScore: number;
  signalDelta: number;
  peakDeviation: number;
  bodyMovement: boolean;
  timestamp: number;
}
