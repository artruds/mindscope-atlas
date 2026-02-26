export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function formatSignal(val: number): string {
  if (!isFinite(val)) return "---";
  if (Math.abs(val) >= 1_000_000) return (val / 1_000_000).toFixed(3) + "M";
  if (Math.abs(val) >= 1_000) return (val / 1_000).toFixed(1) + "k";
  return val.toFixed(1);
}
