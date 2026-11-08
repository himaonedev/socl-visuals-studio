import { useEffect, useRef, useState } from "react";
import { FontPicker } from "@/components/inspector/FontPicker";
import { PositionControl, type PositionProps } from "@/components/text/PositionControl";
import { StylePreview } from "@/components/text/StylePreview";
import { Button } from "@/components/ui/button";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/utils";
import type { TextStyle } from "@/project/model";
import { DEFAULT_FONT, useFontStore } from "@/store/fonts";
import { MAX_STYLE_NAME, useTextStyleStore, type CustomStyle } from "@/store/textStyles";
import { DEFAULT_WORD_HIGHLIGHT } from "@/timeline/wordCaptions";

const fieldClass =
  "h-9 w-full min-w-0 max-w-full rounded-md border bg-surface-2 px-2 text-sm pointer-coarse:h-11 focus-visible:outline-accent";
const chip = (on: boolean) =>
  cn(
    "h-9 rounded-md border px-2 text-xs pointer-coarse:h-11",
    on
      ? "border-accent bg-accent-soft text-text"
      : "border-border bg-surface-2 text-text-muted hover:text-text",
  );

function Colour({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-text-muted">
      <input
        type="color"
        aria-label={label}
        className="h-9 w-10 shrink-0 cursor-pointer rounded-md border bg-surface-2 pointer-coarse:h-11"
        value={value.toLowerCase()}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
      />
      {label}
    </label>
  );
}

export interface SizeProps {
  /** Font size as a share of the canvas height. */
  value: number;
  min: number;
  max: number;
  canvasHeight: number;
  onChange: (share: number) => void;
}

/** A slider in percent of the font size (or of full strength). */
function Percent({
  label,
  value,
  min = 0,
  max = 100,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (share: number) => void;
}) {
  const pct = Math.round(value * 100);
  return (
    <label className="block">
      <span className="mb-1 flex justify-between text-xs text-text-muted">
        {label} <span className="tabular-nums">{pct}%</span>
      </span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={1}
        value={pct}
        className="w-full min-w-0 max-w-full accent-[var(--accent)] pointer-coarse:h-11"
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
    </label>
  );
}

/** A part of the style that can be switched on and off, with its controls shown while it is on. */
function Part({
  title,
  on,
  onToggle,
  children,
}: {
  title: string;
  on: boolean;
  onToggle: (on: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="min-w-0 space-y-2 rounded-md border p-2">
      <label className="flex min-h-6 cursor-pointer items-center gap-2 text-xs text-text pointer-coarse:min-h-11">
        <input
          type="checkbox"
          className="size-4 accent-[var(--accent)]"
          checked={on}
          onChange={(e) => onToggle(e.target.checked)}
        />
        {title}
      </label>
      {on && children}
    </fieldset>
  );
}

const SHAPES = [
  { id: "rect", label: "One box" },
  { id: "per-line", label: "Per line" },
  { id: "per-word", label: "Per word" },
  { id: "jagged", label: "Jagged" },
] as const;

function BoxAngle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block text-xs text-text-muted">
      <span className="flex justify-between">
        {label}
        <span>{value}°</span>
      </span>
      <input
        type="range"
        aria-label={label}
        min={-45}
        max={45}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full min-w-0 max-w-full accent-[var(--accent)]"
      />
    </label>
  );
}

/**
 * The ONE style editor: every control of a text style with a live sample on top. It edits a value and
 * knows nothing about where that value is kept, so the same component edits one of "My styles" in the
 * editor sheet and the customised subtitle style in the subtitle step.
 */
export function StyleEditor({
  value,
  label,
  onChange,
  position,
  size,
  showFade = true,
  showWordGrouping = true,
}: {
  value: CustomStyle;
  /** The name written in the sample. */
  label: string;
  onChange: (next: CustomStyle) => void;
  /** Where the styled text goes, when the editor is used for something that has a place (subtitles). */
  position?: PositionProps;
  /** The font size, when the editor is used for something that has one (subtitles). */
  size?: SizeProps;
  showFade?: boolean;
  showWordGrouping?: boolean;
}) {
  const fonts = useFontStore((s) => s.fonts);
  useEffect(() => useFontStore.getState().ensure(), []);
  const { style } = value;
  const set = (patch: Partial<TextStyle>) => {
    const next = { ...style, ...patch };
    // a part that is switched off is not kept as "undefined"
    for (const key of Object.keys(next) as (keyof TextStyle)[]) if (next[key] === undefined) delete next[key];
    onChange({ ...value, style: next });
  };

  return (
    <div role="group" aria-label="Style editor" className="w-full min-w-0 max-w-full space-y-3 text-xs">
      <StylePreview
        style={style}
        label={style.highlight?.word ? "Ini contoh subtitle" : label}
        className="h-24 w-full rounded-md"
      />

      <div>
        <p className="mb-1 text-text-muted">Font</p>
        <FontPicker
          fonts={fonts}
          value={style.font ?? DEFAULT_FONT}
          onChange={(font) => set({ font })}
          onImport={() =>
            void useFontStore
              .getState()
              .importFont()
              .then((families) => families.length > 0 && set({ font: families[0] }))
              .catch(() => undefined)
          }
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Colour label="Text colour" value={style.color} onChange={(color) => set({ color })} />
        <button
          type="button"
          aria-pressed={style.bold ?? false}
          className={chip(style.bold ?? false)}
          onClick={() => set({ bold: style.bold ? undefined : true })}
        >
          Bold
        </button>
        <button
          type="button"
          aria-pressed={style.uppercase ?? false}
          className={chip(style.uppercase ?? false)}
          onClick={() => set({ uppercase: style.uppercase ? undefined : true })}
        >
          CAPITALS
        </button>
      </div>
      {size && (
        <label className="block">
          <span className="mb-1 flex justify-between text-text-muted">
            Font size
            <span className="tabular-nums">
              {Math.round(size.value * size.canvasHeight)} px ({Math.round(size.value * 1000) / 10}%)
            </span>
          </span>
          <input
            type="range"
            aria-label="Font size"
            min={size.min * 100}
            max={size.max * 100}
            step={0.5}
            value={Math.round(size.value * 1000) / 10}
            className="w-full min-w-0 max-w-full accent-[var(--accent)] pointer-coarse:h-11"
            onChange={(e) => size.onChange(Number(e.target.value) / 100)}
          />
        </label>
      )}

      <Part
        title="Outline"
        on={style.outline !== undefined}
        onToggle={(on) => set({ outline: on ? { color: "#000000", width: 0.08 } : undefined })}
      >
        {style.outline && (
          <>
            <Colour
              label="Outline colour"
              value={style.outline.color}
              onChange={(color) => set({ outline: { ...style.outline!, color } })}
            />
            <Percent
              label="Thickness"
              value={style.outline.width}
              min={1}
              max={50}
              onChange={(width) => set({ outline: { ...style.outline!, width } })}
            />
          </>
        )}
      </Part>

      <Part
        title="Shadow or glow"
        on={style.shadow !== undefined}
        onToggle={(on) =>
          set({ shadow: on ? { color: "#000000", blur: 0.1, x: 0, y: 0.04, opacity: 0.8 } : undefined })
        }
      >
        {style.shadow && (
          <>
            <Colour
              label="Shadow colour"
              value={style.shadow.color}
              onChange={(color) => set({ shadow: { ...style.shadow!, color } })}
            />
            <Percent
              label="Softness"
              value={style.shadow.blur}
              onChange={(blur) => set({ shadow: { ...style.shadow!, blur } })}
            />
            <div className="grid grid-cols-2 gap-x-3">
              <Percent
                label="Across"
                value={style.shadow.x}
                min={-100}
                onChange={(x) => set({ shadow: { ...style.shadow!, x } })}
              />
              <Percent
                label="Down"
                value={style.shadow.y}
                min={-100}
                onChange={(y) => set({ shadow: { ...style.shadow!, y } })}
              />
            </div>
            <Percent
              label="Strength"
              value={style.shadow.opacity}
              onChange={(opacity) => set({ shadow: { ...style.shadow!, opacity } })}
            />
          </>
        )}
      </Part>

      <Part
        title="Background box"
        on={style.box !== undefined}
        onToggle={(on) =>
          set({
            box: on
              ? { color: "#000000", opacity: 0.7, shape: "rect", padding: 0.3, radius: 0.15 }
              : undefined,
          })
        }
      >
        {style.box && (
          <>
            <div role="radiogroup" aria-label="Box shape" className="grid grid-cols-2 gap-1">
              {SHAPES.map((shape) => (
                <button
                  key={shape.id}
                  type="button"
                  role="radio"
                  aria-checked={style.box!.shape === shape.id}
                  className={chip(style.box!.shape === shape.id)}
                  onClick={() =>
                    set({
                      box: {
                        ...style.box!,
                        shape: shape.id,
                        ...(shape.id === "per-word" ? { padding: 0.1 } : {}),
                      },
                    })
                  }
                >
                  {shape.label}
                </button>
              ))}
            </div>
            <Colour
              label="Box colour"
              value={style.box.color}
              onChange={(color) => set({ box: { ...style.box!, color } })}
            />
            <BoxAngle
              label="Base box rotation"
              value={style.box.rotation ?? 0}
              onChange={(rotation) => set({ box: { ...style.box!, rotation } })}
            />
            {style.box.shape === "per-word" && (
              <p className="text-text-muted">
                A separate box around every visible word. Text stays straight; each box rotates about its own
                centre.
              </p>
            )}
            <Percent
              label="Box strength"
              value={style.box.opacity}
              onChange={(opacity) => set({ box: { ...style.box!, opacity } })}
            />
            <Percent
              label="Padding"
              value={style.box.padding}
              onChange={(padding) => set({ box: { ...style.box!, padding } })}
            />
            {style.box.shape !== "jagged" && (
              <Percent
                label="Roundness"
                value={style.box.radius}
                onChange={(radius) => set({ box: { ...style.box!, radius } })}
              />
            )}
          </>
        )}
      </Part>

      <Part
        title="Highlight active word"
        on={style.highlight?.word !== undefined && style.highlight.word.opacity !== 0}
        onToggle={(on) =>
          set({
            highlight: on
              ? {
                  color: "#000000",
                  lines: "last",
                  word: { ...DEFAULT_WORD_HIGHLIGHT },
                }
              : undefined,
          })
        }
      >
        {style.highlight?.word && style.highlight.word.opacity !== 0 && (
          <>
            <Colour
              label="Active word text colour"
              value={style.highlight.color}
              onChange={(color) => set({ highlight: { ...style.highlight!, color } })}
            />
            <BoxAngle
              label="Active word box rotation"
              value={style.highlight.word.rotation ?? 0}
              onChange={(rotation) =>
                set({ highlight: { ...style.highlight!, word: { ...style.highlight!.word!, rotation } } })
              }
            />
            <Colour
              label="Active word box colour"
              value={style.highlight.word.boxColor}
              onChange={(boxColor) =>
                set({ highlight: { ...style.highlight!, word: { ...style.highlight!.word!, boxColor } } })
              }
            />
            {(
              [
                ["opacity", "Active word box opacity"],
                ["padding", "Active word box padding"],
                ["radius", "Active word box roundness"],
              ] as const
            ).map(([key, label]) => (
              <Percent
                key={key}
                label={label}
                value={style.highlight!.word![key]}
                onChange={(next) =>
                  set({
                    highlight: { ...style.highlight!, word: { ...style.highlight!.word!, [key]: next } },
                  })
                }
              />
            ))}
            {showWordGrouping && (
              <label className="block space-y-1">
                <span className="text-text-muted">Words per caption</span>
                <input
                  type="number"
                  min={1}
                  max={8}
                  step={1}
                  className={fieldClass}
                  value={style.highlight.word.maxWords}
                  onChange={(e) =>
                    set({
                      highlight: {
                        ...style.highlight!,
                        word: {
                          ...style.highlight!.word!,
                          maxWords: Math.max(1, Math.min(8, Math.round(Number(e.target.value) || 1))),
                        },
                      },
                    })
                  }
                />
              </label>
            )}
            <p className="text-text-muted">
              Subtitle highlights use estimated word times from each segment. Each state stays editable on the
              timeline. {showWordGrouping && "Choose 1 word per caption to show one word at a time. "}Fade is
              ignored between word states.
            </p>
          </>
        )}
      </Part>

      <Part
        title="Highlight a line"
        on={style.highlight !== undefined && (!style.highlight.word || style.highlight.word.opacity === 0)}
        onToggle={(on) => set({ highlight: on ? { color: "#FFD233", lines: "last" } : undefined })}
      >
        {style.highlight && (!style.highlight.word || style.highlight.word.opacity === 0) && (
          <>
            <label className="block">
              <span className="mb-1 block text-text-muted">Highlight mode</span>
              <select
                aria-label="Highlight mode"
                className={fieldClass}
                value={style.highlight.word ? "word" : "line"}
                onChange={(e) =>
                  set({
                    highlight:
                      e.target.value === "word"
                        ? { ...style.highlight!, word: { ...DEFAULT_WORD_HIGHLIGHT, opacity: 0 } }
                        : { color: style.highlight!.color, lines: style.highlight!.lines },
                  })
                }
              >
                <option value="line">Per line</option>
                <option value="word">Active word (text only)</option>
              </select>
            </label>
            <Colour
              label="Highlight colour"
              value={style.highlight.color}
              onChange={(color) => set({ highlight: { ...style.highlight!, color } })}
            />
            {!style.highlight.word && (
              <label className="block">
                <span className="mb-1 block text-text-muted">Which lines</span>
                <select
                  className={fieldClass}
                  value={style.highlight.lines}
                  onChange={(e) =>
                    set({
                      highlight: { ...style.highlight!, lines: e.target.value as "last" | "first" | "even" },
                    })
                  }
                >
                  <option value="last">The last line</option>
                  <option value="first">The first line</option>
                  <option value="even">Every second line</option>
                </select>
              </label>
            )}
            {style.highlight.word && (
              <>
                {showWordGrouping && (
                  <label className="block space-y-1">
                    <span className="text-text-muted">Words per caption</span>
                    <input
                      type="number"
                      min={1}
                      max={8}
                      step={1}
                      className={fieldClass}
                      value={style.highlight.word.maxWords}
                      onChange={(e) =>
                        set({
                          highlight: {
                            ...style.highlight!,
                            word: {
                              ...style.highlight!.word!,
                              maxWords: Math.max(1, Math.min(8, Math.round(Number(e.target.value) || 1))),
                            },
                          },
                        })
                      }
                    />
                  </label>
                )}
                <p className="text-text-muted">
                  Only the spoken word changes colour, without an extra box. Uses estimated word timing when
                  subtitles are generated.{" "}
                  {showWordGrouping && "Choose 1 word per caption to show words individually."}
                </p>
              </>
            )}
          </>
        )}
      </Part>

      {position && <PositionControl {...position} />}

      {showFade && (
        <label className="block">
          <span className="mb-1 block text-text-muted">Fade in and out (s)</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            max={5}
            step={0.1}
            className={fieldClass}
            value={value.fade ?? 0}
            onChange={(e) => {
              const seconds = Math.min(5, Math.max(0, Number(e.target.value) || 0));
              onChange(seconds > 0 ? { ...value, fade: seconds } : { style: value.style });
            }}
          />
        </label>
      )}
    </div>
  );
}

/**
 * The editor for one of the user's own styles: a sheet at the side (from the bottom on narrow screens)
 * with the editor, the style's name, and Save / Cancel. Nothing is kept until Save. Built-in styles never
 * get here: "Edit" on one first makes a copy.
 */
export function StyleEditorSheet() {
  const id = useTextStyleStore((s) => s.editingId);
  const preset = useTextStyleStore((s) => s.mine.find((p) => p.id === id));
  return preset ? <Sheet key={preset.id} id={preset.id} name={preset.name} initial={preset} /> : null;
}

function Sheet({ id, name: savedName, initial }: { id: string; name: string; initial: CustomStyle }) {
  const wide = useMediaQuery("(min-width: 1024px)");
  const [draft, setDraft] = useState<CustomStyle>(
    initial.fade ? { style: initial.style, fade: initial.fade } : { style: initial.style },
  );
  const [name, setName] = useState(savedName);
  const [problem, setProblem] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useFocusTrap(rootRef, nameRef);
  const close = () => useTextStyleStore.getState().setEditing(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useTextStyleStore.getState().setEditing(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function save() {
    const store = useTextStyleStore.getState();
    const renamed = name.trim() === savedName ? null : store.rename(id, name);
    if (renamed) return setProblem(renamed);
    store.update(id, draft);
    close();
  }

  return (
    <div
      className="fixed inset-0 z-[65] bg-black/50"
      onPointerDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-label="Edit style"
        data-layout={wide ? "side" : "bottom"}
        // keys typed here are for the editor, not timeline shortcuts
        onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()}
        className={cn(
          "absolute flex flex-col border bg-surface-1 shadow-xl",
          wide
            ? "inset-y-0 right-0 w-[360px] border-l"
            : "inset-x-0 bottom-0 max-h-[85vh] rounded-t-lg border-t",
        )}
      >
        <div className="flex h-11 shrink-0 items-center justify-between border-b px-3">
          <h2 className="text-sm font-semibold">Edit style</h2>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          <label className="block text-xs">
            <span className="mb-1 block text-text-muted">Name</span>
            <input
              ref={nameRef}
              aria-label="Style name"
              maxLength={MAX_STYLE_NAME}
              className={fieldClass}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setProblem(null);
              }}
            />
          </label>
          {problem && (
            <p role="alert" className="text-xs text-danger">
              {problem}
            </p>
          )}
          <StyleEditor value={draft} label={name.trim() || "Style"} onChange={setDraft} />
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t p-3">
          <Button variant="secondary" className="pointer-coarse:h-11" onClick={close}>
            Cancel
          </Button>
          <Button className="pointer-coarse:h-11" onClick={save}>
            Save style
          </Button>
        </div>
      </div>
    </div>
  );
}
