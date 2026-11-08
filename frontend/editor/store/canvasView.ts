import { create } from "zustand";
export const MIN_CANVAS_ZOOM = 0.25,
  MAX_CANVAS_ZOOM = 4;
export function zoomAt(
  view: { zoom: number; x: number; y: number },
  next: number,
  point: { x: number; y: number },
) {
  const zoom = Math.max(MIN_CANVAS_ZOOM, Math.min(MAX_CANVAS_ZOOM, next));
  if (!Number.isFinite(zoom) || zoom === view.zoom) return view;
  const ratio = zoom / view.zoom;
  return { zoom, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio };
}
interface CanvasView {
  zoom: number;
  x: number;
  y: number;
  setZoom: (zoom: number, point?: { x: number; y: number }) => void;
  pan: (x: number, y: number) => void;
  reset: () => void;
}
export const useCanvasViewStore = create<CanvasView>((set) => ({
  zoom: 1,
  x: 0,
  y: 0,
  setZoom: (zoom, point = { x: 0, y: 0 }) => set((s) => zoomAt(s, zoom, point)),
  pan: (x, y) => {
    if (Number.isFinite(x) && Number.isFinite(y)) set({ x, y });
  },
  reset: () => set({ zoom: 1, x: 0, y: 0 }),
}));
