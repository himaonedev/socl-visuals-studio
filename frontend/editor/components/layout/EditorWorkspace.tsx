import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";

export const INSPECTOR_WIDTH_KEY = "cutvii-inspector-width-v1";
const DEFAULT_WIDTH = 320,
  MIN_WIDTH = 280,
  MAX_WIDTH = 640;
export function inspectorWidth(value: number, container: number) {
  const max = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, container - 288 - 240));
  return Math.round(Math.max(MIN_WIDTH, Math.min(max, Number.isFinite(value) ? value : DEFAULT_WIDTH)));
}
function storedWidth() {
  try {
    const value = Number(localStorage.getItem(INSPECTOR_WIDTH_KEY) ?? DEFAULT_WIDTH);
    return Number.isFinite(value) && value >= MIN_WIDTH && value <= MAX_WIDTH ? value : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}
/** Desktop divider adjusts only workspace geometry; preview and project settings are independent. */
export function EditorWorkspace({ children }: { children: ReactNode }) {
  const root = useRef<HTMLElement>(null),
    separator = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(storedWidth);
  const preferred = useRef(width);
  const [maximum, setMaximum] = useState(MAX_WIDTH);
  const cleanup = useRef<(() => void) | null>(null);
  const containerWidth = () => root.current?.clientWidth || window.innerWidth || 1024;
  useLayoutEffect(() => {
    const measure = () => {
      if (cleanup.current) return;
      const available = root.current?.clientWidth || window.innerWidth || 1024;
      setWidth(inspectorWidth(preferred.current, available));
      setMaximum(inspectorWidth(MAX_WIDTH, available));
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (root.current) observer?.observe(root.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      cleanup.current?.();
    };
  }, []);
  const commit = (value: number) => {
    const next = inspectorWidth(value, containerWidth());
    setMaximum(inspectorWidth(MAX_WIDTH, containerWidth()));
    preferred.current = next;
    setWidth(next);
    root.current?.style.setProperty("--inspector-width", `${next}px`);
    try {
      localStorage.setItem(INSPECTOR_WIDTH_KEY, String(next));
    } catch {
      /* Layout remains adjustable without storage. */
    }
  };
  const begin = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    cleanup.current?.();
    e.preventDefault();
    e.stopPropagation();
    separator.current?.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const startX = e.clientX,
      startWidth = width,
      id = e.pointerId;
    const oldCursor = document.body.style.cursor,
      oldSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    let pending = startWidth,
      raf = 0;
    const paint = () => {
      raf = 0;
      root.current?.style.setProperty("--inspector-width", `${pending}px`);
      separator.current?.setAttribute("aria-valuenow", String(pending));
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== id) return;
      pending = inspectorWidth(startWidth + startX - event.clientX, containerWidth());
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      document.body.style.cursor = oldCursor;
      document.body.style.userSelect = oldSelect;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      cleanup.current = null;
    };
    const cancel = () => {
      stop();
      root.current?.style.setProperty("--inspector-width", `${startWidth}px`);
      separator.current?.setAttribute("aria-valuenow", String(startWidth));
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== id) return;
      pending = inspectorWidth(startWidth + startX - event.clientX, containerWidth());
      stop();
      commit(pending);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    cleanup.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
  };
  return (
    <main
      ref={root}
      data-editor-workspace
      style={{ "--inspector-width": `${width}px` } as CSSProperties}
      className="relative grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[18rem_minmax(0,1fr)_var(--inspector-width)] lg:grid-rows-[minmax(0,1fr)_16rem]"
    >
      {children}
      <div
        ref={separator}
        role="separator"
        aria-label="Resize Inspector"
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maximum}
        aria-valuenow={width}
        tabIndex={0}
        title="Drag to resize Inspector. Double-click to reset. Arrow keys adjust width; Escape cancels dragging."
        className="group absolute top-0 bottom-64 z-40 hidden w-2 translate-x-1/2 cursor-col-resize touch-none select-none items-center justify-center outline-none hover:bg-accent/15 focus-visible:bg-accent/15 focus-visible:ring-1 focus-visible:ring-accent lg:flex"
        style={{ right: "var(--inspector-width)" }}
        onPointerDown={begin}
        onDoubleClick={() => commit(DEFAULT_WIDTH)}
        onKeyDown={(e) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(e.key)) return;
          e.preventDefault();
          e.stopPropagation();
          const step = e.shiftKey ? 32 : 16;
          commit(
            e.key === "Home"
              ? MIN_WIDTH
              : e.key === "End"
                ? maximum
                : e.key === "Enter"
                  ? DEFAULT_WIDTH
                  : width + (e.key === "ArrowLeft" ? step : -step),
          );
        }}
      >
        <span className="h-10 w-0.5 rounded bg-border group-hover:bg-accent group-focus-visible:bg-accent" />
      </div>
    </main>
  );
}
