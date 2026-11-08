import { useRef } from "react";
import { mediaUrl, thumbnailUrl } from "@/lib/media";
import { Button } from "@/components/ui/button";
import type { FreezeHighlightSettings } from "@/timeline/freezeHighlight";

export function BackgroundImagePlacement({
  settings: s,
  onChange,
  aspect,
  sourceThumbnail,
}: {
  settings: FreezeHighlightSettings;
  onChange: (patch: Partial<FreezeHighlightSettings>) => void;
  aspect: number;
  sourceThumbnail?: string;
}) {
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  return (
    <div className="space-y-3">
      <label className="block text-xs text-text-muted">
        Image animation
        <select
          aria-label="Background image animation"
          className="h-9 w-full rounded border bg-surface-2 px-2"
          value={s.backgroundMotion}
          onChange={(e) =>
            onChange({ backgroundMotion: e.target.value as FreezeHighlightSettings["backgroundMotion"] })
          }
        >
          <option value="none">Manual position (still)</option>
          <option value="down">Slide from top</option>
          <option value="up">Slide from bottom</option>
          <option value="right">Slide from left</option>
          <option value="left">Slide from right</option>
          <option value="shake">Shake</option>
        </select>
      </label>
      {s.backgroundMotion !== "none" && (
        <label className="block text-xs text-text-muted">
          Animation speed: {s.backgroundSpeed}x
          <input
            aria-label="Background animation speed"
            type="range"
            min={0.1}
            max={5}
            step={0.1}
            value={s.backgroundSpeed}
            onChange={(e) => onChange({ backgroundSpeed: Number(e.target.value) })}
            className="w-full accent-[var(--accent)]"
          />
        </label>
      )}
      <p className="text-xs text-text-muted">
        After Apply, the image becomes its own editable timeline clip. Its animation speed can be changed in
        Motion.
      </p>
      <div className="flex flex-wrap gap-1" aria-label="Background size presets">
        {(
          [
            ["Full", 1, 1],
            ["Half", 1, 0.5],
            ["Quarter", 0.5, 0.5],
          ] as const
        ).map(([name, width, height]) => (
          <Button
            key={name}
            variant="secondary"
            onClick={() => onChange({ backgroundWidth: width, backgroundHeight: height })}
          >
            {name}
          </Button>
        ))}
        <Button variant="secondary" onClick={() => onChange({ backgroundX: 0.5, backgroundY: 0.5 })}>
          Centre
        </Button>
      </div>
      <label className="block text-xs text-text-muted">
        Outside the image
        <select
          aria-label="Outside background image"
          className="h-9 w-full rounded border bg-surface-2 px-2"
          value={s.backgroundBase}
          onChange={(e) =>
            onChange({ backgroundBase: e.target.value as FreezeHighlightSettings["backgroundBase"] })
          }
        >
          <option value="original">Keep original video</option>
          <option value="styled">Style background</option>
          <option value="color">Solid colour</option>
        </select>
      </label>
      {s.backgroundBase === "color" && (
        <input
          aria-label="Outside image colour"
          type="color"
          className="h-9 w-full"
          value={s.backgroundColor}
          onChange={(e) => onChange({ backgroundColor: e.target.value.toUpperCase() })}
        />
      )}
      <label className="block text-xs text-text-muted">
        Image fitting
        <select
          aria-label="Background image fitting"
          className="h-9 w-full rounded border bg-surface-2 px-2"
          value={s.backgroundFit}
          onChange={(e) => onChange({ backgroundFit: e.target.value as "cover" | "contain" })}
        >
          <option value="cover">Fill box (crop edges)</option>
          <option value="contain">Whole image (keep proportions)</option>
        </select>
      </label>
      <div
        aria-label="Background placement preview"
        className="relative mx-auto max-h-64 w-full touch-none overflow-hidden rounded border bg-surface-2"
        style={{
          aspectRatio: aspect,
          maxWidth: Math.min(300, 256 * aspect),
          background: s.backgroundBase === "color" ? s.backgroundColor : undefined,
        }}
      >
        {s.backgroundBase === "original" && sourceThumbnail && (
          <img
            alt=""
            draggable={false}
            src={thumbnailUrl(sourceThumbnail)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
        {s.backgroundImage && (
          <div
            className="absolute cursor-grab touch-none border-2 border-accent active:cursor-grabbing"
            style={{
              left: `${s.backgroundX * 100}%`,
              top: `${s.backgroundY * 100}%`,
              width: `${s.backgroundWidth * 100}%`,
              height: `${s.backgroundHeight * 100}%`,
              transform: "translate(-50%, -50%)",
            }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { x: e.clientX, y: e.clientY, cx: s.backgroundX, cy: s.backgroundY };
            }}
            onPointerMove={(e) => {
              if (!drag.current) return;
              const rect = e.currentTarget.parentElement!.getBoundingClientRect();
              if (rect.width && rect.height)
                onChange({
                  backgroundX: clamp(drag.current.cx + (e.clientX - drag.current.x) / rect.width),
                  backgroundY: clamp(drag.current.cy + (e.clientY - drag.current.y) / rect.height),
                });
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onLostPointerCapture={() => {
              drag.current = null;
            }}
          >
            <img
              alt="Draggable background image"
              draggable={false}
              src={mediaUrl(s.backgroundImage)}
              className="pointer-events-none h-full w-full"
              style={{ objectFit: s.backgroundFit }}
            />
          </div>
        )}
      </div>
      <p className="text-xs text-text-muted">
        Drag to position the image. Preview shows the target layout before the person cut-out. Slide duration
        follows the effect duration. The person stays in front.
      </p>
      {(
        [
          ["backgroundWidth", "Image width", 5, 200],
          ["backgroundHeight", "Image height", 5, 200],
          ["backgroundX", "Image centre X", 0, 100],
          ["backgroundY", "Image centre Y", 0, 100],
        ] as const
      ).map(([key, label, min, max]) => (
        <label key={key} className="block text-xs text-text-muted">
          <span className="flex justify-between">
            {label}
            <span>{Math.round(s[key] * 100)}%</span>
          </span>
          <input
            aria-label={label}
            type="range"
            min={min}
            max={max}
            step={1}
            value={Math.round(s[key] * 100)}
            onChange={(e) => onChange({ [key]: Number(e.target.value) / 100 })}
            className="w-full accent-[var(--accent)]"
          />
        </label>
      ))}
    </div>
  );
}
