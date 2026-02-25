import { useEffect, useRef, useCallback, useState } from "react";
import { MessageType } from "../types/messages";
import type { MeterEventData, TAMotionData, WSMessage } from "../types/messages";

interface MeterDisplayProps {
  subscribe: (type: string, handler: (msg: WSMessage) => void) => () => void;
  sensitivity: number;
  toneArm: number;
  smoothing: number;
  onSensitivityChange: (v: number) => void;
  onToneArmChange: (v: number) => void;
  onSmoothingChange: (v: number) => void;
}

// Physics constants
const SET_ANGLE = -12; // degrees — the "SET" position
const ARC_MIN = -65;
const ARC_MAX = 65;
const TA_SCALE = 10;
// Converts raw ADC delta to degrees: degrees = delta * sensitivity * RAW_SCALE
// Tuned so that at sensitivity=16, a ~30K ADC change ≈ 25° deflection
const RAW_SCALE = 0.00005;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export default function MeterDisplay({
  subscribe,
  sensitivity,
  toneArm,
  smoothing,
  onSensitivityChange,
  onToneArmChange,
  onSmoothingChange,
}: MeterDisplayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dataRef = useRef<MeterEventData | null>(null);
  const rawBaselineRef = useRef<number | null>(null); // SET reference in raw ADC units
  const displayedAngleRef = useRef(SET_ANGLE);
  const animRef = useRef<number>(0);
  const [hwConnected, setHwConnected] = useState(false);
  const [samples, setSamples] = useState(0);
  const [rawSignalDisplay, setRawSignalDisplay] = useState(0);
  const [needleAction, setNeedleAction] = useState("idle");
  const [taMotion, setTaMotion] = useState<TAMotionData | null>(null);

  // Subscribe to meter events
  useEffect(() => {
    return subscribe(MessageType.METER_EVENT, (msg: WSMessage) => {
      const d = msg.data as unknown as MeterEventData;
      dataRef.current = d;
      setHwConnected(d.hardwareConnected ?? false);
      setSamples(d.samplesReceived ?? 0);
      setRawSignalDisplay(d.rawSignal ?? 0);
      setNeedleAction(d.needleAction ?? "idle");
      if (d.taMotion) setTaMotion(d.taMotion);

      // Auto-capture first raw signal as baseline (so needle starts at SET)
      const raw = d.rawSignal ?? 0;
      if (rawBaselineRef.current === null && raw > 0) {
        rawBaselineRef.current = raw;
      }
    });
  }, [subscribe]);

  const handleSet = useCallback(() => {
    const raw = dataRef.current?.rawSignal ?? 0;
    if (raw > 0) {
      rawBaselineRef.current = raw;          // reset baseline
      onToneArmChange(2.0);                  // reset TA to neutral
      displayedAngleRef.current = SET_ANGLE; // snap needle to SET
    }
  }, [onToneArmChange]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const data = dataRef.current;
    const smoothed = data?.rawSignal ?? rawBaselineRef.current ?? 0;
    const unfiltered = data?.rawUnfiltered ?? smoothed;
    const baseline = rawBaselineRef.current ?? smoothed;

    // Blend between raw and smoothed signal based on smoothing setting (0-100)
    const blend = smoothing / 100;
    const raw = unfiltered + (smoothed - unfiltered) * blend;

    // Per-frame physics: needle follows raw signal (inverted)
    // Squeeze → raw drops → delta positive → needle goes right (FALL)
    // Release → raw rises → delta negative → needle goes left (RISE)
    const delta = baseline - raw;
    const amplifiedDelta = delta * sensitivity * RAW_SCALE;
    const taOffset = (toneArm - 2.0) * TA_SCALE;
    const targetAngle = SET_ANGLE + amplifiedDelta + taOffset;
    const clamped = clamp(targetAngle, ARC_MIN, ARC_MAX);
    // Damping: 0.02 (snappy) at smoothing=0 → 0.25 (smooth) at smoothing=100
    const damping = 0.02 + blend * 0.23;
    displayedAngleRef.current +=
      (clamped - displayedAngleRef.current) * damping;

    const displayedAngle = displayedAngleRef.current;

    // Canvas sizing (use CSS dimensions)
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement!.getBoundingClientRect();
    const w = rect.width;
    const h = rect.width * 0.65; // aspect ratio for meter face

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.scale(dpr, dpr);
    }

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = "#0a0a0f";
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 8);
    ctx.fill();

    const cx = w / 2;
    const pivotY = h - 20;
    const needleLen = h * 0.72;

    // Draw arc with color zones
    const arcRadius = needleLen + 8;
    const arcCenterY = pivotY;

    // Color zones (angles from vertical, negative = left/rise, positive = right/fall)
    const zones = [
      { from: ARC_MIN, to: -35, color: "#ef4444" }, // extreme rise (red)
      { from: -35, to: -20, color: "#eab308" }, // moderate rise (yellow)
      { from: -20, to: -5, color: "#22c55e" }, // near SET (green)
      { from: -5, to: 10, color: "#22c55e" }, // SET zone (green)
      { from: 10, to: 30, color: "#eab308" }, // moderate fall (yellow)
      { from: 30, to: 50, color: "#ef4444" }, // fall (red)
      { from: 50, to: ARC_MAX, color: "#dc2626" }, // extreme fall (dark red)
    ];

    for (const zone of zones) {
      const startRad = degToRad(zone.from - 90);
      const endRad = degToRad(zone.to - 90);
      ctx.beginPath();
      ctx.arc(cx, arcCenterY, arcRadius, startRad, endRad);
      ctx.strokeStyle = zone.color;
      ctx.lineWidth = 4;
      ctx.globalAlpha = 0.3;
      ctx.stroke();
      ctx.globalAlpha = 1.0;
    }

    // Tick marks at 5° intervals
    for (let deg = ARC_MIN; deg <= ARC_MAX; deg += 5) {
      const isMajor = deg % 10 === 0;
      const rad = degToRad(deg - 90);
      const innerR = arcRadius - (isMajor ? 14 : 8);
      const outerR = arcRadius - 2;

      ctx.beginPath();
      ctx.moveTo(
        cx + innerR * Math.cos(rad),
        arcCenterY + innerR * Math.sin(rad),
      );
      ctx.lineTo(
        cx + outerR * Math.cos(rad),
        arcCenterY + outerR * Math.sin(rad),
      );
      ctx.strokeStyle = isMajor ? "#6b7280" : "#374151";
      ctx.lineWidth = isMajor ? 1.5 : 0.8;
      ctx.stroke();
    }

    // Labels along the arc
    ctx.font = "bold 10px monospace";
    ctx.textAlign = "center";
    const labelR = arcRadius - 22;

    // RISE (left side)
    const riseRad = degToRad(-40 - 90);
    ctx.fillStyle = "#ef4444";
    ctx.fillText(
      "RISE",
      cx + labelR * Math.cos(riseRad),
      arcCenterY + labelR * Math.sin(riseRad),
    );

    // SET (center-left, near SET_ANGLE)
    const setRad = degToRad(SET_ANGLE - 90);
    ctx.fillStyle = "#22c55e";
    ctx.fillText(
      "SET",
      cx + labelR * Math.cos(setRad),
      arcCenterY + labelR * Math.sin(setRad),
    );

    // FALL (right side)
    const fallRad = degToRad(30 - 90);
    ctx.fillStyle = "#eab308";
    ctx.fillText(
      "FALL",
      cx + labelR * Math.cos(fallRad),
      arcCenterY + labelR * Math.sin(fallRad),
    );

    // TEST (far right)
    const testRad = degToRad(55 - 90);
    ctx.fillStyle = "#ef4444";
    ctx.fillText(
      "TEST",
      cx + labelR * Math.cos(testRad),
      arcCenterY + labelR * Math.sin(testRad),
    );

    // Needle shadow
    const needleRad = degToRad(displayedAngle - 90);
    ctx.beginPath();
    ctx.moveTo(cx + 2, pivotY + 2);
    ctx.lineTo(
      cx + 2 + needleLen * Math.cos(needleRad),
      pivotY + 2 + needleLen * Math.sin(needleRad),
    );
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.stroke();

    // Needle
    ctx.beginPath();
    ctx.moveTo(cx, pivotY);
    ctx.lineTo(
      cx + needleLen * Math.cos(needleRad),
      pivotY + needleLen * Math.sin(needleRad),
    );
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.stroke();

    // Pivot dot
    ctx.beginPath();
    ctx.arc(cx, pivotY, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#6b7280";
    ctx.fill();

    // Digital readouts
    // TA (top-left)
    ctx.font = "10px monospace";
    ctx.fillStyle = "#6b7280";
    ctx.textAlign = "left";
    ctx.fillText("TA", 12, 18);
    ctx.font = "bold 20px monospace";
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText(toneArm.toFixed(1), 12, 40);

    // SENS (top-right)
    ctx.font = "10px monospace";
    ctx.fillStyle = "#6b7280";
    ctx.textAlign = "right";
    ctx.fillText("SENS", w - 12, 18);
    ctx.font = "bold 20px monospace";
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText(String(sensitivity), w - 12, 40);

    // Needle action (bottom center)
    const action = data?.needleAction ?? "idle";
    ctx.font = "bold 11px monospace";
    ctx.fillStyle = "#9ca3af";
    ctx.textAlign = "center";
    ctx.fillText(action.replace(/_/g, " ").toUpperCase(), cx, h - 4);

    animRef.current = requestAnimationFrame(draw);
  }, [sensitivity, toneArm, smoothing]);

  // Animation loop
  useEffect(() => {
    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [draw]);

  return (
    <div className="w-full h-full flex flex-col bg-gray-950 rounded-lg border border-gray-800">
      {/* Canvas */}
      <div className="flex-1 min-h-0 p-2">
        <canvas ref={canvasRef} className="w-full" />
      </div>

      {/* Status bar */}
      <div className="px-3 pb-1 space-y-0.5">
        <div className="flex items-center justify-between text-[10px] font-mono">
          {/* Connection status */}
          <div className="flex items-center gap-1.5">
            <div
              className={`w-2 h-2 rounded-full ${
                hwConnected ? "bg-emerald-400" : "bg-amber-400"
              }`}
            />
            <span className={hwConnected ? "text-emerald-400" : "text-amber-400"}>
              {hwConnected ? "HARDWARE" : "SIMULATOR"}
            </span>
          </div>

          {/* Raw signal */}
          <span className="text-gray-400">
            SIG {rawSignalDisplay >= 1_000_000
              ? (rawSignalDisplay / 1_000_000).toFixed(3) + "M"
              : rawSignalDisplay >= 1_000
                ? (rawSignalDisplay / 1_000).toFixed(1) + "k"
                : rawSignalDisplay.toFixed(0)}
          </span>

          {/* Needle action */}
          <span className="text-gray-500">
            {needleAction.replace(/_/g, " ").toUpperCase()}
          </span>

          {/* Sample count */}
          <span className="text-gray-600">
            {samples > 0 ? `${(samples / 1000).toFixed(1)}k` : "0"} samples
          </span>
        </div>

        {/* TA Motion */}
        {taMotion && (taMotion.totalDownMotion > 0 || taMotion.totalUpMotion > 0) && (
          <div className="flex items-center justify-between text-[10px] font-mono">
            <span className="text-emerald-400">
              TA Motion ↓ {taMotion.totalDownMotion.toFixed(2)}
            </span>
            <span className="text-blue-400">
              ↑ {taMotion.totalUpMotion.toFixed(2)}
            </span>
            <span className={taMotion.netMotion >= 0 ? "text-blue-300" : "text-emerald-300"}>
              Net: {taMotion.netMotion >= 0 ? "+" : ""}{taMotion.netMotion.toFixed(2)}
            </span>
            <span className="text-gray-500">
              Start {taMotion.startTA.toFixed(1)} → {taMotion.currentTA.toFixed(1)}
            </span>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="px-3 pb-3 space-y-2">
        {/* Sensitivity slider */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 w-10">SENS</span>
          <input
            type="range"
            min={1}
            max={128}
            value={sensitivity}
            onChange={(e) => onSensitivityChange(Number(e.target.value))}
            className="flex-1 h-1 accent-indigo-500"
          />
          <span className="text-xs text-white font-mono w-8 text-right">
            {sensitivity}
          </span>
        </div>

        {/* Smoothing slider */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 w-10">SMOOTH</span>
          <input
            type="range"
            min={0}
            max={100}
            value={smoothing}
            onChange={(e) => onSmoothingChange(Number(e.target.value))}
            className="flex-1 h-1 accent-indigo-500"
          />
          <span className="text-xs text-white font-mono w-8 text-right">
            {smoothing}%
          </span>
        </div>

        {/* Tone Arm slider */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 w-10">TA</span>
          <input
            type="range"
            min={0}
            max={6}
            step={0.1}
            value={toneArm}
            onChange={(e) => onToneArmChange(Number(e.target.value))}
            className="flex-1 h-1 accent-indigo-500"
          />
          <span className="text-xs text-white font-mono w-6 text-right">
            {toneArm.toFixed(1)}
          </span>
        </div>

        {/* SET button */}
        <button
          onClick={handleSet}
          className="w-full bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-bold py-1.5 rounded transition-colors"
        >
          SET
        </button>
      </div>
    </div>
  );
}
