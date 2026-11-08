import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useProjectStore } from "@/store/project";
import { applyTextFlicker, DEFAULT_FLICKER, type FlickerSettings } from "@/timeline/textFlicker";
const field = "mt-1 h-9 w-full min-w-0 rounded-md border bg-surface-2 px-2 text-sm";
export function TextFlickerPanel({ clipId }: { clipId: string }) {
  const [settings, setSettings] = useState<FlickerSettings>({ ...DEFAULT_FLICKER });
  const [note, setNote] = useState<string | null>(null);
  return (
    <section aria-label="Text flicker" className="min-w-0 space-y-3 rounded-md border p-3">
      <h3 className="text-sm font-medium">Text flicker / blink</h3>
      <label className="block text-xs">
        Effect
        <select
          className={field}
          value={settings.kind}
          onChange={(e) => setSettings((s) => ({ ...s, kind: e.target.value as FlickerSettings["kind"] }))}
        >
          <option value="blink">Blink · regular</option>
          <option value="neon">Neon flicker · irregular</option>
          <option value="pulse">Soft pulse · smooth</option>
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            { key: "duration", label: "Flicker duration (s)", min: 0.2, max: 3 },
            { key: "speed", label: "Flicker speed", min: 0.5, max: 4 },
          ] as const
        ).map((f) => (
          <label className="text-xs" key={f.key}>
            {f.label}
            <input
              className={field}
              type="number"
              min={f.min}
              max={f.max}
              step={0.1}
              value={settings[f.key]}
              onChange={(e) => setSettings((s) => ({ ...s, [f.key]: Number(e.target.value) }))}
            />
          </label>
        ))}
      </div>
      <label className="block text-xs">
        Flicker strength · {Math.round(settings.depth * 100)}%
        <input
          aria-label="Flicker strength"
          className="mt-2 w-full"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={settings.depth}
          onChange={(e) => setSettings((s) => ({ ...s, depth: Number(e.target.value) }))}
        />
      </label>
      <p className="text-xs text-text-muted">
        Starts at the clip beginning, then stays lit. Affects the whole text layer, including its box.
        Replaces existing opacity keyframes; position, scale and rotation stay intact. Neon changes
        brightness; it does not add glow.
      </p>
      <Button
        variant="secondary"
        className="w-full"
        onClick={() => {
          const result = useProjectStore
            .getState()
            .execute({ label: "Apply text flicker", apply: (p) => applyTextFlicker(p, clipId, settings) });
          setNote(
            result.ok
              ? "Text flicker applied. One Undo restores the previous opacity motion."
              : result.error.message,
          );
        }}
      >
        Apply text flicker
      </Button>
      {note && (
        <p role="status" className="text-xs text-text-muted">
          {note}
        </p>
      )}
    </section>
  );
}
