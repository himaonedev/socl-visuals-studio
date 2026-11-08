import { invoke } from "@tauri-apps/api/core";
import type { ImportedMedia } from "@/lib/media";
import {
  MAX_KEYS,
  TRANSFORM_LIMITS,
  type Project,
  type TimelineClip,
  type MediaAsset,
  type TextSpec,
  type TextStyle,
  TextSpecSchema,
} from "@/project/model";
import { useProjectStore } from "@/store/project";
import { findClip, clipEnd, EPS } from "./clips";
import { KEY_PROPS, transformAt, type Key, type Transform } from "./transform";
import { withStyle } from "./textStyles";
import { fadeGain } from "./audio";
import type { EditResult } from "./edit";
export interface TextMarkSettings {
  kind: "highlighter" | "strike";
  textLook?: "keep" | "plain" | "custom";
  textStyle?: TextStyle;
  color: string;
  opacity: number;
  thickness: number;
  duration: number;
  delay: number;
  wholeText: boolean;
  firstWord: number;
  lastWord: number;
}
export const DEFAULT_TEXT_MARK: TextMarkSettings = {
  kind: "highlighter",
  color: "#FFE66A",
  opacity: 0.4,
  thickness: 0.7,
  duration: 0.6,
  delay: 0,
  wholeText: true,
  firstWord: 1,
  lastWord: 1,
};
export interface PreparedTextMark {
  originKey: string;
  video: ImportedMedia;
  still: ImportedMedia;
  text?: { path: string; spec: TextSpec };
}
export function textMarkSpec(spec: TextSpec, s: TextMarkSettings): TextSpec {
  if (!s.textLook || s.textLook === "keep") return spec;
  if (s.textLook === "custom") {
    if (!s.textStyle) throw new Error("Choose a custom text style first");
    return TextSpecSchema.parse(withStyle(spec, s.textStyle));
  }
  if (s.textLook !== "plain") throw new Error("Choose a valid text appearance");
  const plain = { ...spec };
  delete plain.box;
  delete plain.highlight;
  return plain;
}
export function textMarkWindow(project: Project, clipId: string, s: TextMarkSettings) {
  const found = findClip(project, clipId),
    asset = found && project.assets.find((a) => a.id === found.clip.assetId);
  if (!found || found.track.type !== "video" || !asset?.text)
    throw new Error("Select a text/subtitle clip first");
  const words = asset.text.content.trim().split(/\s+/u).length;
  if (
    ![s.opacity, s.thickness, s.duration, s.delay, s.firstWord, s.lastWord].every(Number.isFinite) ||
    !["highlighter", "strike"].includes(s.kind) ||
    !/^#[\da-f]{6}$/i.test(s.color) ||
    s.opacity < 0 ||
    s.opacity > 1 ||
    s.thickness < 0.02 ||
    s.thickness > 1.5 ||
    s.duration < 0.1 ||
    s.duration > 2 ||
    s.delay < 0 ||
    (!s.wholeText &&
      (!Number.isInteger(s.firstWord) ||
        !Number.isInteger(s.lastWord) ||
        s.firstWord < 1 ||
        s.lastWord < s.firstWord ||
        s.lastWord > words))
  )
    throw new Error("Choose valid text mark settings and word numbers");
  const fps = project.settings.fps;
  const start = found.clip.timelineStart + Math.round(s.delay * fps) / fps;
  const end = clipEnd(found.clip),
    seconds = Math.min(end - start, Math.max(1, Math.round(s.duration * fps)) / fps);
  if (seconds < 1 / fps - EPS) throw new Error("Leave at least one frame after the mark start time");
  return {
    ...found,
    asset,
    start,
    end,
    seconds,
    firstWord: s.wholeText ? 0 : s.firstWord - 1,
    lastWord: s.wholeText ? words - 1 : s.lastWord - 1,
  };
}
/** Bake the parent's view motion into a zero-based overlay, including existing text fades. */
function markerMotion(parent: TimelineClip, start: number, seconds: number, fps: number) {
  const end = start + seconds,
    speed = parent.speed ?? 1;
  const view = (time: number): Transform => {
    const t = transformAt(parent, time);
    return {
      ...t,
      x: Math.max(-2, Math.min(2, t.x)),
      y: Math.max(-2, Math.min(2, t.y)),
      scale: Math.max(0.05, Math.min(4, t.scale)),
      rotation: Math.max(-180, Math.min(180, t.rotation)),
      opacity: Math.max(0, Math.min(1, t.opacity * fadeGain(parent, time))),
    };
  };
  const base = view(start),
    keyframes: NonNullable<TimelineClip["keyframes"]> = {};
  for (const prop of KEY_PROPS) {
    const times = new Set([start, end]);
    for (const key of parent.keyframes?.[prop] ?? []) {
      const time =
        parent.timelineStart + (parent.reversed ? parent.sourceOut - key.t : key.t - parent.sourceIn) / speed;
      if (time > start && time < end) times.add(time);
    }
    if (
      parent.transitionIn ||
      parent.transitionOut ||
      (prop === "opacity" && (parent.fadeIn || parent.fadeOut))
    ) {
      const count = Math.min(48, Math.max(1, Math.ceil(seconds * fps)));
      for (let i = 1; i < count; i++) times.add(start + (seconds * i) / count);
    }
    const bounds =
      prop === "scale"
        ? [TRANSFORM_LIMITS.minScale, TRANSFORM_LIMITS.maxScale]
        : prop === "opacity"
          ? [0, 1]
          : prop === "rotation"
            ? [-TRANSFORM_LIMITS.rotation, TRANSFORM_LIMITS.rotation]
            : [-TRANSFORM_LIMITS.offset, TRANSFORM_LIMITS.offset];
    const points: Key[] = [];
    for (const time of [...times].sort((a, b) => a - b)) {
      const point = { t: time - start, v: Math.max(bounds[0], Math.min(bounds[1], view(time)[prop])) };
      while (points.length >= 2) {
        const a = points.at(-2)!,
          b = points.at(-1)!;
        const expected = a.v + ((point.v - a.v) * (b.t - a.t)) / (point.t - a.t);
        if (Math.abs(b.v - expected) > 1e-7) break;
        points.pop();
      }
      points.push(point);
    }
    if (points.length > MAX_KEYS)
      throw new Error("Text motion is too complex for this mark. Simplify its keyframes first.");
    if (points.some((p) => Math.abs(p.v - base[prop]) > 1e-7)) keyframes[prop] = points;
  }
  return { ...base, keyframes: Object.keys(keyframes).length ? keyframes : undefined };
}
export function applyTextMark(
  project: Project,
  clipId: string,
  s: TextMarkSettings,
  prepared: PreparedTextMark,
  uuid: () => string = () => crypto.randomUUID(),
): EditResult {
  try {
    const source = textMarkWindow(project, clipId, s);
    if (s.textLook && s.textLook !== "keep") {
      const expected = textMarkSpec(source.asset.text!, s);
      if (!prepared.text?.path || JSON.stringify(prepared.text.spec) !== JSON.stringify(expected))
        throw new Error("The restyled text render is incomplete");
      const asset = { ...source.asset, id: uuid(), path: prepared.text.path, text: expected };
      project = {
        ...project,
        assets: [...project.assets, asset],
        tracks: project.tracks.map((t) =>
          t.id === source.track.id
            ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, assetId: asset.id } : c)) }
            : t,
        ),
      };
    }
    const w = textMarkWindow(project, clipId, s);
    if (
      !/^[a-f0-9]{16}$/i.test(prepared.originKey) ||
      prepared.video.mediaType !== "video" ||
      prepared.still.mediaType !== "image" ||
      (prepared.video.duration ?? 0) < w.seconds - 0.05 ||
      !prepared.video.width ||
      !prepared.still.width
    )
      throw new Error("The text mark render is incomplete");
    const assets = [...project.assets],
      byPath = new Map(assets.map((a) => [a.path, a]));
    const add = (media: ImportedMedia): MediaAsset => {
      const old = byPath.get(media.path);
      if (old?.alpha) return old;
      const asset: MediaAsset = {
        id: uuid(),
        path: media.path,
        type: media.mediaType,
        alpha: true,
        width: media.width,
        height: media.height,
        ...(media.mediaType === "video"
          ? { duration: media.duration, fpsNum: media.fpsNum, fpsDen: media.fpsDen }
          : {}),
        ...(media.thumbnailPath ? { thumbnailPath: media.thumbnailPath } : {}),
      };
      assets.push(asset);
      byPath.set(asset.path, asset);
      return asset;
    };
    const animation = add(prepared.video),
      still = add(prepared.still),
      trackId = uuid();
    const make = (a: number, b: number, asset: MediaAsset): TimelineClip => ({
      id: uuid(),
      trackId,
      assetId: asset.id,
      timelineStart: a,
      sourceIn: 0,
      sourceOut: b - a,
      volume: 0,
      muted: true,
      ...markerMotion(w.clip, a, b - a, project.settings.fps),
    });
    const animatedEnd = w.start + w.seconds;
    const clips = [make(w.start, animatedEnd, animation)];
    if (w.end - animatedEnd > EPS) clips.push(make(animatedEnd, w.end, still));
    const owned = `/text-markers/${prepared.originKey}/${s.kind}/`;
    const oldAssets = new Map(project.assets.map((a) => [a.id, a]));
    const tracks = project.tracks
      .flatMap((track) => {
        const kept = track.clips.filter(
          (c) => !oldAssets.get(c.assetId)?.path.replaceAll("\\", "/").includes(owned),
        );
        if (kept.length === track.clips.length) return [track];
        return kept.length ? [{ ...track, clips: kept }] : [];
      })
      .map((t) => (t.order > w.track.order ? { ...t, order: t.order + 1 } : t));
    tracks.push({
      id: trackId,
      name: s.kind === "highlighter" ? "Text highlighter" : "Text strikethrough",
      type: "video",
      order: w.track.order + 1,
      hidden: false,
      muted: true,
      clips,
    });
    return { ok: true, project: { ...project, assets, tracks } };
  } catch (error) {
    return {
      ok: false,
      error: { code: "out-of-range", message: error instanceof Error ? error.message : String(error) },
    };
  }
}
export async function createTextMark(
  clipId: string,
  s: TextMarkSettings,
  signal?: AbortSignal,
): Promise<EditResult> {
  signal?.throwIfAborted();
  const snapshot = useProjectStore.getState().project,
    w = textMarkWindow(snapshot, clipId, s);
  const spec = textMarkSpec(w.asset.text!, s);
  let restyled: PreparedTextMark["text"];
  if (s.textLook && s.textLook !== "keep") {
    const path = await invoke<string>("render_text", {
      spec,
      width: snapshot.settings.width,
      height: snapshot.settings.height,
    });
    restyled = { path, spec };
    signal?.throwIfAborted();
  }
  const cancel = () => {
    void invoke("cancel_ai_job").catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let prepared: PreparedTextMark;
  try {
    prepared = await invoke<PreparedTextMark>("prepare_text_marker", {
      request: {
        origin: `${snapshot.id}:${clipId}`,
        spec,
        width: snapshot.settings.width,
        height: snapshot.settings.height,
        kind: s.kind,
        color: s.color,
        opacity: s.opacity,
        thickness: s.thickness,
        seconds: w.seconds,
        fps: snapshot.settings.fps,
        firstWord: w.firstWord,
        lastWord: w.lastWord,
      },
    });
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  if (restyled) prepared.text = restyled;
  signal?.throwIfAborted();
  if (useProjectStore.getState().project !== snapshot)
    throw new Error(
      "The project changed during marker preparation. No edit applied; retry to use the cached render.",
    );
  return useProjectStore.getState().execute({
    label: s.kind === "highlighter" ? "Animate text highlighter" : "Animate text strikethrough",
    apply: (p) => applyTextMark(p, clipId, s, prepared),
  });
}
