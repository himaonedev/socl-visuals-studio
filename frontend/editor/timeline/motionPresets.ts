/** Local motion presets inspired by facecammaxxing, using CutVii's native keyframes. */
import { TRANSFORM_LIMITS, type Project } from "@/project/model";
import { findClip } from "./clips";
import type { EditResult } from "./edit";
import { keyTime, type Key, type KeyProp } from "./transform";

export const MOTION_PRESETS = [
  {
    id: "punch-in",
    name: "Punch-in",
    description: "Zoom in at the playhead, hold, then return.",
    text: false,
  },
  { id: "slow-push", name: "Slow Push", description: "A gradual zoom across the whole clip.", text: false },
  { id: "text-pop", name: "Text Pop", description: "Text slides and pops in, then fades out.", text: true },
  {
    id: "apple-rise",
    name: "Apple Smooth Rise",
    description: "Soft upward reveal with a subtle scale settle; no bounce.",
    text: true,
  },
  {
    id: "apple-scale",
    name: "Apple Soft Scale",
    description: "Clean scale-and-opacity reveal with a smooth camera-like exit.",
    text: true,
  },
  {
    id: "slide-left",
    name: "Smooth from Left",
    description: "Ease in from the left, hold, then leave to the right.",
    text: true,
  },
  {
    id: "slide-right",
    name: "Smooth from Right",
    description: "Ease in from the right, hold, then leave to the left.",
    text: true,
  },
  {
    id: "slide-top",
    name: "Smooth from Top",
    description: "Ease down from above, hold, then leave below.",
    text: true,
  },
  {
    id: "slide-bottom",
    name: "Smooth from Bottom",
    description: "Ease up from below, hold, then leave above.",
    text: true,
  },
] as const;
export type MotionPresetId = (typeof MOTION_PRESETS)[number]["id"];
export type MotionStrength = "subtle" | "dynamic";

export function setMotionPreset(
  project: Project,
  clipId: string,
  preset: MotionPresetId,
  strength: MotionStrength,
  playhead: number,
  seconds = preset === "punch-in" ? 2 : 0.4,
): EditResult {
  const found = findClip(project, clipId);
  if (!found) return { ok: false, error: { code: "unknown-clip", message: "Select a clip first" } };
  const { clip, track } = found;
  const asset = project.assets.find((a) => a.id === clip.assetId);
  const definition = MOTION_PRESETS.find((p) => p.id === preset);
  if (
    !definition ||
    !Number.isFinite(playhead) ||
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    (strength !== "subtle" && strength !== "dynamic")
  ) {
    return {
      ok: false,
      error: { code: "out-of-range", message: "Choose a valid motion preset and duration" },
    };
  }
  if (!asset || track.type !== "video" || asset.type === "audio" || definition.text !== Boolean(asset.text)) {
    return {
      ok: false,
      error: { code: "incompatible-track", message: "Choose a preset for this clip type" },
    };
  }
  const length = (clip.sourceOut - clip.sourceIn) / (clip.speed ?? 1);
  if (length < 4 / project.settings.fps) {
    return {
      ok: false,
      error: { code: "out-of-range", message: "Motion presets need a clip at least four frames long" },
    };
  }
  const keys: Partial<Record<KeyProp, Key[]>> = {};
  const put = (prop: KeyProp, points: [number, number][]) => {
    // Keys are SOURCE times: map timeline time through trim, speed and reverse.
    const mapped = points.map(([t, v]) => ({ t: keyTime(clip, clip.timelineStart + t), v }));
    const unique = new Map(mapped.map((key) => [key.t, key]));
    keys[prop] = [...unique.values()].sort((a, b) => a.t - b.t);
  };
  const scaled = (factor: number) =>
    Math.min(TRANSFORM_LIMITS.maxScale, Math.max(TRANSFORM_LIMITS.minScale, clip.scale * factor));
  const dynamic = strength === "dynamic";
  if (preset === "slow-push") {
    put("scale", [
      [0, clip.scale],
      [length, scaled(dynamic ? 1.25 : 1.1)],
    ]);
  } else if (preset === "punch-in") {
    const duration = Math.min(length, seconds);
    const start = Math.max(0, Math.min(length - duration, playhead - clip.timelineStart));
    const ramp = Math.min(5 / project.settings.fps, duration / 4);
    put("scale", [
      [0, clip.scale],
      [start, clip.scale],
      [start + ramp, scaled(dynamic ? 1.25 : 1.12)],
      [start + duration - ramp, scaled(dynamic ? 1.25 : 1.12)],
      [start + duration, clip.scale],
      [length, clip.scale],
    ]);
  } else if (preset !== "text-pop") {
    // Sample eased curves into ordinary keys so preview and FFmpeg use the same motion.
    const entrance = Math.min(seconds, length * 0.4);
    const exit = Math.min(seconds * 0.75, length * 0.3);
    const distance = dynamic ? 0.18 : 0.075;
    const dx = preset === "slide-left" ? -distance : preset === "slide-right" ? distance : 0;
    const dy =
      preset === "slide-top"
        ? -distance
        : preset === "slide-bottom"
          ? distance
          : preset === "apple-rise"
            ? dynamic
              ? 0.045
              : 0.025
            : 0;
    const offset = (value: number) =>
      Math.max(-TRANSFORM_LIMITS.offset, Math.min(TRANSFORM_LIMITS.offset, value));
    const apple = preset === "apple-rise" || preset === "apple-scale";
    const startScale = apple ? scaled(dynamic ? 1.08 : 1.035) : clip.scale;
    const curves: Record<"x" | "y" | "scale" | "opacity", [number, number][]> = {
      x: [],
      y: [],
      scale: [],
      opacity: [],
    };
    for (let i = 0; i <= 12; i++) {
      const p = i / 12,
        eased = 1 - (1 - p) ** 3;
      curves.x.push([entrance * p, offset(clip.x + dx * (1 - eased))]);
      curves.y.push([entrance * p, offset(clip.y + dy * (1 - eased))]);
      curves.scale.push([entrance * p, startScale + (clip.scale - startScale) * eased]);
      curves.opacity.push([entrance * p, clip.opacity * eased]);
    }
    for (let i = 0; i <= 12; i++) {
      const p = i / 12,
        eased = p ** 3,
        t = length - exit + exit * p;
      curves.x.push([t, offset(clip.x - dx * eased)]);
      curves.y.push([t, offset(clip.y - dy * eased)]);
      curves.scale.push([t, clip.scale + (startScale - clip.scale) * eased]);
      curves.opacity.push([t, clip.opacity * (1 - eased)]);
    }
    for (const prop of ["x", "y", "scale", "opacity"] as const) {
      const points = curves[prop];
      put(
        prop,
        points.every(([, v]) => v === points[0][1])
          ? [
              [0, points[0][1]],
              [length, points[0][1]],
            ]
          : points,
      );
    }
  } else {
    put("x", [
      [0, clip.x],
      [length, clip.x],
    ]);
    const entrance = Math.min(seconds, length / 3);
    const exit = Math.min(seconds * 0.5, length / 4);
    put("scale", [
      [0, scaled(dynamic ? 0.72 : 0.88)],
      [entrance * 0.65, scaled(dynamic ? 1.08 : 1.03)],
      [entrance, clip.scale],
      [length, clip.scale],
    ]);
    put("y", [
      [0, Math.min(TRANSFORM_LIMITS.offset, clip.y + (dynamic ? 0.06 : 0.03))],
      [entrance, clip.y],
      [length, clip.y],
    ]);
    put("opacity", [
      [0, 0],
      [entrance * 0.6, clip.opacity],
      [length - exit, clip.opacity],
      [length, 0],
    ]);
  }
  return {
    ok: true,
    project: {
      ...project,
      tracks: project.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? { ...c, keyframes: { ...c.keyframes, ...keys } } : c)),
      })),
    },
  };
}

/** Apply to selected text clips atomically; other media remain untouched. */
export function setTextMotionOnClips(
  project: Project,
  ids: string[],
  preset: MotionPresetId,
  strength: MotionStrength,
  seconds: number,
): EditResult {
  if (!MOTION_PRESETS.some((p) => p.id === preset && p.text))
    return { ok: false, error: { code: "incompatible-track", message: "Choose a text motion style" } };
  const selected = new Set(ids);
  const assets = new Map(project.assets.filter((a) => a.text).map((a) => [a.id, a]));
  let count = 0;
  const tracks = [];
  for (const track of project.tracks) {
    let changed = false;
    const clips = [];
    for (const clip of track.clips) {
      const asset = assets.get(clip.assetId);
      if (
        track.type !== "video" ||
        !selected.has(clip.id) ||
        !asset ||
        (clip.sourceOut - clip.sourceIn) / (clip.speed ?? 1) < 4 / project.settings.fps
      ) {
        clips.push(clip);
        continue;
      }
      const result = setMotionPreset(
        { ...project, assets: [asset], tracks: [{ ...track, clips: [clip] }] },
        clip.id,
        preset,
        strength,
        clip.timelineStart,
        seconds,
      );
      if (!result.ok) return result;
      clips.push(result.project.tracks[0].clips[0]);
      changed = true;
      count++;
    }
    tracks.push(changed ? { ...track, clips } : track);
  }
  return count
    ? { ok: true, project: { ...project, tracks } }
    : { ok: false, error: { code: "out-of-range", message: "Select text clips at least four frames long" } };
}
/** Apply to one caption track atomically, leaving non-text media untouched. */
export function setTextMotionOnTrack(
  project: Project,
  trackId: string,
  preset: MotionPresetId,
  strength: MotionStrength,
  seconds: number,
): EditResult {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track || track.type !== "video")
    return { ok: false, error: { code: "incompatible-track", message: "Select a text track" } };
  return setTextMotionOnClips(
    project,
    track.clips.map((c) => c.id),
    preset,
    strength,
    seconds,
  );
}
