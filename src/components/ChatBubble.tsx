import type { ChatMessage } from "../types/messages";

function ChargeIndicator({ score, bodyMovement }: { score?: number; bodyMovement?: boolean }) {
  if (bodyMovement) {
    return (
      <span className="text-gray-500 text-[10px] italic">(body movement)</span>
    );
  }
  if (!score || score < 10) return null;
  const color = score > 70 ? "text-red-400" : score > 40 ? "text-yellow-400" : "text-green-400";
  return (
    <span className={`${color} text-[10px] font-medium`}>
      charge {score}
    </span>
  );
}

export default function ChatBubble({ message }: { message: ChatMessage }) {
  const isAuditor = message.speaker === "auditor";
  return (
    <div className={`flex ${isAuditor ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[80%] px-3 py-2 rounded-xl text-sm leading-relaxed ${
          isAuditor
            ? "bg-gray-800 text-gray-100 border border-cyan-200/10"
            : "bg-indigo-600 text-white border border-cyan-100/30"
        }`}
      >
        <p>{message.text}</p>
        <div
          className={`flex items-center gap-2 mt-1 text-[10px] ${
            isAuditor ? "text-gray-500" : "text-cyan-100/80"
          }`}
        >
          <span>{isAuditor ? "Auditor" : "PC"}</span>
          {message.needleAction && <span className="opacity-70">{message.needleAction.replace(/_/g, " ")}</span>}
          {!isAuditor && (
            <ChargeIndicator score={message.chargeScore} bodyMovement={message.bodyMovement} />
          )}
        </div>
      </div>
    </div>
  );
}
