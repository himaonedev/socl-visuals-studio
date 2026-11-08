import { StyleEditor } from "@/components/text/StyleEditor";
import { styleOfSpec } from "@/timeline/textStyles";
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { useProjectStore } from "@/store/project";
import {
  DEFAULT_TEXT_MARK,
  createTextMark,
  textMarkWindow,
  type TextMarkSettings,
} from "@/timeline/textMarks";
const field = "mt-1 h-9 w-full min-w-0 rounded-md border bg-surface-2 px-2 text-sm";
export function TextMarksPanel({ clipId }: { clipId: string }) {
  const [settings, setSettings] = useState<TextMarkSettings>({ ...DEFAULT_TEXT_MARK });
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [note, setNote] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null),
    running = useRef(false);
  const project = useProjectStore((s) => s.project);
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    void listen<{ fraction: number }>("text-marker-progress", (e) => {
      if (running.current && Number.isFinite(e.payload.fraction))
        setProgress(Math.max(0, Math.min(1, e.payload.fraction)));
    })
      .then((fn) => {
        if (alive) off = fn;
        else fn();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  let reason: string | null = null;
  try {
    textMarkWindow(project, clipId, settings);
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  const set = <K extends keyof TextMarkSettings>(key: K, value: TextMarkSettings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));
  return (
    <section aria-label="Animated text marks" className="space-y-3 rounded-md border p-3">
      <h3 className="text-sm font-medium">Animated text marks</h3>
      <fieldset disabled={busy} className="min-w-0 space-y-3">
        <label className="block text-xs text-text-muted">
          Text appearance when applying
          <select
            className={field}
            value={settings.textLook ?? "keep"}
            onChange={(e) => {
              const textLook = e.target.value as "keep" | "plain" | "custom";
              const source = project.assets.find(
                (a) => a.id === project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)?.assetId,
              )?.text;
              setSettings((s) => ({
                ...s,
                textLook,
                textStyle:
                  s.textStyle ??
                  (source
                    ? { ...styleOfSpec(source), box: undefined, highlight: undefined }
                    : { color: "#FFFFFF", bold: true }),
              }));
            }}
          >
            <option value="keep">Keep current text style</option>
            <option value="plain">Without box / active-word highlight</option>
            <option value="custom">Custom text style</option>
          </select>
        </label>
        {settings.textLook === "custom" && settings.textStyle && (
          <StyleEditor
            label="Marked text"
            showFade={false}
            showWordGrouping={false}
            value={{ style: settings.textStyle }}
            onChange={(next) => set("textStyle", next.style)}
          />
        )}
        <p className="text-xs text-text-muted">
          Changes only this selected text clip for its whole duration, together with the mark in one Undo.
          Other subtitles keep their style.
        </p>
        <label className="block text-xs text-text-muted">
          Text mark effect
          <select
            className={field}
            value={settings.kind}
            onChange={(e) => {
              const kind = e.target.value as TextMarkSettings["kind"];
              setSettings((s) => ({
                ...s,
                kind,
                color: kind === "highlighter" ? "#FFE66A" : "#FF4D4D",
                opacity: kind === "highlighter" ? 0.4 : 1,
                thickness: kind === "highlighter" ? 0.7 : 0.08,
              }));
            }}
          >
            <option value="highlighter">Stabilo / highlighter sweep</option>
            <option value="strike">Strikethrough draw</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs">
          Mark colour
          <input
            className="h-8 w-12 rounded border"
            aria-label="Mark colour"
            type="color"
            value={settings.color}
            onChange={(e) => set("color", e.target.value)}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-text-muted">
            Sweep time (seconds)
            <input
              className={field}
              type="number"
              min={0.1}
              max={2}
              step={0.05}
              value={settings.duration}
              onChange={(e) => set("duration", Number(e.target.value))}
            />
          </label>
          <label className="text-xs text-text-muted">
            Start delay (seconds)
            <input
              className={field}
              type="number"
              min={0}
              step={0.1}
              value={settings.delay}
              onChange={(e) => set("delay", Number(e.target.value))}
            />
          </label>
        </div>
        <label className="block text-xs text-text-muted">
          Mark opacity · {Math.round(settings.opacity * 100)}%
          <input
            aria-label="Mark opacity"
            className="block w-full min-w-0 accent-[var(--accent)]"
            type="range"
            min={0}
            max={100}
            value={Math.round(settings.opacity * 100)}
            onChange={(e) => set("opacity", Number(e.target.value) / 100)}
          />
        </label>
        <label className="block text-xs text-text-muted">
          Mark thickness (% of font size)
          <input
            className={field}
            type="number"
            min={2}
            max={150}
            step={1}
            value={Math.round(settings.thickness * 100)}
            onChange={(e) => set("thickness", Number(e.target.value) / 100)}
          />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={settings.wholeText}
            onChange={(e) => set("wholeText", e.target.checked)}
          />
          Mark whole text
        </label>
        {!settings.wholeText && (
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["firstWord", "First word"],
                ["lastWord", "Last word"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="text-xs text-text-muted">
                {label}
                <input
                  className={field}
                  type="number"
                  min={1}
                  step={1}
                  value={settings[key]}
                  onChange={(e) => set(key, Number(e.target.value))}
                />
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <p className="text-xs text-text-muted">
        Draws from left to right, line by line, then stays until this text clip ends. Short clips shorten the
        sweep. The mark is a separate transparent layer; original text stays editable. Reapply after editing
        or moving the text. Reapplying the same effect replaces its previous layer.
      </p>
      {reason && <p className="text-xs text-text-muted">{reason}</p>}
      <Button
        variant="secondary"
        className="w-full"
        disabled={busy || !!reason}
        onClick={async () => {
          if (running.current) return;
          running.current = true;
          controller.current = new AbortController();
          setBusy(true);
          setNote(null);
          setProgress(0);
          try {
            const result = await createTextMark(clipId, { ...settings }, controller.current.signal);
            setNote(
              result.ok
                ? "Animated mark applied as an editable timeline layer. One Undo restores it."
                : result.error.message,
            );
          } catch (error) {
            setNote(
              controller.current.signal.aborted
                ? "Text mark cancelled. No edit applied."
                : error instanceof Error
                  ? error.message
                  : String(error),
            );
          } finally {
            running.current = false;
            setBusy(false);
          }
        }}
      >
        {busy ? `Rendering text mark… ${Math.round(progress * 100)}%` : "Apply animated text mark"}
      </Button>
      {busy && (
        <Button variant="secondary" onClick={() => controller.current?.abort()}>
          Cancel text mark
        </Button>
      )}
      {note && (
        <p role="status" className="text-xs text-text-muted">
          {note}
        </p>
      )}
    </section>
  );
}
