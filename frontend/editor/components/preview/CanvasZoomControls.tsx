import { ZoomIn, ZoomOut, Maximize } from "lucide-react";
import { useCanvasViewStore } from "@/store/canvasView";
import { IconButton } from "@/components/IconButton";

export function CanvasZoomControls() {
  const zoom = useCanvasViewStore((s) => s.zoom);
  return (
    <div
      data-canvas-zoom-controls
      className="absolute top-2 right-2 z-[60] flex items-center gap-0.5 rounded-md border bg-surface-1/95 p-0.5 shadow"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <IconButton
        label="Zoom canvas out"
        icon={<ZoomOut />}
        size="icon-sm"
        disabled={zoom <= 0.25}
        onClick={() => useCanvasViewStore.getState().setZoom(zoom / 1.2)}
      />
      <select
        aria-label="Canvas zoom"
        title="Canvas view zoom (Ctrl + scroll). Middle-mouse drag to pan."
        className="h-7 w-[90px] rounded bg-surface-1 px-1 text-center text-xs text-text outline-none focus:ring-1 focus:ring-accent"
        value={Number(zoom.toFixed(4))}
        onChange={(e) => {
          const value = Number(e.target.value);
          if (value === 1) useCanvasViewStore.getState().reset();
          else useCanvasViewStore.getState().setZoom(value);
        }}
      >
        {![0.25, 0.5, 1, 1.5, 2, 3, 4].some((v) => Math.abs(v - zoom) < 0.00001) && (
          <option value={Number(zoom.toFixed(4))}>{Math.round(zoom * 100)}%</option>
        )}
        {[0.25, 0.5, 1, 1.5, 2, 3, 4].map((v) => (
          <option key={v} value={v}>
            {v === 1 ? "Fit (100%)" : `${v * 100}%`}
          </option>
        ))}
      </select>
      <IconButton
        label="Zoom canvas in"
        icon={<ZoomIn />}
        size="icon-sm"
        disabled={zoom >= 4}
        onClick={() => useCanvasViewStore.getState().setZoom(zoom * 1.2)}
      />
      <IconButton
        label="Fit canvas to preview"
        icon={<Maximize />}
        size="icon-sm"
        onClick={() => useCanvasViewStore.getState().reset()}
      />
    </div>
  );
}
