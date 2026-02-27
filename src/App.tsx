import { useCallback, useEffect, useState } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { MessageType, type DBStatus, type PCProfile, type WSMessage } from "./types/messages";
import { AppLayout } from "./AppLayout";
import type { SessionMode } from "./types/messages";

// In Electron, the preload script exposes the port; in dev browser, default to 8765
const port = (window as unknown as { __MINDSCOPE_PORT__?: number }).__MINDSCOPE_PORT__ ?? 8765;
const WS_URL = `ws://127.0.0.1:${port}`;

const SELECTED_PC_KEY = "mindscope_selectedPcId";
const SESSION_MODE_KEY = "mindscope_sessionMode";

export default function App() {
  const { connected, send, subscribe } = useWebSocket(WS_URL);
  const [dbStatus, setDbStatus] = useState<DBStatus | null>(null);
  const [profiles, setProfiles] = useState<PCProfile[]>([]);
  const [selectedPcId, setSelectedPcId] = useState<string>(() => {
    return localStorage.getItem(SELECTED_PC_KEY) || "";
  });
  const [showManager, setShowManager] = useState(false);
  const [showAudioSettings, setShowAudioSettings] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioPermissionError, setAudioPermissionError] = useState<string | null>(null);
  const [audioDeviceId, setAudioDeviceId] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem("mindscope_audioDeviceId") || "";
  });
  const [sensitivity, setSensitivity] = useState(16);
  const [toneArm, setToneArm] = useState(2.0);
  const [smoothing, setSmoothing] = useState(50);
  const [sessionMode, setSessionMode] = useState<SessionMode>(() => {
    const savedMode = localStorage.getItem(SESSION_MODE_KEY);
    return savedMode === "conversational" || savedMode === "structured"
      ? savedMode
      : "structured";
  });
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [signalExpanded, setSignalExpanded] = useState(false);

  const persistSessionMode = useCallback((mode: SessionMode) => {
    localStorage.setItem(SESSION_MODE_KEY, mode);
    setSessionMode(mode);
  }, []);

  useEffect(() => {
    if (selectedPcId) {
      localStorage.setItem(SELECTED_PC_KEY, selectedPcId);
    } else {
      localStorage.removeItem(SELECTED_PC_KEY);
    }
  }, [selectedPcId]);

  const loadAudioDevices = useCallback(async () => {
    if (!window.navigator?.mediaDevices?.enumerateDevices) {
      setAudioPermissionError("This browser does not support microphone enumeration.");
      return;
    }
    try {
      // Request permission so device labels are available.
      await window.navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        stream.getTracks().forEach((t) => t.stop());
      });

      const devices = await window.navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((device) => device.kind === "audioinput");
      setAudioDevices(inputs);
      setAudioPermissionError(inputs.length ? null : "No microphones found.");

      if (inputs.length === 0) {
        setAudioDeviceId("");
        return;
      }

      setAudioDeviceId((current) => {
        if (!current) return "";
        const exists = inputs.some((d) => d.deviceId === current);
        return exists ? current : "";
      });
    } catch (err) {
      console.error("[Audio Settings] Failed to load devices", err);
      setAudioPermissionError("Microphone access denied or unavailable. Using default microphone.");
      setAudioDevices([]);
    }
  }, []);

  useEffect(() => {
    if (audioDeviceId) {
      localStorage.setItem("mindscope_audioDeviceId", audioDeviceId);
    } else {
      localStorage.removeItem("mindscope_audioDeviceId");
    }
  }, [audioDeviceId]);

  useEffect(() => {
    void loadAudioDevices();
  }, [loadAudioDevices]);

  useEffect(() => {
    if (!showAudioSettings) return;
    void loadAudioDevices();
  }, [showAudioSettings, loadAudioDevices]);

  const applyProfiles = useCallback((list: PCProfile[]) => {
    setProfiles(list);
  }, []);

  useEffect(() => {
    if (connected) {
      send(MessageType.DB_STATUS);
    }
  }, [connected, send]);

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

  useEffect(() => {
    if (!profiles.length || !selectedPcId) {
      return;
    }

    const found = profiles.some((pc) => pc.id === selectedPcId);
    if (!found) {
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
      onSessionModeChange={persistSessionMode}
      showManager={showManager}
      setShowManager={setShowManager}
      showAnnotations={showAnnotations}
      onToggleAnnotations={() => setShowAnnotations((v) => !v)}
      signalExpanded={signalExpanded}
      setSignalExpanded={setSignalExpanded}
      audioDevices={audioDevices}
      audioPermissionError={audioPermissionError}
      showAudioSettings={showAudioSettings}
      setShowAudioSettings={setShowAudioSettings}
      audioDeviceId={audioDeviceId}
      onAudioDeviceChange={setAudioDeviceId}
      onRefreshAudioDevices={loadAudioDevices}
    />
  );
}
