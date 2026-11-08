import type { Project } from "@/project/model";
import { findClip, clipDuration } from "./clips";
import type { EditResult } from "./edit";
export type FlickerKind = "blink" | "neon" | "pulse";
export interface FlickerSettings {
  kind: FlickerKind;
  duration: number;
  speed: number;
  depth: number;
}
export const DEFAULT_FLICKER: FlickerSettings = { kind: "blink", duration: 1, speed: 2, depth: 1 };
/** Native opacity keys: no rendered media or extra runtime. Replaces opacity motion only. */
export function applyTextFlicker(project: Project, clipId: string, s: FlickerSettings): EditResult {
  const found = findClip(project, clipId);
  const asset = found && project.assets.find((a) => a.id === found.clip.assetId);
  const fail = (message: string): EditResult => ({ ok: false, error: { code: "out-of-range", message } });
  if (!found || found.track.type !== "video" || !asset?.text)
    return fail("Select a text/subtitle clip first");
  if (
    !["blink", "neon", "pulse"].includes(s.kind) ||
    ![s.duration, s.speed, s.depth].every(Number.isFinite) ||
    s.duration < 0.2 ||
    s.duration > 3 ||
    s.speed < 0.5 ||
    s.speed > 4 ||
    s.depth < 0 ||
    s.depth > 1
  )
    return fail("Choose valid flicker settings");
  const c = found.clip,
    fps = project.settings.fps,
    duration = Math.min(clipDuration(c), Math.round(s.duration * fps) / fps);
  const frames = Math.floor(duration * fps + 1e-7);
  if (frames < 2) return fail("Leave at least two frames for flicker");
  // Up to 61 keys, snapped to actual frames. Higher FPS uses a sparser curve.
  const count = Math.min(60, frames),
    base = c.opacity ?? 1;
  const keys = Array.from({ length: count + 1 }, (_, i) => {
    const elapsed = Math.round((i * frames) / count) / fps;
    const phase = elapsed * s.speed;
    const level =
      i === count
        ? 1
        : s.kind === "pulse"
          ? (1 + Math.cos(phase * Math.PI * 2)) / 2
          : s.kind === "blink"
            ? phase % 1 < 0.5
              ? 1
              : 0
            : [1, 0.12, 0.85, 0, 0.35, 1, 0.18, 1, 1, 0.6, 0, 1][Math.floor(phase * 6) % 12];
    return {
      t: c.reversed ? c.sourceOut - elapsed * (c.speed ?? 1) : c.sourceIn + elapsed * (c.speed ?? 1),
      v: base * (1 - s.depth + s.depth * level),
    };
  }).sort((a, b) => a.t - b.t);
  return {
    ok: true,
    project: {
      ...project,
      tracks: project.tracks.map((t) =>
        t.id !== found.track.id
          ? t
          : {
              ...t,
              clips: t.clips.map((clip) =>
                clip.id !== clipId ? clip : { ...clip, keyframes: { ...clip.keyframes, opacity: keys } },
              ),
            },
      ),
    },
  };
}
