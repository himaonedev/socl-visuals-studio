import { invoke } from "@tauri-apps/api/core";
import {
  TextStyleSchema,
  type Project,
  type TextSpec,
  type TextStyle,
  type MediaAsset,
  type TimelineClip,
} from "@/project/model";
import { isTrackLocked } from "@/store/trackLocks";
import { clipEnd, clipDuration, EPS, findClip } from "./clips";
import { sourceTimeAt, type EditResult } from "./edit";
import { withStyle } from "./textStyles";
import { DEFAULT_WORD_HIGHLIGHT } from "./wordCaptions";

export interface EffectSubtitleOverride {
  trackIds: string[];
  style: TextStyle;
}
export const DEFAULT_EFFECT_SUBTITLE_STYLE: TextStyle = {
  color: "#A5A5A5",
  bold: true,
  font: "Barlow",
  box: { color: "#202528", opacity: 0.95, shape: "per-line", padding: 0.12, radius: 0.08 },
  highlight: { color: "#FFFFFF", lines: "last", word: { ...DEFAULT_WORD_HIGHLIGHT, opacity: 0 } },
};
export interface SubtitleStylePlan {
  clipId: string;
  parts: { start: number; end: number; asset: MediaAsset }[];
}
export function effectSubtitleTracks(project: Project) {
  const textIds = new Set(project.assets.filter((a) => a.text).map((a) => a.id));
  return project.tracks.filter((t) => t.type === "video" && t.clips.some((c) => textIds.has(c.assetId)));
}
/** Native word states keep their exact index/times. Plain captions get estimated colour timings only. */
function spans(
  clip: TimelineClip,
  spec: TextSpec,
  start: number,
  end: number,
  style: TextStyle,
  fps: number,
) {
  const make = (a: number, b: number, index?: number) => ({
    start: a,
    end: b,
    spec:
      index === undefined
        ? withStyle(spec, style)
        : {
            ...withStyle(spec, style),
            highlight: { ...style.highlight!, word: { ...style.highlight!.word!, index } },
          },
  });
  if (!style.highlight?.word || spec.highlight?.word) return [make(start, end)];
  const words = spec.content.trim().split(/\s+/u).filter(Boolean),
    weights = words.map((w) => Math.max(1, [...w].length));
  const total = weights.reduce((a, b) => a + b, 0);
  let used = 0,
    previous = clip.timelineStart;
  const result = [];
  for (let i = 0; i < words.length; i++) {
    used += weights[i];
    const stop =
      i === words.length - 1
        ? clipEnd(clip)
        : Math.max(
            previous,
            Math.round((clip.timelineStart + (clipDuration(clip) * used) / total) * fps) / fps,
          );
    const a = Math.max(start, previous),
      b = Math.min(end, stop);
    if (b > a + EPS) result.push(make(a, b, i));
    previous = stop;
  }
  return result;
}
/** Draw only the affected caption states, sequentially, and reuse identical pictures/specs. */
export async function prepareEffectSubtitles(
  project: Project,
  start: number,
  end: number,
  override: EffectSubtitleOverride,
  signal?: AbortSignal,
): Promise<SubtitleStylePlan[]> {
  const style = TextStyleSchema.parse(override.style);
  const ids = new Set(override.trackIds),
    assets = new Map(project.assets.map((a) => [a.id, a]));
  const selected = project.tracks.filter((t) => ids.has(t.id) && t.type === "video");
  const plans: SubtitleStylePlan[] = [];
  const drawn = new Map<string, MediaAsset>();
  for (const track of selected) {
    const clips = track.clips.filter(
      (c) => assets.get(c.assetId)?.text && c.timelineStart < end - EPS && clipEnd(c) > start + EPS,
    );
    if (clips.length && isTrackLocked(project.id, track.id))
      throw new Error(`Subtitle track "${track.name}" is locked. Unlock it before applying.`);
    for (const clip of clips) {
      const original = assets.get(clip.assetId)!;
      const parts = [];
      for (const part of spans(
        clip,
        original.text!,
        Math.max(start, clip.timelineStart),
        Math.min(end, clipEnd(clip)),
        style,
        project.settings.fps,
      )) {
        signal?.throwIfAborted();
        const key = JSON.stringify(part.spec);
        let asset = drawn.get(key);
        if (!asset) {
          const path = await invoke<string>("render_text", {
            spec: part.spec,
            width: project.settings.width,
            height: project.settings.height,
          });
          signal?.throwIfAborted();
          if (typeof path !== "string" || !path)
            throw new Error("The effect subtitle picture could not be drawn");
          asset = {
            ...original,
            id: crypto.randomUUID(),
            path,
            text: part.spec,
            width: project.settings.width,
            height: project.settings.height,
          };
          drawn.set(key, asset);
        }
        parts.push({ start: part.start, end: part.end, asset });
      }
      if (parts.length) plans.push({ clipId: clip.id, parts });
    }
  }
  if (!plans.length)
    throw new Error(
      "No subtitles overlap this effect on the checked tracks. Choose another track/range or disable the subtitle override.",
    );
  return plans;
}
export function applyEffectSubtitles(
  project: Project,
  plans: SubtitleStylePlan[],
  uuid: () => string = () => crypto.randomUUID(),
): EditResult {
  const replacements = new Map<string, TimelineClip[]>(),
    assets = new Map(project.assets.map((a) => [a.id, a]));
  for (const plan of plans) {
    const found = findClip(project, plan.clipId);
    const original = found && assets.get(found.clip.assetId);
    if (!found || !original?.text)
      return {
        ok: false,
        error: { code: "unknown-clip", message: "The subtitle changed during preparation" },
      };
    const clip = found.clip,
      parts = [...plan.parts].sort((a, b) => a.start - b.start);
    const ranges: { start: number; end: number; assetId: string }[] = [];
    let cursor = clip.timelineStart;
    for (const part of parts) {
      if (part.start < cursor - EPS || part.end > clipEnd(clip) + EPS || part.end <= part.start)
        return {
          ok: false,
          error: { code: "out-of-range", message: "The subtitle style interval is invalid" },
        };
      if (part.start > cursor + EPS) ranges.push({ start: cursor, end: part.start, assetId: clip.assetId });
      assets.set(part.asset.id, part.asset);
      ranges.push({ start: part.start, end: part.end, assetId: part.asset.id });
      cursor = part.end;
    }
    if (cursor < clipEnd(clip) - EPS)
      ranges.push({ start: cursor, end: clipEnd(clip), assetId: clip.assetId });
    replacements.set(
      clip.id,
      ranges.map((r, i) => {
        const a = sourceTimeAt(clip, r.start),
          b = sourceTimeAt(clip, r.end);
        const next = {
          ...clip,
          id: i === 0 ? clip.id : uuid(),
          timelineStart: r.start,
          assetId: r.assetId,
          sourceIn: Math.min(a, b),
          sourceOut: Math.max(a, b),
        };
        // Source-time keys remain untouched, so a split never restarts Apple/slide motion.
        if (r.start > clip.timelineStart + EPS) delete next.transitionIn;
        if (r.end < clipEnd(clip) - EPS) delete next.transitionOut;
        return next;
      }),
    );
  }
  return {
    ok: true,
    project: {
      ...project,
      assets: [...assets.values()],
      tracks: project.tracks.map((t) =>
        t.clips.some((c) => replacements.has(c.id))
          ? { ...t, clips: t.clips.flatMap((c) => replacements.get(c.id) ?? [c]) }
          : t,
      ),
    },
  };
}
