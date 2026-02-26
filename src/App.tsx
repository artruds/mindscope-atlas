import { useCallback, useEffect, useState } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { MessageType, type DBStatus, type PCProfile, type WSMessage } from "./types/messages";
import { AppLayout } from "./AppLayout";
import type { SessionMode } from "./types/messages";

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
  const [sessionMode, setSessionMode] = useState<SessionMode>("structured");
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [signalExpanded, setSignalExpanded] = useState(false);

  const applyProfiles = useCallback((list: PCProfile[]) => {
    setProfiles(list);
  }, []);

  useEffect(() => {
    const unsubs = [
      subscribe(MessageType.INIT, (msg: WSMessage) => {
        setDbStatus(msg.data.dbStatus as unknown as DBStatus);
        if (msg.data.profiles) {
          applyProfiles((msg.data.profiles as unknown as PCProfile[]) ?? []);
        }
      }),
      subscribe(MessageType.DB_STATUS_DATA, (msg: WSMessage) => {
        setDbStatus(msg.data as unknown as DBStatus);
      }),
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
    return () => unsubs.forEach((unsub) => unsub());
  }, [applyProfiles, send, subscribe]);

  useEffect(() => {
    if (profiles.length > 0 && !selectedPcId) {
      setSelectedPcId(profiles[0].id);
    }
  }, [profiles, selectedPcId]);

  return (
    <AppLayout
      connected={connected}
      dbStatus={dbStatus}
      send={send}
      subscribe={subscribe}
      profiles={profiles}
      selectedPcId={selectedPcId}
      onSelectPc={setSelectedPcId}
      sensitivity={sensitivity}
      toneArm={toneArm}
      sessionMode={sessionMode}
      smoothing={smoothing}
      setSensitivity={setSensitivity}
      setToneArm={setToneArm}
      setSmoothing={setSmoothing}
      onSessionModeChange={setSessionMode}
      showManager={showManager}
      setShowManager={setShowManager}
      showAnnotations={showAnnotations}
      onToggleAnnotations={() => setShowAnnotations((v) => !v)}
      signalExpanded={signalExpanded}
      setSignalExpanded={setSignalExpanded}
    />
  );
}
