/** Live-layout side of drag & drop: pointer position -> timeline target, and edge auto-scroll. */
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useTimelineViewStore } from "@/store/timelineView";
import { HEADER_WIDTH, RULER_HEIGHT, SNAP_PX, xToTime } from "./geometry";
import { layerTargetAtY } from "./layerLayout";
import type { DropTarget } from "./placement";
import { snapTime } from "./snap";

export const EDGE_PX = 56;
export const MAX_SCROLL_PER_FRAME = 18;

export const timelineScroller = () => document.querySelector<HTMLElement>("[data-timeline-scroller]");

export function timelineViewport(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const inset = el.hasAttribute("data-timeline-shared-scroll") ? HEADER_WIDTH : 0;
  return {
    left: r.left + inset,
    right: r.right,
    top: r.top,
    bottom: r.bottom,
    width: el.clientWidth ? Math.max(0, el.clientWidth - inset) : 0,
  };
}

/** The lane and snapped time under a window position, or null when it is not over the timeline. */
export function dropTargetAt(x: number, y: number): DropTarget | null {
  const area = document.querySelector("[data-timeline-area]")?.getBoundingClientRect();
  const lanes = document.querySelector("[data-timeline-lanes]")?.getBoundingClientRect();
  if (!area || !lanes) return null;

  const project = useProjectStore.getState().project;
  const { pps, snapping, trackHeights } = useTimelineViewStore.getState();
  const shared = timelineScroller()?.hasAttribute("data-timeline-shared-scroll");
  const left = area.left + (shared ? HEADER_WIDTH : 0),
    top = area.top + (shared ? RULER_HEIGHT : 0);
  if (area.right <= left || area.bottom <= top || x < left || x > area.right || y < top || y > area.bottom)
    return null;
  const target = layerTargetAtY(
    project.tracks,
    y - lanes.top,
    Math.max(0, xToTime(x - lanes.left, pps)),
    trackHeights,
  );
  if (!target) return null;
  const { time } = snapTime(project, target.time, {
    playhead: usePlaybackStore.getState().playhead,
    threshold: snapping ? SNAP_PX / pps : 0,
  });
  return { ...target, time };
}

/** Pixels to scroll this frame for a pointer at `x` inside [left, right]: faster the closer to the edge. */
export function edgeScrollDelta(x: number, left: number, right: number): number {
  if (right - left < EDGE_PX * 2) return 0;
  if (x < left + EDGE_PX)
    return -Math.ceil((MAX_SCROLL_PER_FRAME * Math.min(EDGE_PX, left + EDGE_PX - x)) / EDGE_PX);
  if (x > right - EDGE_PX)
    return Math.ceil((MAX_SCROLL_PER_FRAME * Math.min(EDGE_PX, x - (right - EDGE_PX))) / EDGE_PX);
  return 0;
}

/** Scroll the timeline when the pointer is near its left/right edge. Returns true when it moved. */
export function autoScrollTimeline(x: number, y: number): boolean {
  const el = timelineScroller();
  if (!el) return false;
  const r = timelineViewport(el);
  if (y < r.top || y > r.bottom) return false;
  const delta = edgeScrollDelta(x, r.left, r.right);
  const vertical = edgeScrollDelta(y, r.top + RULER_HEIGHT, r.bottom);
  const before = el.scrollLeft,
    beforeTop = el.scrollTop;
  el.scrollLeft = Math.max(0, before + delta);
  el.scrollTop = Math.max(0, Math.min(Math.max(0, el.scrollHeight - el.clientHeight), beforeTop + vertical));
  return el.scrollLeft !== before || el.scrollTop !== beforeTop;
}
