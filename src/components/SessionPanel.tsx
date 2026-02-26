import { useCallback, useEffect, useRef, useState } from "react";
import { MessageType } from "../types/messages";
import type {
  WSMessage,
  PCProfile,
  SessionState,
  ChatMessage,
} from "../types/messages";
import MicButton from "./MicButton";
import ChatBubble from "./ChatBubble";
import { formatTime } from "../utils";

interface SessionPanelProps {
  connected: boolean;
  send: (type: string, data?: Record<string, unknown>) => void;
  subscribe: (type: string, handler: (msg: WSMessage) => void) => () => void;
  profiles: PCProfile[];
  selectedPcId: string;
  onSelectPc: (id: string) => void;
  sensitivity: number;
  toneArm: number;
}

const PHASE_COLORS: Record<string, string> = {
  SETUP: "bg-gray-600",
  START_RUDIMENTS: "bg-blue-600",
  PROCESSING: "bg-emerald-600",
  END_RUDIMENTS: "bg-amber-600",
  COMPLETE: "bg-gray-500",
};

export default function SessionPanel({
  connected,
  send,
  subscribe,
  profiles,
  selectedPcId,
  onSelectPc,
  sensitivity,
  toneArm,
}: SessionPanelProps) {
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isAiTyping, setIsAiTyping] = useState(false);
  const [pcInput, setPcInput] = useState("");
  const [autoRecord, setAutoRecord] = useState(false);
  const [isAutoRecording, setIsAutoRecording] = useState(false);
  const [autoSend, setAutoSend] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const autoSendTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const autoRecorderRef = useRef<MediaRecorder | null>(null);
  const autoStreamRef = useRef<MediaStream | null>(null);
  const autoChunksRef = useRef<Blob[]>([]);
  const sessionStateRef = useRef(sessionState);
  sessionStateRef.current = sessionState;
  const autoRecordRef = useRef(autoRecord);
  autoRecordRef.current = autoRecord;

  const startAutoRecording = useCallback(async () => {
    if (autoRecorderRef.current) return; // already recording
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
  }, []);

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
        setSessionState(msg.data as unknown as SessionState);
      }),
      subscribe(MessageType.SESSION_STARTED, (msg) => {
        const state = msg.data as unknown as SessionState;
        setSessionState(state);
        // Save to localStorage for recovery
        localStorage.setItem("mindscope_lastSessionId", state.sessionId);
        localStorage.setItem("mindscope_lastPcId", state.pcId);
        // Don't clear messages here — they were pre-cleared in handleStart
      }),
      subscribe(MessageType.SESSION_ENDED, () => {
        setSessionState(null);
        setIsAiTyping(false);
        localStorage.removeItem("mindscope_lastSessionId");
        localStorage.removeItem("mindscope_lastPcId");
      }),
      subscribe(MessageType.SESSION_PAUSED, (msg) => {
        setSessionState(msg.data as unknown as SessionState);
      }),
      subscribe(MessageType.SESSION_RESUMED, (msg) => {
        setSessionState(msg.data as unknown as SessionState);
      }),
      subscribe(MessageType.CHAT_MESSAGE, (msg) => {
        const chatMsg = msg.data as unknown as ChatMessage;
        if (chatMsg) {
          setMessages((prev) => {
            // Skip if duplicate (same turn + speaker + text)
            if (prev.some((m) => m.turnNumber === chatMsg.turnNumber
                && m.speaker === chatMsg.speaker && m.text === chatMsg.text)) {
              return prev;
            }
            return [...prev, chatMsg];
          });
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
        setIsAiTyping(true);
      }),
      subscribe(MessageType.AUDIO_TRANSCRIBED, (msg) => {
        // Only fill input box for transcribe-only mode (autoSent === false)
        if (msg.data.autoSent === false) {
          const text = msg.data.text as string;
          if (text) setPcInput(text);
        }
      }),
      subscribe(MessageType.SESSION_RECOVERED, (msg) => {
        const recovered = (msg.data.messages as unknown as ChatMessage[]) ?? [];
        if (recovered.length > 0) {
          setMessages(recovered);
        }
        // Restore session state so UI shows the session as active
        const recoveredState = msg.data.sessionState as unknown as SessionState | undefined;
        if (recoveredState) {
          setSessionState(recoveredState);
        }
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [subscribe, startAutoRecording]);

  // Attempt session recovery on mount
  useEffect(() => {
    if (!connected) return;
    const lastSessionId = localStorage.getItem("mindscope_lastSessionId");
    const lastPcId = localStorage.getItem("mindscope_lastPcId");
    if (lastSessionId && lastPcId) {
      send(MessageType.SESSION_RECOVER, { sessionId: lastSessionId, pcId: lastPcId });
    }
  }, [connected, send]);

  // Auto-scroll messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isAiTyping]);

  const handleStart = useCallback(() => {
    if (!selectedPcId) return;
    setMessages([]);       // clear BEFORE sending
    setIsAiTyping(false);
    send(MessageType.SESSION_START, { pcId: selectedPcId });
  }, [selectedPcId, send]);

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

  const isActive = sessionState !== null && sessionState.phase !== "COMPLETE";
  const selectedPc = profiles.find((pc) => pc.id === selectedPcId) ?? null;

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Controls */}
      <div className="ms-panel p-4">
        <div className="flex items-center gap-3 mb-3">
          <select
            value={selectedPcId}
            onChange={(e) => onSelectPc(e.target.value)}
            disabled={isActive}
            className="ms-select flex-1 min-w-0"
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
              disabled={!connected || !selectedPcId}
              className="ms-btn ms-btn-emerald ms-pill min-w-36"
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
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 ms-scroll">
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

          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        {isActive && !sessionState?.isPaused && (
          <div className="px-3 pb-3 pt-1 border-t border-gray-800 space-y-2">
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
              <MicButton send={send} disabled={!isActive} mode="transcribe" />
              <MicButton send={send} disabled={!isActive} mode="send" />
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
