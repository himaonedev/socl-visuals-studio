import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useTimelineViewStore } from "@/store/timelineView";
import { clipDuration } from "./clips";
import { layerLayout } from "./layerLayout";

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
/** Empty-lane drag selects by project coordinates, including clips outside DOM virtualization. */
export function useMarqueeSelection(lanes: RefObject<HTMLElement | null>) {
  const [box, setBox] = useState<Box | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const begin = (event: ReactPointerEvent) => {
    if (
      event.button !== 0 ||
      !lanes.current ||
      !(event.target instanceof Element) ||
      event.target.closest('[data-clip-id],button,input,select,[role="slider"]')
    )
      return;
    cleanup.current?.();
    event.preventDefault();
    event.stopPropagation();
    lanes.current.focus({ preventScroll: true });
    const original = useSelectionStore.getState();
    const initial = [...original.selectedClipIds],
      anchor = original.clipAnchor;
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    const bounds = lanes.current.getBoundingClientRect();
    const start = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    let last = { x: event.clientX, y: event.clientY };
    let moved = false,
      raf = 0;
    const pointer = event.pointerId;
    if (!additive) useSelectionStore.getState().clear();
    useSelectionStore.getState().setArea("timeline");
    const update = () => {
      raf = 0;
      if (!lanes.current) return;
      const r = lanes.current.getBoundingClientRect();
      const end = { x: last.x - r.left, y: last.y - r.top };
      if (!moved && Math.hypot(end.x - start.x, end.y - start.y) < 3) return;
      moved = true;
      const rect = {
        left: Math.max(0, Math.min(start.x, end.x)),
        top: Math.max(0, Math.min(start.y, end.y)),
        width: Math.max(0, Math.max(end.x, start.x)) - Math.max(0, Math.min(end.x, start.x)),
        height: Math.max(0, Math.max(end.y, start.y)) - Math.max(0, Math.min(end.y, start.y)),
      };
      setBox(rect);
      const project = useProjectStore.getState().project;
      const view = useTimelineViewStore.getState();
      const layout = layerLayout(project.tracks, view.trackHeights);
      const selected = layout.tracks.flatMap((track) =>
        track.clips
          .filter((clip) => {
            const x = clip.timelineStart * view.pps,
              y = layout.top(track.id) + 4;
            return (
              x < rect.left + rect.width &&
              x + Math.max(2, clipDuration(clip) * view.pps) > rect.left &&
              y < rect.top + rect.height &&
              y + layout.rowHeight(track.id) - 8 > rect.top
            );
          })
          .map((c) => c.id),
      );
      const ids = additive ? [...new Set([...initial, ...selected])] : selected;
      if (ids.join("\0") !== useSelectionStore.getState().selectedClipIds.join("\0"))
        useSelectionStore.getState().setSelection(ids);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      last = { x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(update);
    };
    const scroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scroll, true);
      cleanup.current = null;
      setBox(null);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      if (moved || raf) {
        last = { x: e.clientX, y: e.clientY };
        update();
      }
      stop();
    };
    const cancel = () => {
      useSelectionStore.setState({ selectedClipIds: initial, clipAnchor: anchor });
      stop();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    };
    cleanup.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scroll, true);
  };
  return { box, begin };
}
