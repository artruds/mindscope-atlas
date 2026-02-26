import { useCallback, useEffect, useRef, useState } from "react";
import { MessageType } from "../types/messages";
import type { MeterEventData, TAMotionData, WSMessage } from "../types/messages";

export const SET_ANGLE = -12;
export const ARC_MIN = -65;
export const ARC_MAX = 65;
export const TA_SCALE = 10;
export const RAW_SCALE = 0.002;
export const POSITION_SCALE = 130;

const POSITION_CENTER = 0.5;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isValidNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasValidPosition(value: unknown): value is number {
  return isValidNumber(value) && value >= 0 && value <= 1;
}

export interface MeterSignalOutput {
  displayedAngle: number;
  hwConnected: boolean;
  samples: number;
  rawSignalDisplay: number;
  needleAction: string;
  taMotion: TAMotionData | null;
  dataRef: React.RefObject<MeterEventData | null>;
  rawBaselineRef: React.RefObject<number | null>;
  handleSet: () => void;
}

export function useMeterSignal(
  subscribe: (type: string, handler: (msg: WSMessage) => void) => () => void,
  sensitivity: number,
  toneArm: number,
  smoothing: number,
): MeterSignalOutput {
  const dataRef = useRef<MeterEventData | null>(null);
  const rawBaselineRef = useRef<number | null>(null);
  const positionBaselineRef = useRef<number | null>(null);
  const displayedAngleRef = useRef(SET_ANGLE);
  const animRef = useRef<number>(0);
  const [displayedAngle, setDisplayedAngle] = useState(SET_ANGLE);
  const [hwConnected, setHwConnected] = useState(false);
  const [samples, setSamples] = useState(0);
  const [rawSignalDisplay, setRawSignalDisplay] = useState(0);
  const [needleAction, setNeedleAction] = useState("idle");
  const [taMotion, setTaMotion] = useState<TAMotionData | null>(null);

  useEffect(() => {
    return subscribe(MessageType.METER_EVENT, (msg: WSMessage) => {
      const d = msg.data as unknown as MeterEventData;
      dataRef.current = d;
      setHwConnected(d.hardwareConnected ?? false);
      setSamples(d.samplesReceived ?? 0);
      setRawSignalDisplay(d.rawSignal ?? 0);
      setNeedleAction(d.needleAction ?? "idle");
      if (d.taMotion) {
        setTaMotion(d.taMotion);
      }

      const hasPosition = hasValidPosition(d.position);

      if (hasPosition && positionBaselineRef.current === null) {
        positionBaselineRef.current = d.position;
      }

      const raw = d.rawSignal;
      if (rawBaselineRef.current === null && isValidNumber(raw)) {
        rawBaselineRef.current = raw;
      }
    });
  }, [subscribe]);

  const draw = useCallback(() => {
    const data = dataRef.current;
    const position = isValidNumber(data?.position) ? data.position : null;
    const rawSignal = isValidNumber(data?.rawSignal) ? data.rawSignal : null;
    const hasPosition = position !== null && position >= 0 && position <= 1;
    const positionDelta =
      hasPosition && positionBaselineRef.current !== null
        ? Math.abs(position - positionBaselineRef.current)
        : Number.MAX_VALUE;
    // If position is present but effectively flat, prefer raw signal for motion.
    // This avoids a frozen needle when `position` is stale while raw signal is active.
    const usePositionSignal = hasPosition && positionDelta > 0.00025;
    const motionSourceValue = usePositionSignal ? position : rawSignal;
    const smoothed = (isValidNumber(motionSourceValue) ? motionSourceValue : rawBaselineRef.current) ?? POSITION_CENTER;
    const unfiltered = usePositionSignal
      ? smoothed
      : isValidNumber(data?.rawUnfiltered)
      ? data.rawUnfiltered
      : smoothed;
    const baseline = usePositionSignal
      ? positionBaselineRef.current ?? smoothed
      : rawBaselineRef.current ?? smoothed;
    const signalScale = usePositionSignal ? POSITION_SCALE : RAW_SCALE;
    const blend = smoothing / 100;
    const raw = unfiltered + (smoothed - unfiltered) * blend;
    const delta = baseline - raw;
    const amplifiedDelta = delta * sensitivity * signalScale;
    const taOffset = (toneArm - 2.0) * TA_SCALE;
    const targetAngle = SET_ANGLE + amplifiedDelta + taOffset;
    const clamped = clamp(targetAngle, ARC_MIN, ARC_MAX);
    const damping = 0.08 + blend * 0.26;
    displayedAngleRef.current += (clamped - displayedAngleRef.current) * damping;

    setDisplayedAngle(displayedAngleRef.current);
    animRef.current = requestAnimationFrame(draw);
  }, [sensitivity, toneArm, smoothing]);

  useEffect(() => {
    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [draw]);

  const handleSet = useCallback(() => {
    const raw = dataRef.current?.rawSignal ?? 0;
    const position = dataRef.current?.position;
    if (isValidNumber(raw)) {
      rawBaselineRef.current = raw;
    }
    if (hasValidPosition(position)) {
      positionBaselineRef.current = position;
      displayedAngleRef.current = SET_ANGLE;
      setDisplayedAngle(SET_ANGLE);
    } else if (isValidNumber(raw)) {
      displayedAngleRef.current = SET_ANGLE;
      setDisplayedAngle(SET_ANGLE);
    }
  }, []);

  return {
    displayedAngle,
    hwConnected,
    samples,
    rawSignalDisplay,
    needleAction,
    taMotion,
    dataRef,
    rawBaselineRef,
    handleSet,
  };
}
