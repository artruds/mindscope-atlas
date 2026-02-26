import MeterDisplay from "./components/MeterDisplay";
import SignalMonitor from "./components/SignalMonitor";
import SessionPanel from "./components/SessionPanel";
import StatusPanel from "./components/StatusPanel";
import type { PCProfile, WSMessage } from "./types/messages";

interface AppLayoutProps {
  connected: boolean;
  dbStatus?: unknown | null;
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
}: AppLayoutProps) {
  void dbStatus;

  return (
    <div className="mindscope-theme flex flex-col relative ms-app-shell min-h-0 overflow-visible">
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
          <button
            onClick={() => setShowManager(!showManager)}
            className="ms-ghost-btn text-xs"
            type="button"
          >
            {showManager ? "Close Manager" : "PC Manager"}
          </button>
        </div>
      </header>

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
              />
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
