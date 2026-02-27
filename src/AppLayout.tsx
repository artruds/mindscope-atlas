import MeterDisplay from "./components/MeterDisplay";
import SignalMonitor from "./components/SignalMonitor";
import SessionPanel from "./components/SessionPanel";
import StatusPanel from "./components/StatusPanel";
import type { DBStatus, PCProfile, WSMessage } from "./types/messages";

interface AppLayoutProps {
  connected: boolean;
  dbStatus: DBStatus | null;
  send: (type: string, data?: Record<string, unknown>) => string | undefined;
  subscribe: (type: string, handler: (msg: WSMessage) => void) => () => void;
  profiles: PCProfile[];
  selectedPcId: string;
  onSelectPc: (id: string) => void;
  sensitivity: number;
  toneArm: number;
  smoothing: number;
  sessionMode: "structured" | "conversational";
  setSensitivity: (value: number) => void;
  setToneArm: (value: number) => void;
  setSmoothing: (value: number) => void;
  onSessionModeChange: (mode: "structured" | "conversational") => void;
  showManager: boolean;
  setShowManager: (open: boolean) => void;
  showAnnotations: boolean;
  onToggleAnnotations: () => void;
  signalExpanded: boolean;
  setSignalExpanded: (expanded: boolean) => void;
  audioDevices: MediaDeviceInfo[];
  audioPermissionError: string | null;
  showAudioSettings: boolean;
  setShowAudioSettings: (open: boolean) => void;
  audioDeviceId: string;
  onAudioDeviceChange: (deviceId: string) => void;
  onRefreshAudioDevices: () => void;
}

export function AppLayout({
  connected,
  dbStatus,
  send,
  subscribe,
  profiles,
  selectedPcId,
  onSelectPc,
  sensitivity,
  toneArm,
  smoothing,
  sessionMode,
  setSensitivity,
  setToneArm,
  setSmoothing,
  onSessionModeChange,
  showManager,
  setShowManager,
  showAnnotations,
  onToggleAnnotations,
  signalExpanded,
  setSignalExpanded,
  audioDevices,
  audioPermissionError,
  showAudioSettings,
  setShowAudioSettings,
  audioDeviceId,
  onAudioDeviceChange,
  onRefreshAudioDevices,
}: AppLayoutProps) {
  const aiModel = dbStatus?.aiModel;
  const aiModelLabel =
    aiModel === "unavailable (missing ANTHROPIC_API_KEY)"
      ? "unavailable — Anthropic key missing"
      : aiModel
        ? aiModel
        : connected
          ? "unavailable"
          : "disconnected";

  return (
    <div className="mindscope-theme flex flex-col relative ms-app-shell overflow-hidden" style={{ height: "100dvh" }}>
      <div className="ms-bg-orb ms-bg-orb-a" />
      <div className="ms-bg-orb ms-bg-orb-b" />

      <header className="ms-topbar shrink-0">
        <div className="flex items-center gap-3">
          <div className="leading-tight">
            <h1 className="text-xl sm:text-2xl font-bold tracking-[0.14em] text-white uppercase">
              Mindscope Atlas
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <div className="ms-chip ms-chip-status">
            <span className={`ms-dot ${connected ? "ms-dot-on" : "ms-dot-off"}`} />
            <span>
              {connected ? "Connected" : "Disconnected"}
            </span>
          </div>
          <div className="ms-chip ms-chip-soft">
            AI: {aiModelLabel}
          </div>
          <button
            onClick={() => setShowAudioSettings(true)}
            className="ms-ghost-btn text-xs"
            type="button"
            title="Audio settings"
          >
            ⚙ Settings
          </button>
          <button
            onClick={() => setShowManager(!showManager)}
            className="ms-ghost-btn text-xs"
            type="button"
          >
            {showManager ? "Close Manager" : "PC Manager"}
          </button>
        </div>
      </header>

      {showAudioSettings && (
        <div className="ms-overlay" role="dialog" aria-modal="true">
          <div className="relative ms-modal-shell ms-overlay-panel max-w-2xl w-full max-h-[82vh] overflow-y-auto">
            <div className="ms-modal-header px-3 py-2 flex items-center justify-between border-b border-gray-800">
              <h2 className="text-sm uppercase tracking-[0.25em] text-cyan-300">Audio Settings</h2>
              <button
                onClick={() => setShowAudioSettings(false)}
                className="ms-ghost-btn text-sm leading-none"
                aria-label="Close Audio Settings"
                type="button"
              >
                ×
              </button>
            </div>
            <div className="px-4 py-4 space-y-3">
              <label className="text-xs uppercase tracking-[0.18em] text-gray-400 block">
                Default microphone for Whisper
              </label>
              <div className="flex items-center gap-2">
                <select
                  className="ms-select flex-1"
                  value={audioDeviceId}
                  onChange={(event) => onAudioDeviceChange(event.target.value)}
                >
                  <option value="">System default</option>
                  {audioDevices.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || `Microphone ${device.deviceId.slice(0, 4)}`}
                    </option>
                  ))}
                </select>
                <button
                  onClick={onRefreshAudioDevices}
                  className="ms-btn ms-btn-primary px-3 py-1.5"
                  type="button"
                >
                  Refresh
                </button>
              </div>
              {audioPermissionError && (
                <p className="text-[11px] text-amber-300">{audioPermissionError}</p>
              )}
              <p className="text-[11px] text-gray-400">Selected mic ID: {audioDeviceId || "default"}</p>
            </div>
          </div>
        </div>
      )}

      {showManager && (
        <div className="ms-overlay" role="dialog" aria-modal="true">
          <div className="relative ms-modal-shell ms-overlay-panel max-w-2xl w-full max-h-[82vh] overflow-y-auto">
            <button
              onClick={() => setShowManager(false)}
              className="absolute top-3 right-3 ms-ghost-btn text-sm leading-none"
              aria-label="Close PC Manager"
              type="button"
            >
              ×
            </button>
            <StatusPanel connected={connected} send={send} subscribe={subscribe} />
          </div>
        </div>
      )}

      <div className="ms-main flex-1 min-h-0 p-0 sm:p-0.5 relative w-full min-w-0 overflow-hidden">
        <div className="ms-app-frame h-full">
          <div className="ms-grid h-full">
            <section className="h-full ms-panel-stack ms-fade-up ms-delay-1 min-w-0 min-h-0 overflow-hidden px-1">
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
                  onToggleAnnotations={onToggleAnnotations}
                  expanded={false}
                  onToggleExpand={() => setSignalExpanded(true)}
                />
              )}
            </section>

            <section className="h-full ms-panel-stack ms-fade-up ms-delay-2 min-w-0 min-h-0 overflow-hidden px-1">
              <div className="ms-section-header">
                <h2>Session Control</h2>
                <span className="ms-chip">
                  {profiles.length} PC{profiles.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="flex-1 min-h-0">
                <SessionPanel
                  connected={connected}
                  send={send}
                  subscribe={subscribe}
                  profiles={profiles}
                  selectedPcId={selectedPcId}
                  onSelectPc={onSelectPc}
                  sessionMode={sessionMode}
                  onSessionModeChange={onSessionModeChange}
                  sensitivity={sensitivity}
                  toneArm={toneArm}
                  audioDeviceId={audioDeviceId}
                />
              </div>
            </section>
          </div>
        </div>

        {signalExpanded && (
          <div className="ms-expanded-panel mt-2" role="region" aria-label="Expanded signal monitor">
            <SignalMonitor
              subscribe={subscribe}
              smoothing={smoothing}
              showAnnotations={showAnnotations}
              onToggleAnnotations={onToggleAnnotations}
              expanded={true}
              onToggleExpand={() => setSignalExpanded(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
