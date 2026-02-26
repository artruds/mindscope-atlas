import { useCallback, useEffect, useRef, useState } from "react";
import { MessageType } from "../types/messages";
import type { MeterEventData, TAMotionData, WSMessage } from "../types/messages";

export const SET_ANGLE = -12;
export const ARC_MIN = -65;
export const ARC_MAX = 65;
export const TA_BRIDGE_FACTOR = 12500;
export const RAW_SCALE = 0.00005;
export const POSITION_SCALE = 130;
const ABSOLUTE_RAW_MIN = 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isValidNumber(value: unknown): value is number {
  return parseNumber(value) !== null;
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
  onToneArmChange: (value: number) => void,
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
      setSamples(parseNumber(d.samplesReceived) ?? 0);
      setRawSignalDisplay(parseNumber(d.rawSignal) ?? 0);
      setNeedleAction(d.needleAction ?? "idle");
      if (d.taMotion) {
        setTaMotion(d.taMotion);
      }

      const raw = parseNumber(d.rawSignal);
      if (rawBaselineRef.current === null && raw !== null) {
        rawBaselineRef.current = raw;
      }

      const position = parseNumber(d.position);
      if (positionBaselineRef.current === null && position !== null) {
        positionBaselineRef.current = position;
      }
    });
  }, [subscribe]);

  const draw = useCallback(() => {
    const data = dataRef.current;
    const rawSignal = parseNumber(data?.rawSignal);
    const rawUnfiltered = parseNumber(data?.rawUnfiltered) ?? rawSignal;
    const position = parseNumber(data?.position);

    if (positionBaselineRef.current === null && position !== null) {
      positionBaselineRef.current = position;
    }

    if (rawBaselineRef.current === null && rawSignal !== null) {
      rawBaselineRef.current = rawSignal;
    }

    const useAbsoluteRaw =
      rawSignal !== null &&
      rawUnfiltered !== null &&
      Math.abs(rawSignal) > ABSOLUTE_RAW_MIN &&
      Math.abs(rawUnfiltered) > ABSOLUTE_RAW_MIN;
    const usingPosition = !useAbsoluteRaw;

    const signalScale = usingPosition ? POSITION_SCALE : RAW_SCALE;

    const baseline = useAbsoluteRaw
      ? rawBaselineRef.current
      : positionBaselineRef.current;

    if (!isValidNumber(baseline) || (usingPosition && !isValidNumber(position))) {
      setDisplayedAngle(displayedAngleRef.current);
      animRef.current = requestAnimationFrame(draw);
      return;
    }

    const blend = smoothing / 100;
    const signalValue = useAbsoluteRaw
      ? rawUnfiltered + (rawSignal! - rawUnfiltered) * blend
      : position ?? 0.5;
    const signalDelta = baseline - signalValue;
    const taOffset = (toneArm - 2.0) * TA_BRIDGE_FACTOR;
    const bridgeOutput = signalDelta + taOffset;
    const targetAngle = SET_ANGLE + bridgeOutput * sensitivity * signalScale;
    const clamped = clamp(targetAngle, ARC_MIN, ARC_MAX);
    const damping = 0.02 + blend * 0.23;
    displayedAngleRef.current += (clamped - displayedAngleRef.current) * damping;

    setDisplayedAngle(displayedAngleRef.current);
    animRef.current = requestAnimationFrame(draw);
  }, [sensitivity, toneArm, smoothing]);

  useEffect(() => {
    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [draw]);

  const handleSet = useCallback(() => {
    const raw = parseNumber(dataRef.current?.rawSignal);
    if (raw === null) {
      return;
    }
    if (rawBaselineRef.current === null) {
      rawBaselineRef.current = raw;
      return;
    }

    const signalDelta = raw - rawBaselineRef.current;
    const newToneArm = clamp(2.0 + signalDelta / TA_BRIDGE_FACTOR, 0, 6);
    onToneArmChange(newToneArm);
  }, [onToneArmChange]);

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
