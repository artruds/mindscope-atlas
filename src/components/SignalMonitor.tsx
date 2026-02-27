import { useEffect, useRef, useCallback, useState } from "react";
import { MessageType } from "../types/messages";
import type {
  MeterEventData,
  ChatMessage,
  SessionState,
  WSMessage,
} from "../types/messages";
import { clamp, formatSignal } from "../utils";

interface SignalMonitorProps {
  subscribe: (type: string, handler: (msg: WSMessage) => void) => () => void;
  smoothing: number;
  showAnnotations: boolean;
  onToggleAnnotations: () => void;
  expanded: boolean;
  onToggleExpand: () => void;
}

const BUFFER_SECONDS = 600;
const POINTS_PER_SECOND = 10; // match broadcast rate
const MAX_POINTS = BUFFER_SECONDS * POINTS_PER_SECOND;
const Y_PADDING = 0.05; // 5% padding above/below auto-range

interface DataPoint {
  raw: number;
  time: number;
  timestampMs: number;
  rawSignal: number;
  rawUnfiltered: number;
  toneArm?: number;
  position?: number;
  needleAction?: string;
  confidence?: number;
}

interface Annotation {
  action: string;
  confidence: number;
  startTime: number; // counter-based time
  window: number; // in seconds (2.0)
}

interface QuestionMarker {
  time: number; // counter-based time (aligned with DataPoint.time)
  label: string; // first 25 chars of question
  turnNumber: number;
}

interface RecordingMarker {
  type: "start" | "end";
  time: number; // counter-based time (same as DataPoint.time)
}

interface TimelineMessage {
  speaker: "auditor" | "pc";
  text: string;
  timestamp: string;
  turnNumber: number;
  sessionId?: string | null;
  questionDroppedAt?: number;
  chargeScore?: number;
  bodyMovement?: boolean;
  isAiGenerated?: boolean;
}

const ANNOTATION_COLORS: Record<string, string> = {
  floating: "rgba(34,197,94,0.25)",
  free_needle: "rgba(6,182,212,0.25)",
  fall: "rgba(234,179,8,0.25)",
  long_fall: "rgba(249,115,22,0.25)",
  long_fall_blowdown: "rgba(239,68,68,0.25)",
  speeded_fall: "rgba(245,158,11,0.25)",
  rise: "rgba(59,130,246,0.25)",
  rock_slam: "rgba(239,68,68,0.35)",
  stuck: "rgba(107,114,128,0.25)",
  theta_blink: "rgba(168,85,247,0.25)",
  stage_four: "rgba(236,72,153,0.25)",
  dirty_needle: "rgba(180,83,9,0.25)",
  tick: "rgba(134,239,172,0.25)",
  double_tick: "rgba(134,239,172,0.25)",
  squeeze: "rgba(251,191,36,0.25)",
  body_motion: "rgba(156,163,175,0.2)",
};

const ANNOTATION_LABEL_COLORS: Record<string, string> = {
  floating: "#22c55e",
  free_needle: "#06b6d4",
  fall: "#eab308",
  long_fall: "#f97316",
  long_fall_blowdown: "#ef4444",
  speeded_fall: "#f59e0b",
  rise: "#3b82f6",
  rock_slam: "#ef4444",
  stuck: "#6b7280",
  theta_blink: "#a855f7",
  stage_four: "#ec4899",
  dirty_needle: "#b45309",
  tick: "#86efac",
  double_tick: "#86efac",
  squeeze: "#fbbf24",
  body_motion: "#9ca3af",
};

function parseTimestampMs(value: string | undefined): number {
  if (!value) return Date.now();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

export default function SignalMonitor({
  subscribe,
  smoothing,
  showAnnotations,
  onToggleAnnotations,
  expanded,
  onToggleExpand,
}: SignalMonitorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bufferRef = useRef<DataPoint[]>([]);
  const annotationsRef = useRef<Annotation[]>([]);
  const questionMarkersRef = useRef<QuestionMarker[]>([]);
  const counterRef = useRef(0);
  const animRef = useRef<number>(0);
  const lastClassifiedAtRef = useRef(0);
  const markersRef = useRef<RecordingMarker[]>([]);
  const [canMarkEnd, setCanMarkEnd] = useState(false);
  const pausedRef = useRef(false);
  const [paused, setPaused] = useState(false);
  const viewOffsetRef = useRef(0);      // points back from latest (0 = live edge)
  const viewWindowRef = useRef(60 * POINTS_PER_SECOND); // visible points (default 60s)
  const dragRef = useRef<{ startX: number; startOffset: number } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [softness, setSoftness] = useState(45);
  const softnessRef = useRef(45);
  softnessRef.current = softness;

  // Rolling min/max for all-time tracking
  const allTimeMinRef = useRef<number>(Infinity);
  const allTimeMaxRef = useRef<number>(-Infinity);
  const latestRef = useRef<number>(0);
  const timelineMessagesRef = useRef<TimelineMessage[]>([]);
  const activeSessionIdRef = useRef<string | null>(null);
  const smoothingRef = useRef(smoothing);
  smoothingRef.current = smoothing;
  const showAnnotationsRef = useRef(showAnnotations);
  showAnnotationsRef.current = showAnnotations;

  const resetTimelineSessionData = useCallback(() => {
    bufferRef.current = [];
    annotationsRef.current = [];
    questionMarkersRef.current = [];
    markersRef.current = [];
    timelineMessagesRef.current = [];
    counterRef.current = 0;
    allTimeMinRef.current = Infinity;
    allTimeMaxRef.current = -Infinity;
    latestRef.current = 0;
    lastClassifiedAtRef.current = 0;
    viewOffsetRef.current = 0;
    viewWindowRef.current = 60 * POINTS_PER_SECOND;
    setCanMarkEnd(false);
  }, []);

  // Subscribe to chat messages for question markers
  useEffect(() => {
    return subscribe(MessageType.CHAT_MESSAGE, (msg: WSMessage) => {
      const data = msg.data as unknown as ChatMessage;
      if (activeSessionIdRef.current) {
        const incomingSessionId = data.sessionId ?? null;
        if (incomingSessionId && incomingSessionId !== activeSessionIdRef.current) {
          return;
        }
        if (!incomingSessionId) {
          return;
        }
      }

      if (!activeSessionIdRef.current) {
        const incomingSessionId = data.sessionId ?? null;
        if (incomingSessionId) {
          activeSessionIdRef.current = incomingSessionId;
        }
      }

      timelineMessagesRef.current.push({
        speaker: data.speaker,
        text: data.text,
        timestamp: data.timestamp || new Date().toISOString(),
        turnNumber: data.turnNumber ?? 0,
        sessionId: data.sessionId ?? null,
        questionDroppedAt: data.questionDroppedAt,
        chargeScore: data.chargeScore,
        bodyMovement: data.bodyMovement,
        isAiGenerated: data.isAiGenerated,
      });
      const messageCap = MAX_POINTS;
      if (timelineMessagesRef.current.length > messageCap) {
        timelineMessagesRef.current = timelineMessagesRef.current.slice(-messageCap);
      }

      if (pausedRef.current) return; // don't add chart markers while paused
      if (data.speaker === "auditor" && data.questionDroppedAt) {
        questionMarkersRef.current.push({
          time: counterRef.current,
          label: data.text.slice(0, 25),
          turnNumber: data.turnNumber ?? 0,
        });
        // Trim old markers
        const cutoff = counterRef.current - MAX_POINTS;
        questionMarkersRef.current = questionMarkersRef.current.filter(
          (m) => m.time > cutoff,
        );
      }
    });
  }, [subscribe]);

  useEffect(() => {
    return subscribe(MessageType.SESSION_STARTED, (msg: WSMessage) => {
      const data = msg.data as unknown as SessionState;
      activeSessionIdRef.current = data?.sessionId ?? null;
      resetTimelineSessionData();
    });
  }, [resetTimelineSessionData, subscribe]);

  useEffect(() => {
    return subscribe(MessageType.SESSION_ENDED, () => {
      activeSessionIdRef.current = null;
    });
  }, [subscribe]);

  useEffect(() => {
    return subscribe(MessageType.SESSION_RECOVERED, (msg: WSMessage) => {
      const recoveredSessionId = (msg.data as { sessionId?: string | null }).sessionId ?? null;
      if (!recoveredSessionId) return;
      activeSessionIdRef.current = recoveredSessionId;
      const recoveredMessages = (msg.data.messages as unknown as TimelineMessage[]) ?? [];
      timelineMessagesRef.current = recoveredMessages.map((entry) => ({
        speaker: entry.speaker,
        text: entry.text,
        timestamp: entry.timestamp,
        turnNumber: entry.turnNumber,
        sessionId: entry.sessionId ?? recoveredSessionId,
        questionDroppedAt: entry.questionDroppedAt,
        chargeScore: entry.chargeScore,
        bodyMovement: entry.bodyMovement,
        isAiGenerated: entry.isAiGenerated,
      }));
    });
  }, [subscribe]);

  // Subscribe to meter events
  useEffect(() => {
    return subscribe(MessageType.METER_EVENT, (msg: WSMessage) => {
      // When paused, stop recording entirely — no new data, no counter advance
      if (pausedRef.current) return;

      const data = msg.data as unknown as MeterEventData;
      const unfiltered = data.rawUnfiltered ?? data.rawSignal ?? 0;
      const smoothed = data.rawSignal ?? unfiltered;
      const blend = smoothingRef.current / 100;
      const raw = unfiltered + (smoothed - unfiltered) * blend;
      const inverted = -raw; // Invert: squeeze (lower ADC) → line goes up
      const timestampMs = parseTimestampMs(data.timestamp);

      const currentTime = counterRef.current++;
      bufferRef.current.push({
        raw: inverted,
        time: currentTime,
        timestampMs,
        rawSignal: data.rawSignal ?? 0,
        rawUnfiltered: data.rawUnfiltered ?? 0,
        toneArm: data.toneArm,
        position: data.position,
        needleAction: data.needleAction,
        confidence: data.confidence,
      });

      // Track all-time min/max
      if (raw > 0) {
        if (inverted < allTimeMinRef.current) allTimeMinRef.current = inverted;
        if (inverted > allTimeMaxRef.current) allTimeMaxRef.current = inverted;
      }
      latestRef.current = inverted;

      // Trim buffer
      if (bufferRef.current.length > MAX_POINTS) {
        bufferRef.current = bufferRef.current.slice(-MAX_POINTS);
      }

      // Collect annotation when classification changes
      const classifiedAt = data.classifiedAt ?? 0;
      if (classifiedAt > 0 && classifiedAt !== lastClassifiedAtRef.current) {
        lastClassifiedAtRef.current = classifiedAt;
        const action = data.needleAction ?? "idle";
        const confidence = data.confidence ?? 0;
        if (action !== "idle" && confidence >= 0.3) {
          annotationsRef.current.push({
            action,
            confidence,
            startTime: currentTime,
            window: (data.classifyWindow ?? 2.0) * POINTS_PER_SECOND,
          });
        }
        // Trim old annotations
        const cutoff = currentTime - MAX_POINTS;
        annotationsRef.current = annotationsRef.current.filter(
          (a) => a.startTime + a.window > cutoff
        );
      }
    });
  }, [subscribe]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Handle resize inside draw so resize + redraw are atomic (no flicker)
    const parent = canvas.parentElement;
    if (parent) {
      const rect = parent.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.round(rect.width * dpr);
      const targetH = Math.round(rect.height * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
      }
    }

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const fullBuffer = bufferRef.current;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Background: layered meter-like gradient for a richer, cohesive look
    const baseBg = ctx.createLinearGradient(0, 0, w, 0);
    baseBg.addColorStop(0, "#030b20");
    baseBg.addColorStop(0.5, "#030816");
    baseBg.addColorStop(1, "#02050f");
    ctx.fillStyle = baseBg;
    ctx.fillRect(0, 0, w, h);

    const glowLeft = ctx.createRadialGradient(w * 0.18, h * 0.15, 10, w * 0.18, h * 0.15, w * 0.75);
    glowLeft.addColorStop(0, "rgba(34, 112, 168, 0.08)");
    glowLeft.addColorStop(1, "rgba(41, 126, 182, 0)");
    ctx.fillStyle = glowLeft;
    ctx.fillRect(0, 0, w, h);

    const glowRight = ctx.createRadialGradient(w * 0.85, h * 0.84, 10, w * 0.85, h * 0.84, w * 0.65);
    glowRight.addColorStop(0, "rgba(82, 152, 112, 0.05)");
    glowRight.addColorStop(1, "rgba(95, 168, 123, 0)");
    ctx.fillStyle = glowRight;
    ctx.fillRect(0, 0, w, h);

    // Subtle top-to-bottom vignette to keep the chart in the same darker family as the meter.
    const vignette = ctx.createLinearGradient(0, 0, 0, h);
    vignette.addColorStop(0, "rgba(0, 0, 0, 0.12)");
    vignette.addColorStop(0.45, "rgba(0, 0, 0, 0.04)");
    vignette.addColorStop(1, "rgba(0, 0, 0, 0.18)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);

    const margin = 80; // left margin for Y labels
    const rightMargin = 8;
    const topMargin = 4;
    const bottomMargin = 14;
    const plotW = w - margin - rightMargin;
    const plotH = h - topMargin - bottomMargin;

    if (fullBuffer.length < 2) {
      ctx.fillStyle = "#4b5563";
      ctx.textAlign = "center";
      ctx.font = "12px monospace";
      ctx.fillText("Waiting for signal...", w / 2, h / 2);
      animRef.current = requestAnimationFrame(draw);
      return;
    }

    // Determine visible slice based on pause/scroll state
    const totalPoints = fullBuffer.length;
    const windowSize = viewWindowRef.current;
    const offset = pausedRef.current ? viewOffsetRef.current : 0;
    const endIdx = Math.max(0, totalPoints - offset);
    const startIdx = Math.max(0, endIdx - windowSize);
    const buffer = fullBuffer.slice(startIdx, endIdx);

    if (buffer.length < 2) {
      animRef.current = requestAnimationFrame(draw);
      return;
    }

    // Compute visible min/max from visible buffer (auto-range)
    let visMin = Infinity;
    let visMax = -Infinity;
    for (const pt of buffer) {
      if (pt.raw < visMin) visMin = pt.raw;
      if (pt.raw > visMax) visMax = pt.raw;
    }

    // Add padding so trace doesn't touch edges
    const range = visMax - visMin;
    const padding = Math.max(range * Y_PADDING, 1);
    const yMin = visMin - padding;
    const yMax = visMax + padding;
    const yRange = yMax - yMin;

    // Buffer time window for x-axis mapping
    const bufferStartTime = buffer[0].time;
    const bufferEndTime = buffer[buffer.length - 1].time;
    const timeSpan = Math.max(bufferEndTime - bufferStartTime, 1);
    const softnessRatio = clamp(softnessRef.current / 100, 0, 1);
    const smoothAlpha = 1 - softnessRatio * 0.9;
    const lineWidth = 1.5 + softnessRatio * 1.8;
    const glow = Math.round(12 * softnessRatio);

    // Grid lines (4 horizontal divisions)
    ctx.strokeStyle = "rgba(225, 231, 239, 0.28)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = topMargin + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(margin, y);
      ctx.lineTo(w - rightMargin, y);
      ctx.stroke();
    }

    // Y-axis labels (auto-ranged values)
    ctx.font = "9px monospace";
    ctx.fillStyle = "rgba(197, 210, 226, 0.72)";
    ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const val = yMax - (yRange * i) / 4;
      const y = topMargin + (plotH * i) / 4 + 3;
      ctx.fillText(formatSignal(val), margin - 4, y);
    }

    // Draw annotations (behind signal trace)
    if (showAnnotationsRef.current) {
      for (const ann of annotationsRef.current) {
        const color = ANNOTATION_COLORS[ann.action];
        if (!color) continue;

        // Map annotation start/end to x positions
        const annStart = ann.startTime - ann.window; // annotation covers window before classification
        const annEnd = ann.startTime;
        const x1 = margin + ((annStart - bufferStartTime) / timeSpan) * plotW;
        const x2 = margin + ((annEnd - bufferStartTime) / timeSpan) * plotW;

        // Clip to plot area
        const clippedX1 = Math.max(x1, margin);
        const clippedX2 = Math.min(x2, w - rightMargin);
        if (clippedX2 <= clippedX1) continue;

        // Draw filled rectangle
        ctx.fillStyle = color;
        ctx.fillRect(clippedX1, topMargin, clippedX2 - clippedX1, plotH);

        // Draw label pill at top
        const label = ann.action.replace(/_/g, " ").toUpperCase();
        ctx.font = "bold 8px monospace";
        const textWidth = ctx.measureText(label).width;
        const pillX = clippedX1 + 2;
        const pillY = topMargin + 2;
        const pillW = textWidth + 6;
        const pillH = 12;

        if (pillX + pillW < clippedX2) {
          ctx.fillStyle = "rgba(0,0,0,0.7)";
          ctx.beginPath();
          ctx.roundRect(pillX, pillY, pillW, pillH, 3);
          ctx.fill();

          ctx.fillStyle = ANNOTATION_LABEL_COLORS[ann.action] ?? "#fff";
          ctx.textAlign = "left";
          ctx.fillText(label, pillX + 3, pillY + 9);
        }
      }
    }

    // Question-drop markers (behind signal trace)
    for (const marker of questionMarkersRef.current) {
      const mx = margin + ((marker.time - bufferStartTime) / timeSpan) * plotW;
      if (mx < margin || mx > w - rightMargin) continue;

      // Semi-transparent yellow zone (500ms = 5 data points at 10Hz)
      const zoneEnd =
        margin + ((marker.time + 5 - bufferStartTime) / timeSpan) * plotW;
      const clippedEnd = Math.min(zoneEnd, w - rightMargin);
      if (clippedEnd > mx) {
        ctx.fillStyle = "rgba(234,179,8,0.08)";
        ctx.fillRect(mx, topMargin, clippedEnd - mx, plotH);
      }

      // Yellow dashed vertical line
      ctx.beginPath();
      ctx.strokeStyle = "rgba(234,179,8,0.7)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.moveTo(mx, topMargin);
      ctx.lineTo(mx, topMargin + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label pill at top
      const qlabel = `Q${marker.turnNumber}: ${marker.label}…`;
      ctx.font = "bold 7px monospace";
      const qtw = ctx.measureText(qlabel).width;
      const qpx = mx + 2;
      const qpy = topMargin + plotH - 14;
      const qpw = qtw + 6;
      const qph = 11;
      if (qpx + qpw < w - rightMargin) {
        ctx.fillStyle = "rgba(0,0,0,0.75)";
        ctx.beginPath();
        ctx.roundRect(qpx, qpy, qpw, qph, 3);
        ctx.fill();
        ctx.fillStyle = "#eab308";
        ctx.textAlign = "left";
        ctx.fillText(qlabel, qpx + 3, qpy + 8);
      }
    }

    // Recording markers
    const markers = markersRef.current;
    for (let mi = 0; mi < markers.length; mi++) {
      const m = markers[mi];
      if (m.type !== "start") continue;
      // Find matching end (next end marker after this start)
      let endTime: number | null = null;
      for (let ej = mi + 1; ej < markers.length; ej++) {
        if (markers[ej].type === "end") {
          endTime = markers[ej].time;
          break;
        }
      }
      const useEndTime = endTime ?? counterRef.current;

      const sx = margin + ((m.time - bufferStartTime) / timeSpan) * plotW;
      const ex = margin + ((useEndTime - bufferStartTime) / timeSpan) * plotW;
      const clippedSx = Math.max(sx, margin);
      const clippedEx = Math.min(ex, w - rightMargin);

      // Semi-transparent green overlay between start and end
      if (clippedEx > clippedSx) {
        ctx.fillStyle = "rgba(34,197,94,0.1)";
        ctx.fillRect(clippedSx, topMargin, clippedEx - clippedSx, plotH);
      }

      // Green dashed vertical line at START
      if (sx >= margin && sx <= w - rightMargin) {
        ctx.beginPath();
        ctx.strokeStyle = "rgba(34,197,94,0.8)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.moveTo(sx, topMargin);
        ctx.lineTo(sx, topMargin + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Red dashed vertical line at END (if exists)
      if (endTime !== null) {
        const endX = margin + ((endTime - bufferStartTime) / timeSpan) * plotW;
        if (endX >= margin && endX <= w - rightMargin) {
          ctx.beginPath();
          ctx.strokeStyle = "rgba(239,68,68,0.8)";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          ctx.moveTo(endX, topMargin);
          ctx.lineTo(endX, topMargin + plotH);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    // Signal trace
    ctx.beginPath();
    ctx.strokeStyle = "rgba(196, 218, 242, 0.84)";
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.shadowColor = "rgba(128, 184, 230, 0.16)";
    ctx.shadowBlur = glow;

    let previous = buffer[0].raw;
    for (let i = 0; i < buffer.length; i++) {
      const raw = buffer[i].raw;
      const smoothed = previous + (raw - previous) * smoothAlpha;
      previous = smoothed;
      const x =
        margin + ((buffer[i].time - bufferStartTime) / timeSpan) * plotW;
      const normalized = (smoothed - yMin) / yRange;
      const y = topMargin + plotH * (1 - normalized);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Current value line (horizontal dashed)
    const latest = latestRef.current;
    if (latest > 0) {
      const latestNorm = (latest - yMin) / yRange;
      const latestY = topMargin + plotH * (1 - latestNorm);
      ctx.beginPath();
      ctx.strokeStyle = "rgba(170, 197, 225, 0.32)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.moveTo(margin, latestY);
      ctx.lineTo(w - rightMargin, latestY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Stats overlay (top-right)
    ctx.font = "10px monospace";
    ctx.textAlign = "right";

    // Current
    ctx.fillStyle = "rgba(226, 238, 251, 0.88)";
    ctx.fillText(`NOW ${formatSignal(latest)}`, w - rightMargin - 2, topMargin + 12);

    // Visible range
    ctx.fillStyle = "rgba(203, 221, 241, 0.78)";
    ctx.fillText(
      `RNG ${formatSignal(visMax - visMin)}`,
      w - rightMargin - 2,
      topMargin + 24,
    );

    // All-time min/max
    const atMin = allTimeMinRef.current;
    const atMax = allTimeMaxRef.current;
    if (atMin < Infinity) {
      ctx.fillStyle = "rgba(188, 205, 225, 0.72)";
      ctx.fillText(
        `MIN ${formatSignal(atMin)}`,
        w - rightMargin - 2,
        topMargin + 36,
      );
    }
    if (atMax > -Infinity) {
      ctx.fillStyle = "rgba(188, 205, 225, 0.72)";
      ctx.fillText(
        `MAX ${formatSignal(atMax)}`,
        w - rightMargin - 2,
        topMargin + 48,
      );
    }

    // Time labels along bottom (reflect visible window)
    ctx.fillStyle = "rgba(175, 194, 215, 0.74)";
    ctx.textAlign = "center";
    const visSeconds = timeSpan / POINTS_PER_SECOND;
    const offsetSeconds = offset / POINTS_PER_SECOND;
    const endLabel = offsetSeconds > 0 ? `-${Math.round(offsetSeconds)}s` : "now";
    const startLabel = `-${Math.round(visSeconds + offsetSeconds)}s`;
    const midLabel = `-${Math.round(visSeconds / 2 + offsetSeconds)}s`;
    ctx.fillText(startLabel, margin, h - 2);
    ctx.fillText(midLabel, margin + plotW / 2, h - 2);
    ctx.fillText(endLabel, w - rightMargin, h - 2);

    // Title
    ctx.font = "bold 10px monospace";
    ctx.fillStyle = "rgba(221, 235, 249, 0.82)";
    ctx.textAlign = "left";
    ctx.fillText("RAW SIGNAL", margin + 4, topMargin + 12);

    // Paused indicator
    if (pausedRef.current) {
      ctx.font = "bold 10px monospace";
      ctx.fillStyle = "rgba(250, 206, 84, 0.95)";
      ctx.textAlign = "center";
      ctx.fillText("PAUSED", w / 2, topMargin + 12);
    }

    animRef.current = requestAnimationFrame(draw);
  }, [softness]);

  // Animation loop
  useEffect(() => {
    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [draw]);


  const handleTogglePause = useCallback(() => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (!next) {
      // Unpause → resume recording, reset scroll to live edge
      viewOffsetRef.current = 0;
      viewWindowRef.current = 60 * POINTS_PER_SECOND; // reset zoom to default 60s
      dragRef.current = null;
    }
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!pausedRef.current) return;
    dragRef.current = { startX: e.clientX, startOffset: viewOffsetRef.current };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const plotW = canvas.width / dpr - 80 - 8; // margin - rightMargin
    const pointsPerPixel = viewWindowRef.current / plotW;
    const dx = e.clientX - dragRef.current.startX;
    const pointsDelta = Math.round(dx * pointsPerPixel);
    // Drag LEFT (dx<0) → see older data → offset increases (subtract dx)
    const maxOffset = Math.max(0, bufferRef.current.length - viewWindowRef.current);
    viewOffsetRef.current = clamp(dragRef.current.startOffset - pointsDelta, 0, maxOffset);
  }, []);

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const handleExport = useCallback(() => {
    const sessionAnchorMs = (() => {
      const sampleStart = bufferRef.current[0]?.timestampMs;
      if (sampleStart != null) return sampleStart;
      if (timelineMessagesRef.current.length > 0) {
        return parseTimestampMs(timelineMessagesRef.current[0].timestamp);
      }
      return Date.now();
    })();

    const signalTimeline = bufferRef.current.map((point) => ({
      index: point.time,
      sessionOffsetSec: (point.timestampMs - sessionAnchorMs) / 1000,
      timestamp: formatTimestamp(point.timestampMs),
      signal: point.raw,
      rawSignal: point.rawSignal,
      rawUnfiltered: point.rawUnfiltered,
      toneArm: point.toneArm ?? null,
      position: point.position ?? null,
      needleAction: point.needleAction ?? "idle",
      confidence: point.confidence ?? 0,
    }));

    const chatTimeline = timelineMessagesRef.current.map((entry) => {
      const timestampMs = parseTimestampMs(entry.timestamp);
      return {
        type: entry.speaker,
        role:
          entry.speaker === "auditor" && entry.questionDroppedAt
            ? "auditor-question"
            : entry.speaker === "pc"
              ? "pc-answer"
              : "auditor-message",
        turnNumber: entry.turnNumber,
        text: entry.text,
        sessionOffsetSec: (timestampMs - sessionAnchorMs) / 1000,
        timestamp: formatTimestamp(timestampMs),
        chargeScore: entry.chargeScore ?? null,
        bodyMovement: entry.bodyMovement ?? null,
        isAiGenerated: entry.isAiGenerated ?? false,
      };
    });

    const data = {
      exportedAt: new Date().toISOString(),
      pointsPerSecond: POINTS_PER_SECOND,
      sessionId: activeSessionIdRef.current,
      sessionAnchor: formatTimestamp(sessionAnchorMs),
      signal: {
        pointsPerSecond: POINTS_PER_SECOND,
        samples: signalTimeline,
      },
      timeline: {
        sessionMessages: chatTimeline,
        questionMarkers: questionMarkersRef.current.map((marker) => {
          const markerPoint = bufferRef.current.find((point) => point.time === marker.time);
          const markerTime = markerPoint?.timestampMs ?? sessionAnchorMs;
          return {
            ...marker,
            sessionOffsetSec: (markerTime - sessionAnchorMs) / 1000,
            timestamp: formatTimestamp(markerTime),
          };
        }),
        recordingMarkers: markersRef.current,
        annotations: annotationsRef.current,
      },
      annotations: annotationsRef.current,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mindscope-signal-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleClear = useCallback(() => {
    bufferRef.current = [];
    annotationsRef.current = [];
    questionMarkersRef.current = [];
    markersRef.current = [];
    counterRef.current = 0;
    allTimeMinRef.current = Infinity;
    allTimeMaxRef.current = -Infinity;
    latestRef.current = 0;
    viewOffsetRef.current = 0;
    viewWindowRef.current = 60 * POINTS_PER_SECOND;
    if (pausedRef.current) {
      pausedRef.current = false;
      setPaused(false);
    }
    setCanMarkEnd(false);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd + scroll = zoom
      e.preventDefault();
      const zoomFactor = e.deltaY > 0 ? 1.2 : 0.8; // scroll down = zoom out
      const newWindow = clamp(
        Math.round(viewWindowRef.current * zoomFactor),
        5 * POINTS_PER_SECOND,                   // min 5s
        BUFFER_SECONDS * POINTS_PER_SECOND,       // max full buffer
      );
      viewWindowRef.current = newWindow;
      // Auto-pause when zooming
      if (!pausedRef.current) {
        pausedRef.current = true;
        setPaused(true);
      }
    } else if (pausedRef.current) {
      // Regular scroll when paused = pan left/right
      e.preventDefault();
      const panAmount = Math.round(viewWindowRef.current * 0.1); // 10% of view per scroll tick
      const delta = e.deltaY > 0 ? -panAmount : panAmount; // scroll down = pan forward (newer)
      const maxOffset = Math.max(0, bufferRef.current.length - viewWindowRef.current);
      viewOffsetRef.current = clamp(viewOffsetRef.current + delta, 0, maxOffset);
    }
  }, []);

  const annotationButtonLabel = showAnnotations ? "Annotations On" : "Annotations Off";
  const pauseButtonLabel = paused ? "Play" : "Pause";

  const toolbarButtonClass = "ms-signal-btn h-11 w-11 px-0";

  return (
      <div
        className={`w-full ms-panel relative overflow-hidden ${
        expanded ? "h-[560px]" : "flex-1 min-h-0"
      }`}
    >
      <div className="relative flex h-full flex-col">
        <div className="relative flex-1 min-h-0">
          <canvas
            ref={canvasRef}
            className="w-full h-full"
            style={{ cursor: paused ? (dragRef.current ? "grabbing" : "grab") : "default" }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onWheel={handleWheel}
          />
        </div>

        <div className="ms-signal-toolbar">
          <div className="ms-signal-toolbar-group">
            <button
              onClick={onToggleAnnotations}
              className={`${toolbarButtonClass} ${
                showAnnotations ? "bg-emerald-600 text-white border-emerald-300/50" : ""
              }`}
              title={annotationButtonLabel}
              aria-label={annotationButtonLabel}
            >
              {showAnnotations ? (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-5 h-5"
                >
                  <path d="m21 15-5 5-5-5" />
                  <path d="m21 9-5-5-5 5" />
                  <path d="M9 9H4V7a2 2 0 0 1 2-2h3" />
                  <path d="M9 15h5v2a2 2 0 0 1-2 2H4" />
                </svg>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-5 h-5"
                >
                  <path d="m21 15-5 5-5-5" />
                  <path d="m21 9-5-5-5 5" />
                  <line x1="7" y1="12" x2="4" y2="12" />
                  <line x1="10" y1="12" x2="21" y2="12" />
                </svg>
              )}
            </button>

            {!canMarkEnd && (
              <button
                onClick={() => {
                  markersRef.current.push({ type: "start", time: counterRef.current });
                  setCanMarkEnd(true);
                }}
                className={`${toolbarButtonClass} bg-emerald-700 text-white border-emerald-300/50`}
                title="Mark Start"
                aria-label="Mark Start"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-5 h-5"
                >
                  <circle cx="12" cy="12" r="9" />
                  <polygon points="10 8 16 12 10 16 10 8" />
                </svg>
              </button>
            )}
            {canMarkEnd && (
              <button
                onClick={() => {
                  markersRef.current.push({ type: "end", time: counterRef.current });
                  setCanMarkEnd(false);
                }}
                className={`${toolbarButtonClass} bg-red-700 text-white border-red-300/50`}
                title="Mark End"
                aria-label="Mark End"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-5 h-5"
                >
                  <circle cx="12" cy="12" r="9" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                </svg>
              </button>
            )}

            <button
              onClick={() => setShowSettings((open) => !open)}
              className={`${toolbarButtonClass} ${showSettings ? "bg-cyan-700 text-white border-cyan-300/50" : ""}`}
              title="Settings"
              aria-label="Settings"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-5 h-5"
              >
                <circle cx="12" cy="12" r="3.2" />
                <path d="M12 2.8v2.3M12 18.9v2.3M4.8 12h2.3M16.9 12h2.3M6 6l1.6 1.6M16.4 16.4l1.6 1.6M18 6l-1.6 1.6M7.6 16.4L6 18" />
              </svg>
            </button>

            <button
              onClick={handleExport}
              className={toolbarButtonClass}
              title="Export signal data as JSON"
              aria-label="Export signal data"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-5 h-5"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>

            <button
              onClick={handleTogglePause}
              className={`${toolbarButtonClass} ${paused ? "bg-amber-600 text-white border-amber-200/50" : ""}`}
              title={pauseButtonLabel}
              aria-label={pauseButtonLabel}
            >
              {paused ? (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-5 h-5"
                >
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-5 h-5"
                >
                  <rect x="6" y="4" width="4" height="16" />
                  <rect x="14" y="4" width="4" height="16" />
                </svg>
              )}
            </button>

            <button
              onClick={onToggleExpand}
              className={toolbarButtonClass}
              title={expanded ? "Collapse" : "Expand"}
              aria-label={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-5 h-5"
                >
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-5 h-5"
                >
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              )}
            </button>
          </div>

          <button
            onClick={handleClear}
            className={`${toolbarButtonClass} bg-red-700/80 text-white border-red-300/40`}
            title="Clear all signal data"
            aria-label="Clear all signal data"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
                className="w-5 h-5"
            >
              <path d="M4.5 7h15" />
              <path d="M9.2 7V5.4a1.4 1.4 0 0 1 1.4-1.4h2.8a1.4 1.4 0 0 1 1.4 1.4V7" />
              <rect x="6.3" y="7" width="11.4" height="13" rx="2.1" />
              <path d="M10.2 10.7v6.2M13.8 10.7v6.2" />
            </svg>
          </button>
        </div>
      </div>

      {showSettings && (
        <div className="absolute top-2 right-2 z-10 w-56 ms-modal-shell text-gray-200 p-3">
          <p className="text-[10px] font-semibold tracking-wide text-gray-400 mb-2">
            Raw Signal Settings
          </p>
          <label className="block">
            <span className="text-[10px] text-gray-400">Softness</span>
            <input
              type="range"
              min={0}
              max={100}
              value={softness}
              onChange={(e) => setSoftness(Number(e.target.value))}
              className="mt-1 block w-full ms-slider"
            />
          </label>
          <p className="text-[9px] text-gray-500 mt-1 text-right">{softness}%</p>
        </div>
      )}
    </div>
  );
}
