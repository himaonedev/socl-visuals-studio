import { create } from "zustand";
import { MAX_KEYS, TRANSFORM_LIMITS, type Project, type TimelineClip } from "@/project/model";
import { useProjectStore } from "@/store/project";
import { clipDuration, findClip } from "./clips";
import type { EditResult } from "./edit";
import { KEY_PROPS, transformOf, valueAt, type KeyProp, type Key } from "./transform";

export interface TextMotion {
  curves: Partial<Record<KeyProp, Key[]>>;
}
/** An in-memory motion clipboard, independent of copied media/text content. */
export const useTextMotionClipboard = create<{ motion: TextMotion | null }>(() => ({ motion: null }));
const failure = (message: string): EditResult => ({ ok: false, error: { code: "out-of-range", message } });
export function captureTextMotion(project: Project, clipId: string): TextMotion | null {
  const found = findClip(project, clipId);
  if (
    !found ||
    found.track.type !== "video" ||
    !project.assets.some((a) => a.id === found.clip.assetId && a.text)
  )
    return null;
  const clip = found.clip,
    base = transformOf(clip),
    span = clip.sourceOut - clip.sourceIn;
  const curves: TextMotion["curves"] = {};
  let animated = false;
  for (const prop of KEY_PROPS) {
    const keys = clip.keyframes?.[prop];
    if (!keys?.length) continue;
    const times = new Set([
      clip.sourceIn,
      clip.sourceOut,
      ...keys.filter((k) => k.t > clip.sourceIn && k.t < clip.sourceOut).map((k) => k.t),
    ]);
    const points = [...times]
      .map((t) => {
        const v = valueAt(keys, t);
        return {
          t: clip.reversed ? (clip.sourceOut - t) / span : (t - clip.sourceIn) / span,
          v:
            prop === "scale" ? v / base.scale : prop === "opacity" ? v / (base.opacity || 1) : v - base[prop],
        };
      })
      .sort((a, b) => a.t - b.t);
    if (points.some((p) => Math.abs(p.v - points[0].v) > 1e-9)) animated = true;
    // Boundary holds are redundant; retain the original curve without exceeding the schema limit.
    if (points.length > 1 && points[0].v === points[1].v) points.shift();
    if (points.length > 1 && points.at(-1)!.v === points.at(-2)!.v) points.pop();
    if (points.length > MAX_KEYS) return null;
    curves[prop] = points;
  }
  return animated ? { curves } : null;
}
export function copyTextMotion(clipId: string): EditResult {
  const project = useProjectStore.getState().project;
  const motion = captureTextMotion(project, clipId);
  if (!motion) return failure("Select one animated text/subtitle clip and apply a motion first");
  useTextMotionClipboard.setState({ motion });
  return { ok: true, project };
}
export function pasteTextMotion(project: Project, ids: string[], motion: TextMotion): EditResult {
  const selected = new Set(ids),
    assets = new Set(project.assets.filter((a) => a.text).map((a) => a.id));
  let count = 0;
  const tracks = project.tracks.map((track) => {
    if (track.type !== "video") return track;
    let changed = false;
    const clips = track.clips.map((clip) => {
      if (!selected.has(clip.id) || !assets.has(clip.assetId)) return clip;
      const base = transformOf(clip),
        span = clip.sourceOut - clip.sourceIn;
      if (clipDuration(clip) < 1 / project.settings.fps) return clip;
      const keyframes: NonNullable<TimelineClip["keyframes"]> = {};
      for (const prop of KEY_PROPS) {
        const curve = motion.curves[prop];
        if (!curve?.length) continue;
        const range =
          prop === "scale"
            ? [TRANSFORM_LIMITS.minScale, TRANSFORM_LIMITS.maxScale]
            : prop === "opacity"
              ? [0, 1]
              : prop === "rotation"
                ? [-TRANSFORM_LIMITS.rotation, TRANSFORM_LIMITS.rotation]
                : [-TRANSFORM_LIMITS.offset, TRANSFORM_LIMITS.offset];
        keyframes[prop] = curve
          .map((k) => ({
            t: clip.reversed ? clip.sourceOut - k.t * span : clip.sourceIn + k.t * span,
            v: Math.max(
              range[0],
              Math.min(
                range[1],
                prop === "scale" || prop === "opacity" ? k.v * base[prop] : base[prop] + k.v,
              ),
            ),
          }))
          .sort((a, b) => a.t - b.t);
      }
      changed = true;
      count++;
      return { ...clip, keyframes };
    });
    return changed ? { ...track, clips } : track;
  });
  return count
    ? { ok: true, project: { ...project, tracks } }
    : failure("Select text/subtitle clips to paste motion onto");
}
export function pasteMotionToSelectedText(ids: string[]): EditResult {
  const motion = useTextMotionClipboard.getState().motion;
  if (!motion) return failure("Copy motion from one text clip first");
  return useProjectStore
    .getState()
    .execute({ label: "Paste text motion", apply: (p) => pasteTextMotion(p, ids, motion) });
}
