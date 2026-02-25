import { useEffect, useCallback, useState } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { MessageType } from "./types/messages";
import type { DBStatus, PCProfile, WSMessage } from "./types/messages";
import MeterDisplay from "./components/MeterDisplay";
import SignalMonitor from "./components/SignalMonitor";
import SessionPanel from "./components/SessionPanel";
import StatusPanel from "./components/StatusPanel";

// In Electron, the preload script exposes the port; in dev browser, default to 8765
const port = (window as unknown as { __MINDSCOPE_PORT__?: number }).__MINDSCOPE_PORT__ ?? 8765;
const WS_URL = `ws://127.0.0.1:${port}`;

export default function App() {
  const { connected, send, subscribe } = useWebSocket(WS_URL);
  const [dbStatus, setDbStatus] = useState<DBStatus | null>(null);
  const [profiles, setProfiles] = useState<PCProfile[]>([]);
  const [selectedPcId, setSelectedPcId] = useState("");
  const [showManager, setShowManager] = useState(false);
  const [sensitivity, setSensitivity] = useState(16);
  const [toneArm, setToneArm] = useState(2.0);
  const [smoothing, setSmoothing] = useState(50);
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [signalExpanded, setSignalExpanded] = useState(false);

  // Helper to update profiles from any message containing them
  const applyProfiles = useCallback((list: PCProfile[]) => {
    setProfiles(list);
  }, []);

  // Persistent subscriptions — registered once on mount
  useEffect(() => {
    const unsubs = [
      // INIT message includes profiles (server sends on connect)
      subscribe(MessageType.INIT, (msg: WSMessage) => {
        setDbStatus(msg.data.dbStatus as unknown as DBStatus);
        if (msg.data.profiles) {
          applyProfiles((msg.data.profiles as unknown as PCProfile[]) ?? []);
        }
      }),
      subscribe(MessageType.DB_STATUS_DATA, (msg: WSMessage) => {
        setDbStatus(msg.data as unknown as DBStatus);
      }),
      // Also handle explicit PC_LIST_DATA responses (from PC Manager, create, delete)
      subscribe(MessageType.PC_LIST_DATA, (msg: WSMessage) => {
        applyProfiles((msg.data.profiles as unknown as PCProfile[]) ?? []);
      }),
      subscribe(MessageType.PC_CREATED, () => {
        send(MessageType.PC_LIST);
      }),
      subscribe(MessageType.PC_DELETED, () => {
        send(MessageType.PC_LIST);
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [subscribe, send, applyProfiles]);

  // Auto-select first PC when profiles load
  useEffect(() => {
    if (profiles.length > 0 && !selectedPcId) {
      setSelectedPcId(profiles[0].id);
    }
  }, [profiles, selectedPcId]);

  return (
    <div className="h-screen bg-gray-950 flex flex-col overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 bg-gray-900 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold text-white">MindScope</h1>
          <span className="text-xs text-gray-500">v2 — Phase 2</span>
        </div>
        <div className="flex items-center gap-3">
          {/* Connection indicator */}
          <div className="flex items-center gap-1.5">
            <div
              className={`w-2 h-2 rounded-full ${
                connected ? "bg-emerald-400" : "bg-red-400"
              }`}
            />
            <span className="text-xs text-gray-400">
              {connected ? "Connected" : "Disconnected"}
            </span>
          </div>
          {/* PC Manager toggle */}
          <button
            onClick={() => setShowManager(!showManager)}
            className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 transition-colors"
          >
            {showManager ? "Close Manager" : "PC Manager"}
          </button>
        </div>
      </header>

      {/* PC Manager modal overlay */}
      {showManager && (
        <div className="absolute inset-0 z-50 bg-black/60 flex items-center justify-center">
          <div className="relative bg-gray-950 rounded-lg border border-gray-800 shadow-xl max-w-2xl w-full max-h-[80vh] overflow-y-auto">
            <button
              onClick={() => setShowManager(false)}
              className="absolute top-3 right-3 text-gray-500 hover:text-white text-lg"
            >
              x
            </button>
            <StatusPanel connected={connected} send={send} subscribe={subscribe} />
          </div>
        </div>
      )}

      {/* Main content */}
      <div className={`flex-1 flex flex-col min-h-0 p-3 gap-3 ${signalExpanded ? "" : ""}`}>
        <div className="flex-1 flex min-h-0 gap-3">
          {/* Left column: Meter + Signal (when not expanded) */}
          <div className="w-1/2 flex flex-col gap-3 min-h-0">
            <div className="flex-1 min-h-0">
              <MeterDisplay
                subscribe={subscribe}
                sensitivity={sensitivity}
                toneArm={toneArm}
                smoothing={smoothing}
                onSensitivityChange={setSensitivity}
                onToneArmChange={setToneArm}
                onSmoothingChange={setSmoothing}
              />
            </div>
            {!signalExpanded && (
              <SignalMonitor
                subscribe={subscribe}
                smoothing={smoothing}
                showAnnotations={showAnnotations}
                onToggleAnnotations={() => setShowAnnotations(!showAnnotations)}
                expanded={false}
                onToggleExpand={() => setSignalExpanded(true)}
              />
            )}
          </div>

          {/* Right column: Session */}
          <div className="w-1/2 min-h-0">
            <SessionPanel
              connected={connected}
              send={send}
              subscribe={subscribe}
              profiles={profiles}
              selectedPcId={selectedPcId}
              onSelectPc={setSelectedPcId}
              sensitivity={sensitivity}
              toneArm={toneArm}
            />
          </div>
        </div>

        {/* Expanded signal monitor — full width below both columns */}
        {signalExpanded && (
          <SignalMonitor
            subscribe={subscribe}
            smoothing={smoothing}
            showAnnotations={showAnnotations}
            onToggleAnnotations={() => setShowAnnotations(!showAnnotations)}
            expanded={true}
            onToggleExpand={() => setSignalExpanded(false)}
          />
        )}
      </div>
    </div>
  );
}
