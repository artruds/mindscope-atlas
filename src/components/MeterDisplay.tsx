import { useCallback, useEffect, useRef, useState } from "react";
import type { WSMessage } from "../types/messages";
import {
  ARC_MAX,
  ARC_MIN,
  SET_ANGLE,
  useMeterSignal,
} from "../hooks/useMeterSignal";
import { degToRad } from "../utils";

interface MeterDisplayProps {
  subscribe: (type: string, handler: (msg: WSMessage) => void) => () => void;
  sensitivity: number;
  toneArm: number;
  smoothing: number;
  onSensitivityChange: (v: number) => void;
  onToneArmChange: (v: number) => void;
  onSmoothingChange: (v: number) => void;
}

const SENSITIVITY_STEPS = [1, 2, 4, 8, 16, 32, 64, 128];
const SMOOTHING_STEPS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const TONE_ARM_STEPS = Array.from({ length: 31 }, (_, i) => Number((i * 0.2).toFixed(1)));

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
  const animRef = useRef<number>(0);
  const {
    displayedAngleRef,
    computeFrame,
    hwConnected,
    samples,
    rawSignalDisplay,
    needleAction,
    taMotion,
    handleSetDown,
    handleSetUp,
    handleSetCancel,
  } = useMeterSignal(subscribe, sensitivity, toneArm, smoothing, onToneArmChange);

  const adjustSensitivity = useCallback((delta: number) => {
    const idx = SENSITIVITY_STEPS.findIndex((value) => value >= sensitivity);
    const safeIdx = idx === -1 ? SENSITIVITY_STEPS.length - 1 : idx;
    const nextIdx = Math.max(0, Math.min(SENSITIVITY_STEPS.length - 1, safeIdx + delta));
    const next = SENSITIVITY_STEPS[nextIdx];
    onSensitivityChange(next);
  }, [sensitivity, onSensitivityChange]);

  const adjustSmoothing = useCallback((delta: number) => {
    const idx = SMOOTHING_STEPS.findIndex((value) => value >= smoothing);
    const safeIdx = idx === -1 ? SMOOTHING_STEPS.length - 1 : idx;
    const nextIdx = Math.max(0, Math.min(SMOOTHING_STEPS.length - 1, safeIdx + delta));
    const next = SMOOTHING_STEPS[nextIdx];
    onSmoothingChange(next);
  }, [smoothing, onSmoothingChange]);

  const adjustToneArm = useCallback((delta: number) => {
    const idx = TONE_ARM_STEPS.findIndex((value) => value >= toneArm);
    const safeIdx = idx === -1 ? TONE_ARM_STEPS.length - 1 : idx;
    const nextIdx = Math.max(0, Math.min(TONE_ARM_STEPS.length - 1, safeIdx + delta));
    const next = TONE_ARM_STEPS[nextIdx];
    onToneArmChange(next);
  }, [toneArm, onToneArmChange]);

  const [setHolding, setSetHolding] = useState(false);
  const [calibratedFlash, setCalibratedFlash] = useState(false);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onSetDown = useCallback(() => {
    handleSetDown();
    setSetHolding(true);
    holdTimerRef.current = setTimeout(() => {
      setSetHolding(false);
      setCalibratedFlash(true);
      flashTimerRef.current = setTimeout(() => setCalibratedFlash(false), 1200);
    }, 2000);
  }, [handleSetDown]);

  const onSetUp = useCallback(() => {
    handleSetUp();
    setSetHolding(false);
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, [handleSetUp]);

  const onSetLeave = useCallback(() => {
    handleSetCancel();
    setSetHolding(false);
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, [handleSetCancel]);

  useEffect(() => {
    return () => {
      if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
    };
  }, []);

  const draw = useCallback(() => {
    computeFrame();

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Canvas sizing (use CSS dimensions)
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement?.getBoundingClientRect() ?? canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const measuredH = rect.height > 0 ? rect.height : rect.width * 0.58;
    const h = Math.max(300, Math.min(560, Math.floor(measuredH)));

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // Clear
    ctx.clearRect(0, 0, w, h);

    const frameInset = 2;
    const frameX = frameInset;
    const frameY = frameInset;
    const frameW = w - frameInset * 2;
    const frameH = h - frameInset * 2;

    // Background shell
    const bg = ctx.createLinearGradient(0, 0, w, 0);
    bg.addColorStop(0, "#030b20");
    bg.addColorStop(0.5, "#030816");
    bg.addColorStop(1, "#02050f");
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(frameX, frameY, frameW, frameH, 12);
    ctx.fill();

    // Subtle inner frame
    ctx.strokeStyle = "rgba(90, 216, 217, 0.22)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.roundRect(frameX + 1.5, frameY + 1.5, frameW - 3, frameH - 3, 11);
    ctx.stroke();

    const edgePadding = 18;
    const paintPadding = 14;
    const maxNeedleStroke = 14;
    const margin = Math.max(12, paintPadding + 2);
    const cx = w / 2;
    // Keep the needle origin further below the frame so less lower needle is visible.
    const pivotY = h + Math.max(56, h * 0.15);
    const arcAngleCosLimit = Math.max(
      Math.abs(Math.cos(degToRad(ARC_MIN - 90))),
      Math.abs(Math.cos(degToRad(ARC_MAX - 90))),
    );
    const arcRadiusByWidth = (w - 2 * edgePadding) / (2 * arcAngleCosLimit);
    // Hard-cap by top clearance so the upper arc never clips and has clear breathing room.
    const topHeadspace = 44;
    const arcRadiusByTop = pivotY - (frameY + topHeadspace);
    const arcRadius = Math.max(56, Math.min(arcRadiusByWidth * 0.95, arcRadiusByTop) - 4);
    const needleLen = Math.max(20, arcRadius - maxNeedleStroke);
    const arcCenterY = pivotY;

    // Keep any anti-aliasing overhang from bleeding outside the frame.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(frameX + 0.5, frameY + 0.5, frameW - 1, frameH - 1, 11);
    ctx.clip();

    // Thin full guide arc
    ctx.beginPath();
    ctx.arc(cx, arcCenterY, arcRadius, degToRad(ARC_MIN - 90), degToRad(ARC_MAX - 90));
    ctx.strokeStyle = "rgba(206, 214, 227, 0.65)";
    ctx.lineWidth = 3.2;
    ctx.lineCap = "round";
    ctx.stroke();

    // Main highlighted arc (clean white sweep, like the reference)
    ctx.beginPath();
    ctx.arc(cx, arcCenterY, arcRadius, degToRad(ARC_MIN - 90), degToRad(14 - 90));
    ctx.strokeStyle = "rgba(233, 239, 249, 0.95)";
    ctx.lineWidth = 14;
    ctx.lineCap = "round";
    ctx.stroke();

    // Ticks
    for (let deg = ARC_MIN; deg <= ARC_MAX; deg += 5) {
      const isMajor = deg % 10 === 0;
      const rad = degToRad(deg - 90);
      const innerR = arcRadius - (isMajor ? 42 : 28);
      const outerR = arcRadius - 16;

      ctx.beginPath();
      ctx.moveTo(cx + innerR * Math.cos(rad), arcCenterY + innerR * Math.sin(rad));
      ctx.lineTo(cx + outerR * Math.cos(rad), arcCenterY + outerR * Math.sin(rad));
      ctx.strokeStyle = isMajor ? "rgba(218, 225, 236, 0.86)" : "rgba(170, 181, 199, 0.7)";
      ctx.lineWidth = isMajor ? 5 : 2.8;
      ctx.lineCap = "round";
      ctx.stroke();
    }

    // Labels
    ctx.textAlign = "center";
    ctx.font = "600 16px Sora, 'Avenir Next', sans-serif";
    ctx.fillStyle = "rgba(202, 213, 227, 0.9)";
    const labelR = Math.max(30, arcRadius - Math.max(48, margin * 3.2));
    const riseRad = degToRad(-43 - 90);
    const setRad = degToRad(SET_ANGLE - 90);
    const fallRad = degToRad(31 - 90);
    const testRad = degToRad(56 - 90);
    ctx.fillText("RISE", cx + labelR * Math.cos(riseRad), arcCenterY + labelR * Math.sin(riseRad));
    ctx.fillText("SET", cx + labelR * Math.cos(setRad), arcCenterY + labelR * Math.sin(setRad));
    ctx.fillText("FALL", cx + labelR * Math.cos(fallRad), arcCenterY + labelR * Math.sin(fallRad));
    ctx.fillText("TEST", cx + labelR * Math.cos(testRad), arcCenterY + labelR * Math.sin(testRad));

    // Needle
    const needleRad = degToRad(displayedAngleRef.current - 90);
    const x2 = cx + needleLen * Math.cos(needleRad);
    const y2 = pivotY + needleLen * Math.sin(needleRad);

    ctx.beginPath();
    ctx.moveTo(cx + 6, pivotY + 2);
    ctx.lineTo(x2 + 6, y2 + 2);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.42)";
    ctx.lineWidth = 12;
    ctx.lineCap = "round";
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx, pivotY);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = "#d9e0ec";
    ctx.lineWidth = 11;
    ctx.lineCap = "round";
    ctx.stroke();

    // Needle spine highlight
    ctx.beginPath();
    ctx.moveTo(cx - 2.3, pivotY - 0.4);
    ctx.lineTo(x2 - 2.3, y2 - 0.4);
    ctx.strokeStyle = "rgba(247, 250, 255, 0.92)";
    ctx.lineWidth = 3.2;
    ctx.lineCap = "round";
    ctx.stroke();

    // Pivot
    if (pivotY < h - 6) {
      ctx.beginPath();
      ctx.arc(cx, pivotY, 10, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(188, 199, 216, 0.94)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, pivotY, 4, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(230, 236, 246, 0.98)";
      ctx.fill();
    }

    // Top readouts
    const labelSize = Math.max(11, Math.min(14, w * 0.02));
    const readoutSize = Math.max(34, Math.min(74, w * 0.086));
    const readoutTop = Math.max(18, h * 0.09);
    const readoutY = Math.max(readoutTop + readoutSize, Math.min(h * 0.34, h - margin - 10));
    const labelY = Math.max(14, readoutTop - 7);

    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(176, 184, 203, 0.9)";
    ctx.font = `600 ${labelSize}px Sora, 'Avenir Next', sans-serif`;
    ctx.fillText("TA", margin, labelY);
    ctx.fillStyle = "#e5ebf5";
    ctx.font = `600 ${readoutSize}px Sora, 'Avenir Next', sans-serif`;
    ctx.fillText(toneArm.toFixed(1), margin, readoutY);

    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(176, 184, 203, 0.9)";
    ctx.font = `600 ${labelSize}px Sora, 'Avenir Next', sans-serif`;
    ctx.fillText("SENS", w - margin, labelY);
    ctx.fillStyle = "#e5ebf5";
    ctx.font = `600 ${readoutSize}px Sora, 'Avenir Next', sans-serif`;
    ctx.fillText(String(sensitivity), w - margin, readoutY);

    // Very subtle action text only
    const action = needleAction ?? "idle";
    ctx.textAlign = "center";
    ctx.font = "600 10px Sora, 'Avenir Next', sans-serif";
    ctx.fillStyle = "rgba(170, 180, 197, 0.45)";
    ctx.fillText(action.replace(/_/g, " ").toUpperCase(), cx, h - 14);

    ctx.restore();

    animRef.current = requestAnimationFrame(draw);
  }, [sensitivity, toneArm, smoothing]);

  // Animation loop
  useEffect(() => {
    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [draw]);

  return (
    <div className="w-full h-full flex flex-col ms-panel overflow-hidden">
      {/* Canvas */}
      <div className="px-0.5 pt-0.5 flex-1 min-h-0">
        <div className="meter-canvas-wrap">
          <canvas ref={canvasRef} className="w-full h-full" />
        </div>
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
      <div className="px-3 pb-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-stretch">
          <div className="grid grid-cols-3 gap-2 flex-1">
            <div className="rounded-md border border-cyan-300/20 bg-black/15 px-2 py-1.5">
              <div className="text-[10px] text-gray-500 text-center tracking-[0.12em]">SENS</div>
              <div className="flex items-center justify-between mt-1">
                <button className="ms-mini-btn px-2.5 py-1.5" onClick={() => adjustSensitivity(-1)} aria-label="Decrease sensitivity">-</button>
                <span className="text-white text-2xl font-semibold tabular-nums">{sensitivity}</span>
                <button className="ms-mini-btn px-2.5 py-1.5" onClick={() => adjustSensitivity(1)} aria-label="Increase sensitivity">+</button>
              </div>
            </div>

            <div className="rounded-md border border-cyan-300/20 bg-black/15 px-2 py-1.5">
              <div className="text-[10px] text-gray-500 text-center tracking-[0.12em]">SMTH</div>
              <div className="flex items-center justify-between mt-1">
                <button className="ms-mini-btn px-2.5 py-1.5" onClick={() => adjustSmoothing(-1)} aria-label="Decrease smoothing">-</button>
                <span className="text-white text-2xl font-semibold tabular-nums">{smoothing}%</span>
                <button className="ms-mini-btn px-2.5 py-1.5" onClick={() => adjustSmoothing(1)} aria-label="Increase smoothing">+</button>
              </div>
            </div>

            <div className="rounded-md border border-cyan-300/20 bg-black/15 px-2 py-1.5">
              <div className="text-[10px] text-gray-500 text-center tracking-[0.12em]">TONE</div>
              <div className="flex items-center justify-between mt-1">
                <button className="ms-mini-btn px-2.5 py-1.5" onClick={() => adjustToneArm(-1)} aria-label="Decrease tone arm">-</button>
                <span className="text-white text-2xl font-semibold tabular-nums">{toneArm.toFixed(1)}</span>
                <button className="ms-mini-btn px-2.5 py-1.5" onClick={() => adjustToneArm(1)} aria-label="Increase tone arm">+</button>
              </div>
            </div>
          </div>

          <button
            onMouseDown={onSetDown}
            onMouseUp={onSetUp}
            onMouseLeave={onSetLeave}
            onTouchStart={(e) => { e.preventDefault(); onSetDown(); }}
            onTouchEnd={(e) => { e.preventDefault(); onSetUp(); }}
            onTouchCancel={onSetLeave}
            onContextMenu={(e) => e.preventDefault()}
            className={`ms-btn ms-btn-emerald py-2 lg:min-w-[9.5rem] lg:px-6 transition-all duration-150 select-none${
              setHolding ? " scale-105 brightness-125" : ""
            }${calibratedFlash ? " ring-2 ring-emerald-400" : ""}`}
          >
            {calibratedFlash ? "CALIBRATED" : "SET"}
          </button>
        </div>
      </div>
    </div>
  );
}
