import type { Project, TimelineTrack } from "@/project/model";
import { ROW_HEIGHT } from "./geometry";
import type { DropTarget } from "./placement";
import { addTrack, moveClip, type EditResult } from "./edit";
import { isTrackLocked } from "@/store/trackLocks";
import { findClip } from "./clips";

export const LAYER_EDGE = 8;
export function layerLayout(tracks: TimelineTrack[], heights: Record<string, number> = {}) {
  const video = tracks.filter((t) => t.type === "video").sort((a, b) => a.order - b.order);
  const audio = tracks.filter((t) => t.type === "audio").sort((a, b) => a.order - b.order);
  const sorted = [...video, ...audio];
  const offsets = new Map<string, number>();
  const rowHeight = (id: string) => heights[id] ?? ROW_HEIGHT;
  let cursor = 0;
  for (const t of video) {
    offsets.set(t.id, cursor);
    cursor += rowHeight(t.id);
  }
  const videoZone = cursor;
  cursor += ROW_HEIGHT;
  for (const t of audio) {
    offsets.set(t.id, cursor);
    cursor += rowHeight(t.id);
  }
  return {
    tracks: sorted,
    top: (id: string) => offsets.get(id) ?? 0,
    rowHeight,
    zones: { video: videoZone, audio: cursor },
    height: cursor + ROW_HEIGHT,
  };
}

/** The middle of a lane uses it; its top/bottom edge inserts a new compatible layer. */
export function layerTargetAtY(
  tracks: TimelineTrack[],
  y: number,
  time: number,
  heights: Record<string, number> = {},
): DropTarget {
  const layout = layerLayout(tracks, heights);
  for (const type of ["video", "audio"] as const) {
    const own = layout.tracks.filter((t) => t.type === type);
    for (let i = 0; i < own.length; i++) {
      const top = layout.top(own[i].id),
        rowHeight = layout.rowHeight(own[i].id);
      if (y >= top && y < top + rowHeight) {
        if (y - top < LAYER_EDGE)
          return { kind: "new-track", time, trackType: type, beforeTrackId: own[i].id };
        if (top + rowHeight - y <= LAYER_EDGE)
          return { kind: "new-track", time, trackType: type, beforeTrackId: own[i + 1]?.id ?? null };
        return { kind: "track", trackId: own[i].id, time };
      }
    }
    if (y >= layout.zones[type] && y < layout.zones[type] + ROW_HEIGHT)
      return { kind: "new-track", time, trackType: type, beforeTrackId: null };
  }
  const type = y < 0 ? "video" : "audio";
  return {
    kind: "new-track",
    time,
    trackType: type,
    beforeTrackId: y < 0 ? (layout.tracks.find((t) => t.type === type)?.id ?? null) : null,
  };
}

/** Keep visual and audio areas together; preserve the relative compositing order of existing videos. */
export function insertLayerTrack(
  project: Project,
  type: "video" | "audio",
  id: string,
  beforeTrackId?: string | null,
): EditResult {
  const added = addTrack(project, type, id);
  if (!added.ok) return added;
  const layout = layerLayout(project.tracks);
  const own = layout.tracks.filter((t) => t.type === type);
  const at = own.findIndex((t) => t.id === beforeTrackId);
  own.splice(
    at < 0 ? own.length : at,
    0,
    added.project.tracks.find((t) => t.id === id)!,
  );
  const tracks = (
    type === "video"
      ? [...own, ...layout.tracks.filter((t) => t.type === "audio")]
      : [...layout.tracks.filter((t) => t.type === "video"), ...own]
  ).map((t, order) => ({ ...t, order }));
  return { ok: true, project: { ...project, tracks } };
}
export function moveClipToNewLayer(
  project: Project,
  clipId: string,
  start: number,
  trackId: string,
  beforeTrackId?: string | null,
): EditResult {
  const found = findClip(project, clipId);
  if (!found) return { ok: false, error: { code: "unknown-clip", message: "The clip no longer exists" } };
  const added = insertLayerTrack(project, found.track.type, trackId, beforeTrackId);
  return added.ok ? moveClip(added.project, clipId, { start, trackId }) : added;
}

/** Empty media layers are unnecessary because each section already has a permanent drop row. */
export function removeEmptyLayers(project: Project): Project {
  const tracks = project.tracks.filter((t) => t.clips.length > 0 || isTrackLocked(project.id, t.id));
  return tracks.length === project.tracks.length ? project : { ...project, tracks };
}
export function deleteLayerTrack(project: Project, trackId: string): EditResult {
  if (!project.tracks.some((t) => t.id === trackId))
    return { ok: false, error: { code: "unknown-track", message: "The track no longer exists" } };
  return { ok: true, project: { ...project, tracks: project.tracks.filter((t) => t.id !== trackId) } };
}
/** Cleanup only accompanies a successful edit; invalid drops and no-op clicks leave tracks untouched. */
export function cleanLayersAfterMove(before: Project, result: EditResult): EditResult {
  return result.ok && result.project !== before
    ? { ok: true, project: removeEmptyLayers(result.project) }
    : result;
}
