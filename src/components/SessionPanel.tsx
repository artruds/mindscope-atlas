import { useCallback, useEffect, useRef, useState } from "react";
import { MessageType } from "../types/messages";
import type {
  WSMessage,
  PCProfile,
  SessionState,
  ChatMessage,
  ChargeMapEntry,
  SessionMode,
} from "../types/messages";
import MicButton from "./MicButton";
import ChatBubble from "./ChatBubble";
import { formatTime } from "../utils";

interface SessionPanelProps {
  connected: boolean;
  send: (type: string, data?: Record<string, unknown>) => string | undefined;
  subscribe: (type: string, handler: (msg: WSMessage) => void) => () => void;
  profiles: PCProfile[];
  selectedPcId: string;
  onSelectPc: (id: string) => void;
  sessionMode: SessionMode;
  onSessionModeChange: (mode: SessionMode) => void;
  sensitivity: number;
  toneArm: number;
  audioDeviceId?: string;
}

const LAST_SESSION_MAP_KEY = "mindscope_lastSessionByPc";

interface SessionSnapshot {
  sessionId: string;
  pcId: string;
  messages: ChatMessage[];
  sessionState?: SessionState;
}

const PHASE_COLORS: Record<string, string> = {
  SETUP: "bg-gray-600",
  START_RUDIMENTS: "bg-blue-600",
  PROCESSING: "bg-emerald-600",
  END_RUDIMENTS: "bg-amber-600",
  COMPLETE: "bg-gray-500",
};
const START_SESSION_TIMEOUT_MS = 30000;

export default function SessionPanel({
  connected,
  send,
  subscribe,
  profiles,
  selectedPcId,
  onSelectPc,
  sessionMode,
  onSessionModeChange,
  sensitivity,
  toneArm,
  audioDeviceId,
}: SessionPanelProps) {
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStarting, setIsStarting] = useState(false);
  const [isAiTyping, setIsAiTyping] = useState(false);
  const [pcInput, setPcInput] = useState("");
  const [autoRecord, setAutoRecord] = useState(false);
  const [isAutoRecording, setIsAutoRecording] = useState(false);
  const [autoSend, setAutoSend] = useState(false);
  const [chargeMap, setChargeMap] = useState<ChargeMapEntry[]>([]);
  const [showChargeMap, setShowChargeMap] = useState(false);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const autoSendTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const autoRecorderRef = useRef<MediaRecorder | null>(null);
  const autoStreamRef = useRef<MediaStream | null>(null);
  const autoChunksRef = useRef<Blob[]>([]);
  const sessionStateRef = useRef(sessionState);
  sessionStateRef.current = sessionState;
  const activeSessionIdRef = useRef<string | null>(null);
  const isStartingSessionRef = useRef(false);
  const startupTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const startupChatBufferRef = useRef<ChatMessage[]>([]);
  const autoRecordRef = useRef(autoRecord);
  autoRecordRef.current = autoRecord;

  const addChatMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => {
      if (prev.some((m) => m.turnNumber === msg.turnNumber
          && m.speaker === msg.speaker
          && m.text === msg.text
          && (m.sessionId ?? null) === (msg.sessionId ?? null))) {
        return prev;
      }
      return [...prev, msg];
    });
  }, []);

  const flushStartupChatBuffer = useCallback((sessionId: string | null) => {
    if (!sessionId) return;
    const queued = startupChatBufferRef.current.filter((msg) => (msg.sessionId ?? null) === sessionId);
    if (queued.length === 0) return;
    startupChatBufferRef.current = [];
    setMessages((prev) => {
      const merged = [...prev];
      queued.forEach((msg) => {
        if (merged.some((m) => m.turnNumber === msg.turnNumber
          && m.speaker === msg.speaker
          && m.text === msg.text
          && (m.sessionId ?? null) === (msg.sessionId ?? null))) {
          return;
        }
        merged.push(msg);
      });
      return merged;
    });
  }, []);

  const restoreKey = `mindscope_sessionSnapshot_${selectedPcId || "default"}`;

  const getSessionMap = useCallback((): Record<string, string> => {
    try {
      const raw = localStorage.getItem(LAST_SESSION_MAP_KEY);
      if (!raw) return {};
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {};
    }
  }, []);

  const setSessionMapValue = useCallback((pcId: string, sessionId: string) => {
    const map = getSessionMap();
    map[pcId] = sessionId;
    localStorage.setItem(LAST_SESSION_MAP_KEY, JSON.stringify(map));
    localStorage.setItem("mindscope_lastSessionId", sessionId);
    localStorage.setItem("mindscope_lastPcId", pcId);
  }, [getSessionMap]);

  const saveSnapshot = useCallback(() => {
    if (!selectedPcId || !sessionState?.sessionId) return;
    const snapshot: SessionSnapshot = {
      sessionId: sessionState.sessionId,
      pcId: selectedPcId,
      messages,
      sessionState,
    };
    localStorage.setItem(restoreKey, JSON.stringify(snapshot));
  }, [messages, restoreKey, selectedPcId, sessionState]);

  const startAutoRecording = useCallback(async () => {
    if (autoRecorderRef.current) return; // already recording
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioDeviceId ? ({ deviceId: { exact: audioDeviceId } } as MediaTrackConstraints) : true,
      });
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      autoChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) autoChunksRef.current.push(e.data);
      };
      recorder.start(250);
      autoRecorderRef.current = recorder;
      autoStreamRef.current = stream;
      setIsAutoRecording(true);
    } catch (err) {
      console.error("[AutoRecord] Failed to start:", err);
    }
  }, [audioDeviceId]);

  const stopAutoRecording = useCallback(async (): Promise<string | null> => {
    const recorder = autoRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      setIsAutoRecording(false);
      return null;
    }
    return new Promise((resolve) => {
      recorder.onstop = async () => {
        autoStreamRef.current?.getTracks().forEach((t) => t.stop());
        autoStreamRef.current = null;
        autoRecorderRef.current = null;
        setIsAutoRecording(false);
        const blob = new Blob(autoChunksRef.current, { type: "audio/webm" });
        if (blob.size < 100) { resolve(null); return; }
        console.log("[AutoRecord] Audio blob size:", blob.size, "bytes");

        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(",")[1];
          send(MessageType.AUDIO_INPUT, {
            audio: base64,
            format: "webm",
            autoSend: false,
          });
          resolve("sent");
        };
        reader.readAsDataURL(blob);
      };
      recorder.stop();
    });
  }, [send]);

  // Cleanup auto-record when toggled off or session ends
  useEffect(() => {
    if (!autoRecord || !sessionState) {
      if (autoRecorderRef.current) {
        autoRecorderRef.current.stop();
        autoStreamRef.current?.getTracks().forEach((t) => t.stop());
        autoStreamRef.current = null;
        autoRecorderRef.current = null;
        setIsAutoRecording(false);
      }
    }
  }, [autoRecord, sessionState]);

  // Subscribe to session, chat, and typing updates
  useEffect(() => {
    const unsubs = [
      subscribe(MessageType.SESSION_STATE, (msg) => {
        const state = msg.data as unknown as SessionState;
        if (activeSessionIdRef.current && state.sessionId !== activeSessionIdRef.current) {
          return;
        }
        if (state.sessionId) {
          activeSessionIdRef.current = state.sessionId;
        }
        setSessionState(state);
      }),
      subscribe(MessageType.SESSION_STARTED, (msg) => {
        const state = msg.data as unknown as SessionState;
        if (
          activeSessionIdRef.current &&
          state.sessionId &&
          state.sessionId !== activeSessionIdRef.current
        ) {
          return;
        }
        setIsStarting(false);
        isStartingSessionRef.current = false;
        if (startupTimeoutRef.current) {
          clearTimeout(startupTimeoutRef.current);
          startupTimeoutRef.current = undefined;
        }
        setIsAiTyping(false);
        if (state.sessionMode) {
          onSessionModeChange(state.sessionMode);
        }
        if (state.sessionId) {
          activeSessionIdRef.current = state.sessionId;
          flushStartupChatBuffer(state.sessionId);
        }
        setSessionState(state);
        if (state.pcId) {
          setSessionMapValue(state.pcId, state.sessionId);
        }
        // Save to localStorage for recovery
        localStorage.setItem("mindscope_lastSessionId", state.sessionId);
        localStorage.setItem("mindscope_lastPcId", state.pcId);
        // Don't clear messages here — they were pre-cleared in handleStart
      }),
      subscribe(MessageType.SESSION_ENDED, () => {
        setIsStarting(false);
        isStartingSessionRef.current = false;
        startupChatBufferRef.current = [];
        if (startupTimeoutRef.current) {
          clearTimeout(startupTimeoutRef.current);
          startupTimeoutRef.current = undefined;
        }
        activeSessionIdRef.current = null;
        if (typingTimeoutRef.current) {
          clearTimeout(typingTimeoutRef.current);
          typingTimeoutRef.current = undefined;
        }
        setSessionState(null);
        setIsAiTyping(false);
        setChargeMap([]);
        localStorage.removeItem("mindscope_lastSessionId");
        localStorage.removeItem("mindscope_lastPcId");
      }),
      subscribe(MessageType.SESSION_PAUSED, (msg) => {
        const state = msg.data as unknown as SessionState;
        if (state.sessionId && state.sessionId !== activeSessionIdRef.current) {
          return;
        }
        setSessionState(state);
      }),
      subscribe(MessageType.SESSION_RESUMED, (msg) => {
        const state = msg.data as unknown as SessionState;
        if (state.sessionId && state.sessionId !== activeSessionIdRef.current) {
          return;
        }
        setSessionState(state);
      }),
      subscribe(MessageType.CHAT_MESSAGE, (msg) => {
        const chatMsg = msg.data as unknown as ChatMessage;
        if (!chatMsg) {
          return;
        }
        const chatSessionId = chatMsg.sessionId ?? null;

        if (chatSessionId) {
          if (activeSessionIdRef.current && chatSessionId !== activeSessionIdRef.current) {
            return;
          }
          if (!activeSessionIdRef.current) {
            if (isStartingSessionRef.current) {
              startupChatBufferRef.current = [...startupChatBufferRef.current, chatMsg];
              return;
            }
            activeSessionIdRef.current = chatSessionId;
          }
        } else if (!isStartingSessionRef.current && !activeSessionIdRef.current) {
          return;
        }

        if (chatMsg) {
          if (typingTimeoutRef.current) {
            clearTimeout(typingTimeoutRef.current);
            typingTimeoutRef.current = undefined;
          }
          addChatMessage(chatMsg);
          setIsAiTyping(false);

          // Auto-record: start recording when auditor speaks during PROCESSING
          if (
            chatMsg.speaker === "auditor" &&
            autoRecordRef.current &&
            sessionStateRef.current?.phase === "PROCESSING"
          ) {
            startAutoRecording();
          }
        }
      }),
      subscribe(MessageType.CHAT_TYPING, () => {
        if (!activeSessionIdRef.current && !isStartingSessionRef.current) {
          return;
        }
        setIsAiTyping(true);
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => {
          setIsAiTyping(false);
        }, 12000);
      }),
      subscribe(MessageType.AUDIO_TRANSCRIBED, (msg) => {
        // Only fill input box for transcribe-only mode (autoSent === false)
        if (msg.data.autoSent === false) {
          const text = msg.data.text as string;
          if (text) setPcInput(text);
        }
      }),
      subscribe(MessageType.ERROR, (msg) => {
        setIsStarting(false);
        isStartingSessionRef.current = false;
        startupChatBufferRef.current = [];
        if (startupTimeoutRef.current) {
          clearTimeout(startupTimeoutRef.current);
          startupTimeoutRef.current = undefined;
        }
        const errorMessage = (msg?.data as { message?: string } | undefined)?.message;
        if (errorMessage && errorMessage.trim()) {
          addChatMessage({
            speaker: "auditor",
            text: `Error: ${errorMessage}`,
            timestamp: new Date().toISOString(),
            turnNumber: sessionStateRef.current?.turnNumber
              ? sessionStateRef.current.turnNumber + 1
              : 0,
            isAiGenerated: false,
          });
          setIsAiTyping(false);
        }
      }),
      subscribe(MessageType.CHARGE_MAP, (msg) => {
        const entries = (msg.data.entries as unknown as ChargeMapEntry[]) ?? [];
        setChargeMap(entries);
      }),
      subscribe(MessageType.SESSION_RECOVERED, (msg) => {
        const recovered = (msg.data.messages as unknown as ChatMessage[]) ?? [];
        if (recovered.length > 0) {
          setMessages(recovered);
        }
        const recoveredState = msg.data.sessionState as unknown as SessionState | undefined;
        if (recoveredState) {
          activeSessionIdRef.current = recoveredState.sessionId;
          setSessionState(recoveredState);
          if (recoveredState.pcId) {
            setSessionMapValue(recoveredState.pcId, recoveredState.sessionId);
          }
        } else {
          setSessionState(null);
        }
      }),
    ];
    return () => {
      unsubs.forEach((u) => u());
        if (typingTimeoutRef.current) {
          clearTimeout(typingTimeoutRef.current);
          typingTimeoutRef.current = undefined;
        }
        if (startupTimeoutRef.current) {
        clearTimeout(startupTimeoutRef.current);
        startupTimeoutRef.current = undefined;
      }
    };
  }, [
    addChatMessage,
    flushStartupChatBuffer,
    onSessionModeChange,
    setSessionMapValue,
    startAutoRecording,
    subscribe,
  ]);

  // Attempt session recovery on mount
  useEffect(() => {
    if (!connected || !selectedPcId) return;

    const sessionMap = getSessionMap();
    const sessionId = sessionMap[selectedPcId]
      || (localStorage.getItem("mindscope_lastPcId") === selectedPcId
        ? localStorage.getItem("mindscope_lastSessionId")
        : null);

    if (sessionId) {
      send(MessageType.SESSION_RECOVER, { sessionId, pcId: selectedPcId });
      return;
    }

    const snapshotRaw = localStorage.getItem(restoreKey);
    if (!snapshotRaw) return;
    try {
      const snapshot = JSON.parse(snapshotRaw) as SessionSnapshot;
      if (snapshot?.pcId === selectedPcId) {
        const recovered = snapshot.messages ?? [];
        if (recovered.length > 0) {
          setMessages(recovered);
        }
      }
    } catch {
      localStorage.removeItem(restoreKey);
    }
  }, [connected, getSessionMap, restoreKey, selectedPcId, send]);

  // Persist latest transcript/session state so conversations survive app restarts
  useEffect(() => {
    saveSnapshot();
  }, [saveSnapshot]);

  useEffect(() => {
    setMessages([]);
    setSessionState(null);
    setChargeMap([]);
    activeSessionIdRef.current = null;
  }, [selectedPcId]);

  // Auto-scroll messages
  useEffect(() => {
    const container = messagesScrollRef.current;
    if (!container) return;

    // Keep scrolling constrained to the chat panel, not the whole page.
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const nearBottom = distanceFromBottom < 140;
    if (!nearBottom && messages.length > 0) return;

    container.scrollTo({
      top: container.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, isAiTyping]);

  const isActive = sessionState !== null && sessionState.phase !== "COMPLETE";

  const handleStart = useCallback(() => {
    if (!selectedPcId) return;
    if (isStarting || isActive || isStartingSessionRef.current) return;
    setIsStarting(true);
    setIsAiTyping(true);
    isStartingSessionRef.current = true;
    activeSessionIdRef.current = null;
    startupChatBufferRef.current = [];
    setMessages([]);       // clear BEFORE sending
    setChargeMap([]);
    setShowChargeMap(false);
    setPcInput("");
    if (autoSendTimerRef.current) {
      clearTimeout(autoSendTimerRef.current);
      autoSendTimerRef.current = undefined;
    }
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = undefined;
    }
    if (startupTimeoutRef.current) {
      clearTimeout(startupTimeoutRef.current);
      startupTimeoutRef.current = undefined;
    }
    startupTimeoutRef.current = setTimeout(() => {
      if (!isStartingSessionRef.current) return;
      setIsStarting(false);
      isStartingSessionRef.current = false;
      setIsAiTyping(false);
    }, START_SESSION_TIMEOUT_MS);
    const requestId = send(MessageType.SESSION_START, {
      pcId: selectedPcId,
      sessionMode,
    });
    if (!requestId) {
      setIsStarting(false);
      isStartingSessionRef.current = false;
      if (startupTimeoutRef.current) {
        clearTimeout(startupTimeoutRef.current);
        startupTimeoutRef.current = undefined;
      }
    }
  }, [selectedPcId, send, sessionMode, isActive, isStarting]);

  const handleEnd = useCallback(() => {
    send(MessageType.SESSION_END);
  }, [send]);

  const handlePause = useCallback(() => {
    send(MessageType.SESSION_PAUSE);
  }, [send]);

  const handleResume = useCallback(() => {
    send(MessageType.SESSION_RESUME);
  }, [send]);

  const sendRef = useRef(send);
  sendRef.current = send;
  const toneArmRef = useRef(toneArm);
  toneArmRef.current = toneArm;
  const sensitivityRef = useRef(sensitivity);
  sensitivityRef.current = sensitivity;
  const autoSendRef = useRef(autoSend);
  autoSendRef.current = autoSend;

  const handlePcInput = useCallback(() => {
    const text = pcInput.trim();
    if (!text) return;
    send(MessageType.PC_INPUT, { text, toneArm, sensitivity });
    setPcInput("");
  }, [pcInput, send, toneArm, sensitivity]);

  // Auto-send: when toggle is on, debounce 400ms after input changes, then send
  const handleInputChange = useCallback((value: string) => {
    setPcInput(value);
    if (autoSendTimerRef.current) clearTimeout(autoSendTimerRef.current);
    if (autoSendRef.current && value.trim()) {
      autoSendTimerRef.current = setTimeout(() => {
        const text = value.trim();
        if (text) {
          sendRef.current(MessageType.PC_INPUT, {
            text,
            toneArm: toneArmRef.current,
            sensitivity: sensitivityRef.current,
          });
          setPcInput("");
        }
      }, 400);
    }
  }, []);

  const handleSubmitRecording = useCallback(async () => {
    await stopAutoRecording();
    // Transcription will arrive via AUDIO_TRANSCRIBED → fills pcInput
  }, [stopAutoRecording]);

  const effectiveSessionMode = sessionState?.sessionMode ?? sessionMode;
  const selectedPc = profiles.find((pc) => pc.id === selectedPcId) ?? null;

  return (
    <div className="flex flex-col h-full min-h-0 gap-3">
      {/* Controls */}
      <div className="ms-panel p-4 overflow-hidden">
        <div className="ms-session-toolbar mb-3">
          <div className="ms-segmented shrink-0">
            <button
              type="button"
              onClick={() => onSessionModeChange("structured")}
              disabled={isActive}
              aria-pressed={effectiveSessionMode === "structured"}
              className="ms-mini-btn ms-segment-btn"
            >
              Structured
            </button>
            <button
              type="button"
              onClick={() => onSessionModeChange("conversational")}
              disabled={isActive}
              aria-pressed={effectiveSessionMode === "conversational"}
              className="ms-mini-btn ms-segment-btn"
            >
              Conversational
            </button>
          </div>

          <select
            value={selectedPcId}
            onChange={(e) => onSelectPc(e.target.value)}
            disabled={isActive}
            className="ms-select ms-toolbar-select flex-1 min-w-0"
          >
            <option value="">Select PC...</option>
            {profiles.map((pc) => (
              <option key={pc.id} value={pc.id}>
                {pc.firstName} {pc.lastName}
              </option>
            ))}
          </select>

          {!isActive ? (
            <button
              onClick={handleStart}
              disabled={!connected || !selectedPcId || isStarting || isStartingSessionRef.current}
              className="ms-btn ms-btn-emerald ms-pill ms-toolbar-cta"
            >
              Start Session
            </button>
          ) : (
            <>
              {sessionState?.isPaused ? (
                <button
                  onClick={handleResume}
                  className="ms-btn ms-btn-primary ms-pill"
                >
                  Resume
                </button>
              ) : (
                <button
                  onClick={handlePause}
                  className="ms-btn ms-btn-warn ms-pill"
                >
                  Pause
                </button>
              )}
              <button
                onClick={handleEnd}
                className="ms-btn ms-btn-danger ms-pill"
              >
                End
              </button>
            </>
          )}
        </div>

        {/* Session timer and phase */}
        {sessionState && (
          <div className="flex items-center gap-3">
            <span
              className={`ms-chip ${
                PHASE_COLORS[sessionState.phase] ?? "bg-gray-600"
              }`}
            >
              {sessionState.phase.replace(/_/g, " ")}
            </span>
            {sessionState.r3rState && (
              <span className="text-xs text-indigo-400 font-mono">
                {sessionState.r3rState}
              </span>
            )}

            {/* Toggles */}
            {isActive && (
              <div className="flex items-center gap-3">
                <label className="ms-toggle">
                  <input
                    type="checkbox"
                    checked={autoSend}
                    onChange={(e) => setAutoSend(e.target.checked)}
                  />
                  Auto-Send
                </label>
                <label className="ms-toggle">
                  <input
                    type="checkbox"
                    checked={autoRecord}
                    onChange={(e) => setAutoRecord(e.target.checked)}
                  />
                  Auto-Record
                </label>
              </div>
            )}

            <span className="ml-auto font-mono text-white text-sm">
              {formatTime(sessionState.elapsed)}
            </span>
            {sessionState.isPaused && (
              <span className="text-amber-400 text-xs">PAUSED</span>
            )}
          </div>
        )}
      </div>

      {/* Chat messages */}
      <div className="flex-1 min-h-0 ms-panel flex flex-col">
        <div ref={messagesScrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2 ms-scroll">
            {messages.length === 0 && !isActive ? (
              <div className="h-full min-h-0 flex items-center justify-center">
              <div className="ms-empty-state max-w-md w-full text-center px-6 py-8">
                <p className="text-sm text-cyan-100 font-semibold tracking-wide">Ready To Begin</p>
                <p className="text-xs text-gray-400 mt-2">
                  {selectedPc
                    ? `Profile selected: ${selectedPc.firstName} ${selectedPc.lastName}`
                    : "Select a PC profile and press Start Session to begin auditing."}
                </p>
                <div className="mt-4 flex items-center justify-center gap-2 text-[10px] text-gray-400 uppercase tracking-[0.2em]">
                  <span className={`w-2 h-2 rounded-full ${connected ? "bg-emerald-400" : "bg-red-400"}`} />
                  {connected ? "Live connection active" : "Backend disconnected"}
                </div>
              </div>
            </div>
            ) : messages.length === 0 ? (
            <div className="h-full min-h-0 flex items-center justify-center">
              <p className="text-gray-400 text-xs py-8 text-center tracking-wide animate-pulse">
                Session in progress...
              </p>
            </div>
          ) : (
            messages.map((msg, i) => <ChatBubble key={i} message={msg} />)
          )}

          {/* Typing indicator */}
          {isAiTyping && (
            <div className="flex justify-start">
              <div className="bg-gray-800 px-3 py-2 rounded-lg text-sm text-gray-400 animate-pulse">
                Auditor is thinking...
              </div>
            </div>
          )}

          {chargeMap.length > 0 && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setShowChargeMap((v) => !v)}
                className="text-[11px] border border-gray-600/70 rounded-full px-2.5 py-1 text-gray-300 hover:text-white hover:border-gray-400 transition-colors"
              >
                {showChargeMap ? "Hide Charge Map" : "Show Charge Map"}
              </button>
            </div>
          )}

          {showChargeMap && chargeMap.length > 0 && (
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-[0.2em] text-gray-400">Charge Map</div>
              <div className="max-h-28 overflow-y-auto space-y-1 pr-1">
                {chargeMap.map((entry, i) => (
                  <div
                    key={`${entry.timestamp}-${i}`}
                    className="rounded-md border border-gray-800 bg-black/20 px-2 py-1"
                  >
                    <p className="text-xs text-cyan-200">{entry.question}</p>
                    <p className="text-[10px] text-gray-400 mt-1">
                      Charge {entry.chargeScore} • Peak {entry.peakDeviation.toFixed(2)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>

        {/* Input area */}
        {isActive && !sessionState?.isPaused && (
          <div className="px-3 pb-3 pt-1 border-t border-gray-800 space-y-2 shrink-0">
            {/* Auto-recording indicator + submit */}
            {isAutoRecording && (
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                <span className="text-xs text-red-400 flex-1">Recording...</span>
                <button
                  onClick={handleSubmitRecording}
                  className="ms-btn ms-btn-warn text-xs px-3 py-1 rounded-full"
                >
                  Submit Recording
                </button>
              </div>
            )}
            <div className="flex gap-2">
              <input
                type="text"
                value={pcInput}
                onChange={(e) => handleInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    // Cancel any pending auto-send timer on explicit Enter
                    if (autoSendTimerRef.current) clearTimeout(autoSendTimerRef.current);
                    if (isAutoRecording) handleSubmitRecording();
                    else handlePcInput();
                  }
                }}
                placeholder={autoSend ? "Auto-Send ON — paste or dictate..." : "Type PC's response..."}
                className={`ms-input flex-1 rounded-full px-4 py-1.5 text-sm ${
                  isAutoRecording
                    ? "border-red-600/50"
                    : autoSend
                      ? "border-indigo-500/50 focus:border-indigo-400"
                      : "border-gray-700 focus:border-indigo-500"
                }`}
              />
              <MicButton send={send} disabled={!isActive} mode="transcribe" audioDeviceId={audioDeviceId} />
              <MicButton send={send} disabled={!isActive} mode="send" audioDeviceId={audioDeviceId} />
              <button
                onClick={handlePcInput}
                disabled={!pcInput.trim()}
                className="ms-btn ms-btn-primary rounded-full px-4 py-1.5 text-sm"
              >
                Send
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
