import { useCallback, useEffect, useState } from "react";
import { MessageType } from "../types/messages";
import type { DBStatus, PCProfile, WSMessage } from "../types/messages";

interface StatusPanelProps {
  connected: boolean;
  send: (type: string, data?: Record<string, unknown>) => void;
  subscribe: (type: string, handler: (msg: WSMessage) => void) => () => void;
}

export default function StatusPanel({ connected, send, subscribe }: StatusPanelProps) {
  const [dbStatus, setDbStatus] = useState<DBStatus | null>(null);
  const [profiles, setProfiles] = useState<PCProfile[]>([]);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");

  // Subscribe to messages
  useEffect(() => {
    const unsubs = [
      subscribe(MessageType.INIT, (msg) => {
        setDbStatus(msg.data.dbStatus as unknown as DBStatus);
      }),
      subscribe(MessageType.DB_STATUS_DATA, (msg) => {
        setDbStatus(msg.data as unknown as DBStatus);
      }),
      subscribe(MessageType.PC_LIST_DATA, (msg) => {
        setProfiles((msg.data.profiles as unknown as PCProfile[]) ?? []);
      }),
      subscribe(MessageType.PC_CREATED, () => {
        send(MessageType.PC_LIST);
      }),
      subscribe(MessageType.PC_DELETED, () => {
        send(MessageType.PC_LIST);
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [subscribe, send]);

  // Fetch data when connected
  useEffect(() => {
    if (connected) {
      send(MessageType.DB_STATUS);
      send(MessageType.PC_LIST);
    }
  }, [connected, send]);

  const handleCreate = useCallback(() => {
    if (!firstName.trim()) return;
    send(MessageType.PC_CREATE, { firstName: firstName.trim(), lastName: lastName.trim() });
    setFirstName("");
    setLastName("");
  }, [firstName, lastName, send]);

  const handleDelete = useCallback(
    (id: string) => {
      send(MessageType.PC_DELETE, { id });
    },
    [send]
  );

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-bold text-white">Mindscope Atlas</h1>

      {/* Status indicators */}
      <div className="grid grid-cols-2 gap-4">
        <StatusCard
          label="WebSocket"
          status={connected ? "Connected" : "Disconnected"}
          ok={connected}
        />
        <StatusCard
          label="Database"
          status={dbStatus?.ready ? "Ready" : "Not Ready"}
          ok={dbStatus?.ready ?? false}
          detail={dbStatus ? `${dbStatus.pcCount} PC profiles` : undefined}
        />
      </div>

      {/* Create PC form */}
      <div className="ms-panel p-4">
        <h2 className="text-lg font-semibold text-white mb-3">Create PC Profile</h2>
        <div className="flex gap-3">
          <input
            type="text"
            placeholder="First name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            className="ms-input flex-1"
          />
          <input
            type="text"
            placeholder="Last name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            className="ms-input flex-1"
          />
          <button
            onClick={handleCreate}
            disabled={!connected || !firstName.trim()}
            className="ms-btn ms-btn-primary"
          >
            Create
          </button>
        </div>
      </div>

      {/* PC list */}
      <div className="ms-panel p-4">
        <h2 className="text-lg font-semibold text-white mb-3">
          PC Profiles {profiles.length > 0 && <span className="text-gray-500">({profiles.length})</span>}
        </h2>
        {profiles.length === 0 ? (
          <p className="text-gray-500 text-sm">No profiles yet. Create one above.</p>
        ) : (
          <ul className="space-y-2">
            {profiles.map((pc) => (
              <li
                key={pc.id}
                className="flex items-center justify-between bg-gray-800 rounded px-3 py-2 border border-gray-700"
              >
                <div>
                  <span className="text-white font-medium">
                    {pc.firstName} {pc.lastName}
                  </span>
                  <span className="text-gray-500 text-xs ml-2">
                    {pc.caseStatus} &middot; {pc.id.slice(0, 8)}
                  </span>
                </div>
                <button
                  onClick={() => handleDelete(pc.id)}
                  className="ms-btn ms-btn-danger text-xs px-3 py-1"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatusCard({
  label,
  status,
  ok,
  detail,
}: {
  label: string;
  status: string;
  ok: boolean;
  detail?: string;
}) {
  return (
    <div className="ms-panel p-4">
      <div className="flex items-center gap-2 mb-1">
        <div className={`w-2 h-2 rounded-full ${ok ? "bg-emerald-400" : "bg-red-400"}`} />
        <span className="text-gray-400 text-sm">{label}</span>
      </div>
      <p className="text-white font-medium">{status}</p>
      {detail && <p className="text-gray-500 text-xs mt-1">{detail}</p>}
    </div>
  );
}
