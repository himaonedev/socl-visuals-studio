import { create } from "zustand";
import { clampPps, DEFAULT_PPS } from "@/timeline/geometry";
import { ZOOM_STEP } from "@/timeline/zoom";

interface TimelineViewState {
  /** Pixels per second. UI state only: never saved in the project. */
  pps: number;
  snapping: boolean;
  trackHeights: Record<string, number>;
  waveformSizes: Record<string, number>;
  setTrackHeight: (id: string, height: number) => void;
  setWaveformSize: (id: string, size: number) => void;
  /** Scroll position the timeline should take after a zoom (so the anchor stays put). `n` makes each request unique. */
  scrollTarget: { left: number; n: number } | null;
  setPps: (pps: number) => void;
  /** Zoom and scroll together, as computed by the zoom math. */
  applyZoom: (pps: number, scrollLeft: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  toggleSnapping: () => void;
}

export const useTimelineViewStore = create<TimelineViewState>((set) => ({
  pps: DEFAULT_PPS,
  snapping: true,
  trackHeights: {},
  waveformSizes: {},
  setTrackHeight: (id, height) => {
    if ([40, 64, 96, 128].includes(height))
      set((s) => ({ trackHeights: { ...s.trackHeights, [id]: height } }));
  },
  setWaveformSize: (id, size) => {
    if ([0, 0.5, 1, 1.5].includes(size)) set((s) => ({ waveformSizes: { ...s.waveformSizes, [id]: size } }));
  },
  scrollTarget: null,
  setPps: (pps) => set({ pps: clampPps(pps) }),
  applyZoom: (pps, scrollLeft) =>
    set((s) => ({
      pps: clampPps(pps),
      scrollTarget: { left: Math.max(0, scrollLeft), n: (s.scrollTarget?.n ?? 0) + 1 },
    })),
  zoomIn: () => set((s) => ({ pps: clampPps(s.pps * ZOOM_STEP) })),
  zoomOut: () => set((s) => ({ pps: clampPps(s.pps / ZOOM_STEP) })),
  toggleSnapping: () => set((s) => ({ snapping: !s.snapping })),
}));
