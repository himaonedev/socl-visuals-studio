import { duplicateClipAt } from "./duplicateDrag";
import { useCallback, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { Project } from "@/project/model";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useTimelineViewStore } from "@/store/timelineView";
import { findClip, clipDuration } from "./clips";
import { placeClip, trimClip } from "./edit";
import { isTrackLocked } from "@/store/trackLocks";
import { protectLockedTracks } from "./trackLock";
import { layerTargetAtY, moveClipToNewLayer } from "./layerLayout";
import { autoScrollTimeline, timelineScroller } from "./dropTargeting";
import { duplicateClipByDrag, dropClipOnNewLayer, dropClipAt, report, trimClipEdge } from "./editor";
import { SNAP_PX } from "./geometry";
import { quantizeToFrame, snapClipMove, snapTime } from "./snap";

const DRAG_THRESHOLD_PX = 3;

export type DragState =
  | {
      kind: "move";
      copy: boolean;
      copyId: string;
      clipId: string;
      start: number;
      trackId: string;
      newLayer?: { trackId: string; beforeTrackId?: string | null };
      duration: number;
      valid: boolean;
      error?: string;
      /** The project as it would look if dropped now (only when valid). */
      preview: Project | null;
      guide: number | null;
      /** How far the clip has gone from where it was (seconds; where it lands, not where the pointer is). */
      delta: number;
      /** Where the pointer is, for the little time label that follows it. */
      pointer: { x: number; y: number };
    }
  | {
      kind: "trim";
      clipId: string;
      edge: "start" | "end";
      time: number;
      preview: Project;
      guide: number | null;
    };

/**
 * Move/trim drags with live preview. Listeners live on `window` so the drag survives the clip element
 * being re-parented (cross-track moves). Nothing is committed to history until pointer-up.
 */
export function useTimelineDrag(lanesRef: RefObject<HTMLElement | null>) {
  const [drag, setDrag] = useState<DragState | null>(null);

  const begin = useCallback(
    (e: ReactPointerEvent, clipId: string, mode: "move" | { trim: "start" | "end" }) => {
      if (e.button !== 0) return;
      const origin = useProjectStore.getState().project;
      const found = findClip(origin, clipId);
      if (!found || isTrackLocked(origin.id, found.track.id)) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const originalScroll = timelineScroller()?.scrollLeft ?? 0;
      const newTrackId = crypto.randomUUID();
      const copyId = crypto.randomUUID();
      let copyMode = e.altKey;
      let raf = 0;
      let lastPointer: PointerEvent | null = null;
      const originStart = found.clip.timelineStart;
      const duration = clipDuration(found.clip);
      let moved = false;
      let last: DragState | null = null;

      const compute = (ev: PointerEvent): DragState | null => {
        const project = useProjectStore.getState().project;
        if (!findClip(project, clipId)) return null;
        const { pps, snapping } = useTimelineViewStore.getState();
        const playhead = usePlaybackStore.getState().playhead;
        const threshold = snapping ? SNAP_PX / pps : 0;
        const dt = (ev.clientX - startX + (timelineScroller()?.scrollLeft ?? 0) - originalScroll) / pps;

        if (mode === "move") {
          const clip = findClip(project, clipId)!.clip;
          const desired = originStart + dt;
          const snap = snapping
            ? snapClipMove(project, copyMode ? { ...clip, id: copyId } : clip, desired, {
                playhead,
                threshold,
              })
            : { time: Math.max(0, quantizeToFrame(desired, project.settings.fps)), snappedTo: null };
          const top = lanesRef.current?.getBoundingClientRect().top ?? 0;
          let target = layerTargetAtY(
            project.tracks,
            ev.clientY - top,
            snap.time,
            useTimelineViewStore.getState().trackHeights,
          );
          const hoveredId = target.kind === "track" ? target.trackId : null;
          if (hoveredId && project.tracks.find((t) => t.id === hoveredId)?.type !== found.track.type)
            target = { kind: "new-track", time: snap.time, trackType: found.track.type, beforeTrackId: null };
          const beforeTrackId =
            target.kind === "new-track" && target.trackType === found.track.type
              ? target.beforeTrackId
              : null;
          const trackId = target.kind === "track" ? target.trackId : newTrackId;
          const r = protectLockedTracks(
            project,
            copyMode
              ? duplicateClipAt(
                  project,
                  clipId,
                  { start: snap.time, trackId, createTrack: target.kind === "new-track", beforeTrackId },
                  copyId,
                )
              : target.kind === "new-track"
                ? moveClipToNewLayer(project, clipId, snap.time, newTrackId, beforeTrackId)
                : placeClip(project, clipId, { start: snap.time, trackId }),
          );
          return {
            kind: "move",
            copy: copyMode,
            copyId,
            clipId,
            start: snap.time,
            trackId,
            newLayer: target.kind === "new-track" ? { trackId: newTrackId, beforeTrackId } : undefined,
            duration,
            valid: r.ok,
            error: r.ok ? undefined : r.error.message,
            preview: r.ok ? r.project : null,
            guide: snap.snappedTo ? snap.time : null,
            delta:
              (r.ok
                ? (findClip(r.project, copyMode ? copyId : clipId)?.clip.timelineStart ?? snap.time)
                : snap.time) - originStart,
            pointer: { x: ev.clientX, y: ev.clientY },
          };
        }

        const origEdge = mode.trim === "start" ? originStart : originStart + duration;
        const snap = snapping
          ? snapTime(project, origEdge + dt, { playhead, threshold, excludeClipId: clipId })
          : { time: Math.max(0, quantizeToFrame(origEdge + dt, project.settings.fps)), snappedTo: null };
        const r = trimClip(project, clipId, mode.trim, snap.time);
        return {
          kind: "trim",
          clipId,
          edge: mode.trim,
          time: snap.time,
          preview: r.ok ? r.project : project,
          guide: snap.snappedTo ? snap.time : null,
        };
      };

      const cleanup = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("keyup", onKeyUp);
      };
      const frame = () => {
        if (lastPointer && autoScrollTimeline(lastPointer.clientX, lastPointer.clientY)) {
          last = compute(lastPointer);
          setDrag(last);
        }
        raf = requestAnimationFrame(frame);
      };
      const onMove = (ev: PointerEvent) => {
        copyMode = ev.altKey;
        lastPointer = ev;
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
        if (!moved) raf = requestAnimationFrame(frame);
        moved = true;
        last = compute(ev);
        if (!last) return onCancel();
        setDrag(last);
      };
      const onUp = () => {
        cleanup();
        setDrag(null);
        if (!moved || !last) return;
        if (last.kind === "move") {
          if (last.valid) {
            if (last.copy)
              duplicateClipByDrag(
                last.clipId,
                {
                  start: last.start,
                  trackId: last.trackId,
                  createTrack: Boolean(last.newLayer),
                  beforeTrackId: last.newLayer?.beforeTrackId,
                },
                last.copyId,
              );
            else if (last.newLayer)
              dropClipOnNewLayer(last.clipId, last.start, last.newLayer.trackId, last.newLayer.beforeTrackId);
            else dropClipAt(last.clipId, last.start, last.trackId);
          } else if (last.error) report({ ok: false, error: { code: "overlap", message: last.error } });
        } else {
          trimClipEdge(last.clipId, last.edge, last.time);
        }
      };
      const onCancel = () => {
        cleanup();
        setDrag(null);
      };
      const refreshMode = (value: boolean) => {
        copyMode = value;
        if (moved && lastPointer) {
          last = compute(lastPointer);
          setDrag(last);
        }
      };
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") onCancel();
        else if (ev.key === "Alt") {
          ev.preventDefault();
          refreshMode(true);
        }
      };
      const onKeyUp = (ev: KeyboardEvent) => {
        if (ev.key === "Alt") {
          ev.preventDefault();
          refreshMode(false);
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey);
      window.addEventListener("keyup", onKeyUp);
    },
    [lanesRef],
  );

  return { drag, begin };
}
