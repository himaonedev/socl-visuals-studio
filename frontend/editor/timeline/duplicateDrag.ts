import type { Project } from "@/project/model";
import { findClip } from "./clips";
import { moveClip, type EditResult } from "./edit";
import { insertLayerTrack } from "./layerLayout";
import { isTrackLocked } from "@/store/trackLocks";

export interface DuplicateDrop {
  start: number;
  trackId: string;
  createTrack?: boolean;
  beforeTrackId?: string | null;
}
/** Clone every clip setting; validate the destination without moving/rippling the original. */
export function duplicateClipAt(project: Project, clipId: string, to: DuplicateDrop, id: string): EditResult {
  const source = findClip(project, clipId);
  if (!source)
    return { ok: false, error: { code: "unknown-clip", message: "The source clip no longer exists" } };
  if (isTrackLocked(project.id, source.track.id))
    return {
      ok: false,
      error: { code: "out-of-range", message: "Unlock the source track before dragging a copy" },
    };
  let next = project;
  if (to.createTrack) {
    const added = insertLayerTrack(next, source.track.type, to.trackId, to.beforeTrackId);
    if (!added.ok) return added;
    next = added.project;
  }
  const copy = { ...source.clip, id };
  const temporary = {
    ...next,
    tracks: next.tracks.map((t) => (t.id === source.track.id ? { ...t, clips: [...t.clips, copy] } : t)),
  };
  return moveClip(temporary, id, { start: to.start, trackId: to.trackId });
}
