import type { Crop, MediaAsset } from "@/project/model";
import type { SourceSpan } from "./autoClips";

export interface ReframeSettings {
  reframe?: "center" | "manual";
  reframeX?: number;
  reframeY?: number;
}
export interface FinishingSettings extends ReframeSettings {
  silences?: SourceSpan[];
}

/** Keep 120 ms of room tone at each cut; remove only the middle of detected pauses. */
export function keptSpans(start: number, end: number, silences: SourceSpan[] = []): SourceSpan[] {
  if (
    silences.some(
      (s) => s.start <= start && s.end >= end && Number.isFinite(s.start) && Number.isFinite(s.end),
    )
  )
    return [];
  const cuts = silences
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end - s.start >= 0.6)
    .map((s) => ({ start: Math.max(start, s.start + 0.12), end: Math.min(end, s.end - 0.12) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const out: SourceSpan[] = [];
  let at = start;
  for (const cut of cuts) {
    if (cut.start > at + 0.04) out.push({ start: at, end: cut.start });
    at = Math.max(at, cut.end);
  }
  if (end > at + 0.04) out.push({ start: at, end });
  return out;
}

/** Explicit crop matches CSS object-position in the review player and FFmpeg's crop. */
export function manualReframe(
  asset: Pick<MediaAsset, "width" | "height">,
  canvas: { width: number; height: number },
  settings: ReframeSettings,
): Crop | undefined {
  if (settings.reframe !== "manual") return undefined;
  const w = asset.width,
    h = asset.height;
  if (!w || !h)
    throw new Error("Manual reframe needs the source video dimensions. Re-import the video first.");
  const aspect = canvas.width / canvas.height;
  const keptW = Math.min(w, h * aspect),
    keptH = Math.min(h, w / aspect);
  const x = Math.min(1, Math.max(0, settings.reframeX ?? 0.5));
  const y = Math.min(1, Math.max(0, settings.reframeY ?? 0.5));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Invalid reframe position");
  const horizontal = 1 - keptW / w,
    vertical = 1 - keptH / h;
  if (horizontal > 0.9 || vertical > 0.9)
    throw new Error("This source is too wide or tall for manual reframe");
  return { left: horizontal * x, right: horizontal * (1 - x), top: vertical * y, bottom: vertical * (1 - y) };
}
