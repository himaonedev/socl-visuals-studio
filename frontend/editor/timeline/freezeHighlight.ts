import { prepareEffectSubtitles, applyEffectSubtitles, type EffectSubtitleOverride } from "./effectSubtitles";
import { invoke } from "@tauri-apps/api/core";
import type { ImportedMedia } from "@/lib/media";
import type { MediaAsset, Project, TimelineClip } from "@/project/model";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { clipEnd, clipSpeed, EPS, findClip, minClipDuration } from "./clips";
import { sourceTimeAt, type EditResult } from "./edit";
import { soundFadesOf } from "./audio";
import { highlightImageKeys } from "./highlightImage";
import { movingHighlightMotion } from "./highlightMotion";
import { transitionOf, transitionOutOf } from "./transitions";
import { transformAt } from "./transform";

export interface FreezeHighlightSettings {
  playback: "freeze" | "moving";
  wholeClip: boolean;
  style: "halftone" | "mono" | "outline" | "paper-outline" | "paper";
  backgroundMode: "styled" | "original" | "color" | "image";
  backgroundColor: string;
  backgroundImage: string;
  backgroundWidth: number;
  backgroundHeight: number;
  backgroundX: number;
  backgroundY: number;
  backgroundFit: "cover" | "contain";
  backgroundBase: "original" | "styled" | "color";
  backgroundMotion: "none" | "down" | "up" | "left" | "right" | "shake";
  backgroundSpeed: number;

  paperColor: string;
  outlineColor: string;
  outlineWidth: number;
  subjectZoom: number;
  color: string;
  darkColor: string;
  opacity: number;
  spacing: number;
  intensity: number;
  pattern: "grid" | "wave" | "radial";
  bend: number;
  audio: "none" | "echo" | "reverb" | "impact";
  audioStrength: number;
  duration: number;
  zoom: number;
}
export const DEFAULT_FREEZE_HIGHLIGHT: FreezeHighlightSettings = {
  playback: "freeze",
  wholeClip: false,
  style: "halftone",
  backgroundMode: "styled",
  backgroundColor: "#28262E",
  backgroundImage: "",
  backgroundWidth: 1,
  backgroundHeight: 1,
  backgroundX: 0.5,
  backgroundY: 0.5,
  backgroundFit: "cover",
  backgroundBase: "original",
  backgroundMotion: "none",
  backgroundSpeed: 1,
  paperColor: "#EFE6D8",
  outlineColor: "#FFFFFF",
  outlineWidth: 14,
  subjectZoom: 1.12,
  color: "#E9C847",
  darkColor: "#28262E",
  opacity: 0.9,
  spacing: 6,
  intensity: 0.85,
  pattern: "grid",
  bend: 0.6,
  audio: "none",
  audioStrength: 0.45,
  duration: 1.5,
  zoom: 1.08,
};
export interface PreparedFreeze {
  image: ImportedMedia;
  audio: ImportedMedia | null;
  hasAudio: boolean;
  layers?: { subject: ImportedMedia; overlay: ImportedMedia } | null;
}
export const editableBackground = (s: FreezeHighlightSettings) =>
  ["outline", "paper-outline"].includes(s.style) && s.backgroundMode === "image";
export const animatedBackground = (s: FreezeHighlightSettings) =>
  ["outline", "paper-outline"].includes(s.style) &&
  s.backgroundMode === "image" &&
  s.backgroundMotion !== "none";
const fail = (message: string): EditResult => ({ ok: false, error: { code: "out-of-range", message } });
const voiceEffect = (s: FreezeHighlightSettings) => s.audio === "echo" || s.audio === "reverb";

export function freezeWindow(project: Project, clipId: string, playhead: number, s: FreezeHighlightSettings) {
  const found = findClip(project, clipId);
  const asset = found && project.assets.find((a) => a.id === found.clip.assetId);
  if (!found || !asset || asset.type !== "video" || found.track.type !== "video" || asset.alpha)
    throw new Error("Select an original, opaque video clip for Freeze Highlight");
  if (
    ![
      s.duration,
      s.zoom,
      s.opacity,
      s.spacing,
      s.intensity,
      s.bend,
      s.outlineWidth,
      s.subjectZoom,
      s.audioStrength,
      s.backgroundSpeed,
      s.backgroundWidth,
      s.backgroundHeight,
      s.backgroundX,
      s.backgroundY,
      playhead,
    ].every(Number.isFinite) ||
    !["halftone", "mono", "outline", "paper-outline", "paper"].includes(s.style) ||
    !["styled", "original", "color", "image"].includes(s.backgroundMode) ||
    s.backgroundWidth < 0.05 ||
    s.backgroundWidth > 2 ||
    s.backgroundHeight < 0.05 ||
    s.backgroundHeight > 2 ||
    s.backgroundX < 0 ||
    s.backgroundX > 1 ||
    s.backgroundY < 0 ||
    s.backgroundY > 1 ||
    s.backgroundSpeed < 0.1 ||
    s.backgroundSpeed > 5 ||
    !["none", "down", "up", "left", "right", "shake"].includes(s.backgroundMotion) ||
    !["cover", "contain"].includes(s.backgroundFit) ||
    !["original", "styled", "color"].includes(s.backgroundBase) ||
    !/^#[a-f\d]{6}$/i.test(s.backgroundColor) ||
    !/^#[a-f\d]{6}$/i.test(s.paperColor) ||
    !/^#[a-f\d]{6}$/i.test(s.outlineColor) ||
    s.outlineWidth < 1 ||
    s.outlineWidth > 40 ||
    s.subjectZoom < 1 ||
    s.subjectZoom > 1.4 ||
    s.duration < 0.2 ||
    s.duration > (s.playback === "moving" ? 120 : 15) ||
    !["freeze", "moving"].includes(s.playback) ||
    typeof s.wholeClip !== "boolean" ||
    s.zoom < 1 ||
    s.zoom > 1.3 ||
    s.opacity < 0 ||
    s.opacity > 1 ||
    s.spacing < 2 ||
    s.spacing > 20 ||
    s.intensity < 0 ||
    s.intensity > 1 ||
    s.bend < 0 ||
    s.bend > 1 ||
    !["grid", "wave", "radial"].includes(s.pattern) ||
    s.audioStrength < 0 ||
    s.audioStrength > 1 ||
    !/^#[a-f\d]{6}$/i.test(s.color) ||
    !/^#[a-f\d]{6}$/i.test(s.darkColor) ||
    !["none", "echo", "reverb", "impact"].includes(s.audio)
  )
    throw new Error("Choose valid Freeze Highlight settings");
  if (["outline", "paper-outline"].includes(s.style) && s.backgroundMode === "image" && !s.backgroundImage)
    throw new Error("Choose a background image first");
  const { clip, track } = found;
  const fps = project.settings.fps,
    min = minClipDuration(project),
    end = clipEnd(clip);
  if (
    !(s.playback === "moving" && s.wholeClip) &&
    (playhead < clip.timelineStart - EPS || playhead >= end - EPS)
  )
    throw new Error("Move the playhead inside the selected video");
  let start =
    s.playback === "moving" && s.wholeClip
      ? clip.timelineStart
      : Math.max(clip.timelineStart, Math.round(playhead * fps) / fps);
  if (start - clip.timelineStart < min - EPS) start = clip.timelineStart;
  let stop =
    s.playback === "moving" && s.wholeClip ? end : Math.min(end, start + Math.round(s.duration * fps) / fps);
  if (end - stop < min - EPS) stop = end;
  if (stop - start < 0.2 - EPS)
    throw new Error("At least 0.2 seconds of video must remain after the playhead");
  if (s.playback === "moving") {
    if (clip.reversed) throw new Error("Moving styles need a Forward clip. Freeze still supports reverse.");
    if (stop - start > 120 + EPS)
      throw new Error("Moving styles handle up to 120 seconds per render. Choose a shorter duration.");
    const incoming = transitionOf(clip)?.seconds ?? 0,
      outgoing = transitionOutOf(clip)?.seconds ?? 0;
    const cutsTransition = (point: number) =>
      (point > clip.timelineStart + EPS && point < clip.timelineStart + incoming - EPS) ||
      (point > end - outgoing + EPS && point < end - EPS);
    movingHighlightMotion(clip, start, stop - start, s.zoom);
    if (cutsTransition(start) || cutsTransition(stop))
      throw new Error(
        "The range cuts through a visual transition. Include the whole transition or choose another range.",
      );
  }
  const fades = soundFadesOf(clip);
  if (voiceEffect(s)) {
    if (clip.muted || track.muted || clipSpeed(clip) > 4)
      throw new Error(
        "Echo and reverb need audible source audio at up to 4× speed. Use Original audio or Impact instead.",
      );
    if (start < clip.timelineStart + fades.fadeIn - EPS || stop > end - fades.fadeOut + EPS)
      throw new Error(
        "Place echo/reverb between the clip's audio fades and transitions, or choose Original audio/Impact",
      );
  }
  return { clip, track, asset, start, stop, fades };
}

function slice(c: TimelineClip, a: number, b: number, id: string): TimelineClip {
  const first = sourceTimeAt(c, a),
    last = sourceTimeAt(c, b);
  return { ...c, id, timelineStart: a, sourceIn: Math.min(first, last), sourceOut: Math.max(first, last) };
}

export function applyFreezeHighlight(
  project: Project,
  clipId: string,
  playhead: number,
  s: FreezeHighlightSettings,
  prepared: PreparedFreeze,
  uuid: () => string = () => crypto.randomUUID(),
): EditResult {
  let window: ReturnType<typeof freezeWindow>;
  try {
    window = freezeWindow(project, clipId, playhead, s);
  } catch (e) {
    return fail(String(e));
  }
  const { clip, track, start, stop, fades } = window;
  const seconds = stop - start;
  const moving = s.playback === "moving";
  const renderedVideo = moving || editableBackground(s);
  if (
    prepared.image.mediaType !== (renderedVideo ? "video" : "image") ||
    !prepared.image.width ||
    !prepared.image.height ||
    (renderedVideo && (prepared.image.duration ?? 0) < seconds - 0.025)
  )
    return fail("The processed frame is unavailable");
  if (
    s.audio !== "none" &&
    (!prepared.audio ||
      prepared.audio.mediaType !== "audio" ||
      (prepared.audio.duration ?? 0) < seconds - 0.025)
  )
    return fail("The processed audio is incomplete");
  if (voiceEffect(s) && !prepared.hasAudio) return fail("The source has no audio for echo/reverb");
  if (
    editableBackground(s) &&
    (!prepared.layers ||
      prepared.layers.subject.mediaType !== "video" ||
      !prepared.layers.subject.alpha ||
      (prepared.layers.subject.duration ?? 0) < seconds - 0.025 ||
      prepared.layers.overlay.mediaType !== "image")
  )
    return fail("The editable background layers are incomplete. Apply the style again.");
  const assets = [...project.assets];
  const add = (m: ImportedMedia, type: MediaAsset["type"]): MediaAsset => {
    const existing = assets.find((a) => a.path === m.path);
    if (existing) return existing;
    const asset: MediaAsset = {
      id: uuid(),
      path: m.path,
      type,
      ...(m.alpha ? { alpha: true } : {}),
      ...(m.width ? { width: m.width } : {}),
      ...(m.height ? { height: m.height } : {}),
      ...(m.duration !== undefined ? { duration: m.duration } : {}),
      ...(m.fpsNum && m.fpsDen ? { fpsNum: m.fpsNum, fpsDen: m.fpsDen } : {}),
      ...(m.thumbnailPath ? { thumbnailPath: m.thumbnailPath } : {}),
    };
    assets.push(asset);
    return asset;
  };
  const image = add(prepared.image, renderedVideo ? "video" : "image");
  const t = transformAt(clip, start),
    holdId = uuid();
  const ramp = Math.min(0.16, seconds / 4);
  const scale = Math.max(0.05, Math.min(4, t.scale)),
    zoom = Math.min(4, scale * s.zoom);
  let hold: TimelineClip = {
    id: holdId,
    trackId: track.id,
    assetId: image.id,
    timelineStart: start,
    sourceIn: 0,
    sourceOut: seconds,
    volume: 0,
    muted: true,
    ...t,
    scale,
    x: Math.max(-2, Math.min(2, t.x)),
    y: Math.max(-2, Math.min(2, t.y)),
    rotation: Math.max(-180, Math.min(180, t.rotation)),
    opacity: Math.max(0, Math.min(1, t.opacity)),
    ...(clip.crop ? { crop: clip.crop } : {}),
    ...(clip.fitMode ? { fitMode: clip.fitMode } : {}),
    ...(clip.fitBackground ? { fitBackground: clip.fitBackground } : {}),
    keyframes: {
      scale: [
        { t: 0, v: scale },
        { t: ramp, v: zoom },
        { t: seconds - ramp, v: zoom },
        { t: seconds, v: scale },
      ],
    },
  };
  if (moving) {
    try {
      hold = { ...hold, ...movingHighlightMotion(clip, start, seconds, s.zoom) };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
  const video: TimelineClip[] = [];
  if (start > clip.timelineStart + EPS) {
    const left = slice(clip, clip.timelineStart, start, clip.id);
    left.muted = true;
    delete left.transitionOut;
    video.push(left);
  }
  video.push(hold);
  if (stop < clipEnd(clip) - EPS) {
    const right = slice(clip, stop, clipEnd(clip), uuid());
    right.muted = true;
    delete right.transitionIn;
    video.push(right);
  }
  const tracks = project.tracks.map((tr) =>
    tr.id === track.id
      ? { ...tr, clips: tr.clips.flatMap((c) => (c.id === clip.id ? video : [c])) }
      : { ...tr },
  );
  const soundTrack = uuid();
  const sound: TimelineClip = {
    id: uuid(),
    trackId: soundTrack,
    assetId: clip.assetId,
    timelineStart: clip.timelineStart,
    sourceIn: clip.sourceIn,
    sourceOut: clip.sourceOut,
    volume: clip.volume,
    x: 0,
    y: 0,
    scale: 1,
    opacity: 1,
    speed: clip.speed,
    keepPitch: clip.keepPitch,
    reversed: clip.reversed,
    muted: clip.muted,
    fadeIn: fades.fadeIn,
    fadeOut: fades.fadeOut,
    clean: clip.clean,
    duck: clip.duck,
  };
  const audio: TimelineClip[] = [];
  const processed = prepared.audio ? add(prepared.audio, "audio") : null;
  if (prepared.hasAudio && voiceEffect(s)) {
    if (start > clip.timelineStart + EPS) {
      const left = slice(sound, clip.timelineStart, start, sound.id);
      left.fadeOut = 0;
      audio.push(left);
    }
    audio.push({
      id: uuid(),
      assetId: processed!.id,
      trackId: soundTrack,
      timelineStart: start,
      sourceIn: 0,
      sourceOut: seconds,
      volume: clip.volume,
      x: 0,
      y: 0,
      scale: 1,
      opacity: 1,
      duck: clip.duck,
    });
    if (stop < clipEnd(clip) - EPS) {
      const right = slice(sound, stop, clipEnd(clip), uuid());
      right.fadeIn = 0;
      audio.push(right);
    }
  } else if (prepared.hasAudio) audio.push(sound);
  if (audio.length)
    tracks.push({
      id: soundTrack,
      name: "Freeze Highlight — source voice",
      type: "audio",
      order: Math.max(-1, ...tracks.map((t) => t.order)) + 1,
      muted: track.muted,
      hidden: false,
      clips: audio,
    });
  if (s.audio === "impact" && processed) {
    const id = uuid();
    tracks.push({
      id,
      name: "Freeze Highlight — impact",
      type: "audio",
      order: Math.max(-1, ...tracks.map((t) => t.order)) + 1,
      muted: false,
      hidden: false,
      clips: [
        {
          id: uuid(),
          trackId: id,
          assetId: processed.id,
          timelineStart: start,
          sourceIn: 0,
          sourceOut: seconds,
          volume: 1,
          x: 0,
          y: 0,
          scale: 1,
          opacity: 1,
        },
      ],
    });
  }
  if (prepared.layers) {
    const foreground = add(prepared.layers.subject, "video");
    const plate = add({ ...prepared.layers.overlay, alpha: true }, "image");
    const imageTrack = uuid(),
      subjectTrack = uuid();
    for (const tr of tracks) if (tr.order > track.order) tr.order += 2;
    const common = {
      ...hold,
      fitMode: hold.fitMode === "blur-bg" ? ("fit" as const) : hold.fitMode,
      fitBackground: undefined,
    };
    tracks.push({
      id: imageTrack,
      name: "Highlight image (editable)",
      type: "video",
      order: track.order + 1,
      hidden: false,
      muted: true,
      clips: [
        {
          ...common,
          id: uuid(),
          trackId: imageTrack,
          assetId: plate.id,
          keyframes: { ...hold.keyframes, ...highlightImageKeys(s, seconds, hold.x, hold.y, hold.scale) },
        },
      ],
    });
    tracks.push({
      id: subjectTrack,
      name: "Highlight subject",
      type: "video",
      order: track.order + 2,
      hidden: false,
      muted: true,
      clips: [{ ...common, id: uuid(), trackId: subjectTrack, assetId: foreground.id }],
    });
  }
  return { ok: true, project: { ...project, assets, tracks } };
}

export async function createFreezeHighlight(
  clipId: string,
  playhead: number,
  s: FreezeHighlightSettings,
  options: { subtitles?: EffectSubtitleOverride; signal?: AbortSignal } = {},
): Promise<EditResult> {
  options.signal?.throwIfAborted();
  const snapshot = useProjectStore.getState().project;
  const w = freezeWindow(snapshot, clipId, playhead, s);
  const first = sourceTimeAt(w.clip, w.start),
    last = sourceTimeAt(w.clip, w.stop);
  const sourceFrame = (w.asset.fpsDen ?? 1) / (w.asset.fpsNum ?? snapshot.settings.fps);
  const frameTime = Math.max(w.clip.sourceIn, Math.min(first, w.clip.sourceOut - sourceFrame));
  const subtitlePlans = options.subtitles
    ? await prepareEffectSubtitles(snapshot, w.start, w.stop, options.subtitles, options.signal)
    : [];
  options.signal?.throwIfAborted();
  if (useProjectStore.getState().project !== snapshot)
    throw new Error("The project changed during subtitle preparation. No edit applied.");
  const cancel = () => {
    void invoke("cancel_ai_job").catch(() => undefined);
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  let prepared: PreparedFreeze;
  try {
    prepared = await invoke<PreparedFreeze>("prepare_freeze_highlight", {
      request: {
        path: w.asset.path,
        time: frameTime,
        sourceIn: Math.min(first, last),
        sourceOut: Math.max(first, last),
        seconds: w.stop - w.start,
        speed: clipSpeed(w.clip),
        keepPitch: w.clip.keepPitch !== false,
        reversed: w.clip.reversed === true,
        clean: w.clip.clean ?? { noise: 0, rumble: false },
        fps: snapshot.settings.fps,
        settings: {
          playback: s.playback,
          style: s.style,
          backgroundMode: s.backgroundMode,
          backgroundColor: s.backgroundColor,
          backgroundImage: s.backgroundImage,
          backgroundWidth: s.backgroundWidth,
          backgroundHeight: s.backgroundHeight,
          backgroundX: s.backgroundX,
          backgroundY: s.backgroundY,
          backgroundFit: s.backgroundFit,
          backgroundBase: s.backgroundBase,
          backgroundMotion: s.backgroundMotion,
          paperColor: s.paperColor,
          outlineColor: s.outlineColor,
          outlineWidth: s.outlineWidth,
          subjectZoom: s.subjectZoom,
          color: s.color,
          darkColor: s.darkColor,
          opacity: s.opacity,
          spacing: s.spacing,
          intensity: s.intensity,
          pattern: s.pattern,
          bend: s.bend,
          audio: s.audio,
          audioStrength: s.audioStrength,
        },
      },
    });
  } finally {
    options.signal?.removeEventListener("abort", cancel);
  }
  options.signal?.throwIfAborted();
  if (useProjectStore.getState().project !== snapshot)
    throw new Error(
      "The project changed during preparation. Nothing was applied; retry to use the cached result.",
    );
  const result = useProjectStore.getState().execute({
    label: s.playback === "moving" ? "Apply moving highlight style" : "Freeze Highlight",
    apply: (p) => {
      const result = applyFreezeHighlight(p, clipId, playhead, s, prepared);
      return result.ok && subtitlePlans.length ? applyEffectSubtitles(result.project, subtitlePlans) : result;
    },
  });
  if (result.ok) {
    const image = result.project.assets.find(
      (a) => a.path === (prepared.layers?.overlay.path ?? prepared.image.path),
    );
    const hold = result.project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.assetId === image?.id && Math.abs(c.timelineStart - w.start) < EPS);
    if (hold) useSelectionStore.getState().select(hold.id);
  }
  return result;
}
