import { useCallback, useEffect, useRef, useState } from "react";
import type { WSMessage } from "../types/messages";

type MessageHandler = (msg: WSMessage) => void;

interface UseWebSocketReturn {
  connected: boolean;
  send: (type: string, data?: Record<string, unknown>) => void;
  subscribe: (type: string, handler: MessageHandler) => () => void;
  lastMessage: WSMessage | null;
}

export function useWebSocket(url: string): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Map<string, Set<MessageHandler>>>(new Map());
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const seenMessages = useRef<Set<string>>(new Set());
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<WSMessage | null>(null);
  const requestIdCounter = useRef(0);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(url);

    ws.onopen = () => {
      console.log("[WS] Connected to", url);
      setConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data);

        // Dedup by requestId only — broadcasts (no requestId) always pass through
        if (msg.requestId) {
          if (seenMessages.current.has(msg.requestId)) return;
          seenMessages.current.add(msg.requestId);
          if (seenMessages.current.size > 500) seenMessages.current.clear();
        }

        setLastMessage(msg);

        // Dispatch to type-specific subscribers
        const handlers = handlersRef.current.get(msg.type);
        if (handlers) {
          handlers.forEach((handler) => handler(msg));
        }

        // Also dispatch to wildcard subscribers
        const wildcardHandlers = handlersRef.current.get("*");
        if (wildcardHandlers) {
          wildcardHandlers.forEach((handler) => handler(msg));
        }
      } catch (err) {
        console.error("[WS] Failed to parse message:", err);
      }
    };

    ws.onclose = () => {
      console.log("[WS] Disconnected");
      setConnected(false);
      wsRef.current = null;
      // Auto-reconnect after 2s
      reconnectTimer.current = setTimeout(connect, 2000);
    };

    ws.onerror = (err) => {
      console.error("[WS] Error:", err);
    };

    wsRef.current = ws;
  }, [url]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback(
    (type: string, data: Record<string, unknown> = {}) => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) {
        console.warn("[WS] Not connected, cannot send:", type);
        return;
      }
      const requestId = `req_${++requestIdCounter.current}`;
      const msg: WSMessage = { type, data, requestId };
      wsRef.current.send(JSON.stringify(msg));
    },
    []
  );

  const subscribe = useCallback(
    (type: string, handler: MessageHandler): (() => void) => {
      if (!handlersRef.current.has(type)) {
        handlersRef.current.set(type, new Set());
      }
      handlersRef.current.get(type)!.add(handler);

      // Return unsubscribe function
      return () => {
        handlersRef.current.get(type)?.delete(handler);
      };
    },
    []
  );

  return { connected, send, subscribe, lastMessage };
}
