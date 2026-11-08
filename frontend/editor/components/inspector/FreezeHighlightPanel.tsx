

import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fileName, mediaUrl, type ImportedMedia } from "@/lib/media";
import type { TimelineClip } from "@/project/model";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { Button } from "@/components/ui/button";
import {
  editableBackground,
  createFreezeHighlight,
  DEFAULT_FREEZE_HIGHLIGHT,
  freezeWindow,
  type FreezeHighlightSettings,
} from "@/timeline/freezeHighlight";

import { BackgroundImagePlacement } from "./BackgroundImagePlacement";

const field = "h-9 w-full min-w-0 max-w-full rounded-md border bg-surface-2 px-2 text-sm";
export function FreezeHighlightPanel({ clip }: { clip: TimelineClip }) {
  const [settings, setSettings] = useState({ ...DEFAULT_FREEZE_HIGHLIGHT });

  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false),
    [note, setNote] = useState<string | null>(null);
  const project = useProjectStore((s) => s.project);
  const playhead = usePlaybackStore((s) => s.playhead);
  const moving = settings.playback === "moving";
  const renderingVideo = moving || editableBackground(settings);
  const subjectStyle = settings.style === "outline" || settings.style === "paper-outline";
  const needsRuntime = moving || subjectStyle;
  const runtimeKey = needsRuntime ? (subjectStyle ? "subject" : "basic") : "none";
  const [runtimeState, setRuntime] = useState<{ key: string; ready: boolean | null; reason: string | null }>({
    key: "",
    ready: null,
    reason: null,
  });
  const runtime = runtimeState.key === runtimeKey ? runtimeState : { ready: null, reason: null };
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    let alive = true;
    if (runtimeKey !== "none") {
      void invoke<{ ready: boolean; reason: string | null }>("highlight_runtime", {
        subject: runtimeKey === "subject",
      })
        .then((result) => {
          if (alive)
            setRuntime({ key: runtimeKey, ready: result?.ready === true, reason: result?.reason ?? null });
        })
        .catch((error) => {
          if (alive) setRuntime({ key: runtimeKey, ready: false, reason: String(error) });
        });
    }
    return () => {
      alive = false;
    };
  }, [runtimeKey]);
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listen<{ fraction: number }>("highlight-progress", (event) => {
      if (Number.isFinite(event.payload.fraction))
        setProgress(Math.max(0, Math.min(1, event.payload.fraction)));
    })
      .then((off) => {
        if (alive) unlisten = off;
        else off();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);
  const checkRuntime = async () => {
    try {
      const result = await invoke<{ ready: boolean; reason: string | null }>("highlight_runtime", {
        subject: subjectStyle,
      });
      setRuntime({ key: runtimeKey, ready: result.ready, reason: result.reason });
    } catch (error) {
      setRuntime({ key: runtimeKey, ready: false, reason: String(error) });
    }
  };
  const asset = project.assets.find((a) => a.id === clip.assetId);
  if (asset?.type !== "video" || asset.alpha) return null;
  let reason: string | null = null;
  try {
    freezeWindow(project, clip.id, playhead, settings);
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }
  if (needsRuntime && runtime.ready !== true)
    reason =
      runtime.ready === false
        ? (runtime.reason ?? "Local style runtime is unavailable.")
        : "Checking local style runtime…";
  const set = <K extends keyof FreezeHighlightSettings>(key: K, value: FreezeHighlightSettings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));
  return (
    <section aria-label="Freeze Highlight" className="mt-4 space-y-3 border-t pt-3">
      <h3 className="text-sm font-medium">Highlight styles</h3>
      <p className="text-xs text-text-muted">
        {moving
          ? "The picture keeps moving with the selected style. Up to 120 seconds per render, 30 fps and 1920 px on the longer side."
          : "Hold the picture at the playhead while speech and subtitles continue."}{" "}
        Later clips stay in place. One Undo restores the original.
      </p>
      <fieldset disabled={busy} className="min-w-0 space-y-3">
        <label className="block text-xs text-text-muted">
          Playback mode
          <select
            aria-label="Playback mode"
            className={field}
            value={settings.playback}
            onChange={(e) =>
              setSettings((s) => ({
                ...s,
                playback: e.target.value as FreezeHighlightSettings["playback"],
                wholeClip: false,
                duration: Math.min(s.duration, e.target.value === "moving" ? 120 : 15),
              }))
            }
          >
            <option value="freeze">Freeze frame</option>
            <option value="moving">Video keeps moving</option>
          </select>
        </label>
        {moving && (
          <label className="flex gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={settings.wholeClip}
              onChange={(e) => set("wholeClip", e.target.checked)}
            />
            Apply to whole selected clip
          </label>
        )}
        {needsRuntime && runtime.ready === false && (
          <Button variant="secondary" onClick={() => void checkRuntime()}>
            Check local runtime
          </Button>
        )}
        <label className="block text-xs text-text-muted">
          Visual style
          <select
            aria-label="Visual style"
            className={field}
            value={settings.style}
            onChange={(e) =>
              setSettings((s) => ({
                ...s,
                style: e.target.value as FreezeHighlightSettings["style"],
                opacity: 1,
              }))
            }
          >
            <option value="halftone">Halftone / comic dots</option>
            <option value="mono">Black &amp; White</option>
            <option value="outline">Character Outline + Zoom</option>
            <option value="paper-outline">Paper Outline</option>
            <option value="paper">Paper Texture</option>
          </select>
        </label>
        {subjectStyle && (
          <>
            <p className="text-xs text-text-muted">
              Local portrait cut-out; best with one person. Hair and fast motion may need review.
            </p>
            <label className="block text-xs text-text-muted">
              Background mode
              <select
                aria-label="Outline background mode"
                className={field}
                value={settings.backgroundMode}
                onChange={(e) =>
                  set("backgroundMode", e.target.value as FreezeHighlightSettings["backgroundMode"])
                }
              >
                <option value="styled">Style default</option>
                <option value="original">Keep original background</option>
                <option value="color">Solid colour</option>
                <option value="image">Image behind person</option>
              </select>
            </label>
            {settings.backgroundMode === "color" && (
              <label className="block text-xs text-text-muted">
                Background colour
                <input
                  aria-label="Outline background colour"
                  type="color"
                  className="h-9 w-full rounded border"
                  value={settings.backgroundColor}
                  onChange={(e) => set("backgroundColor", e.target.value.toUpperCase())}
                />
              </label>
            )}
            {settings.backgroundMode === "image" && (
              <div className="space-y-2">
                <select
                  aria-label="Outline background image"
                  className={field}
                  value={settings.backgroundImage}
                  onChange={(e) => set("backgroundImage", e.target.value)}
                >
                  <option value="">Choose an image…</option>
                  {settings.backgroundImage &&
                    !project.assets.some(
                      (a) => a.type === "image" && a.path === settings.backgroundImage,
                    ) && (
                      <option value={settings.backgroundImage}>{fileName(settings.backgroundImage)}</option>
                    )}
                  {project.assets
                    .filter((a) => a.type === "image")
                    .map((a) => (
                      <option key={a.id} value={a.path}>
                        {fileName(a.path)}
                      </option>
                    ))}
                </select>
                <Button
                  variant="secondary"
                  onClick={async () => {
                    try {
                      const image = await invoke<ImportedMedia | null>("pick_image");
                      if (image) set("backgroundImage", image.path);
                    } catch (error) {
                      setNote(String(error));
                    }
                  }}
                >
                  Choose background image…
                </Button>
                {settings.backgroundImage && (
                  <img
                    src={mediaUrl(settings.backgroundImage)}
                    alt="Selected outline background"
                    className="h-20 w-full rounded object-cover"
                  />
                )}
                <BackgroundImagePlacement
                  settings={settings}
                  onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
                  aspect={(asset.width ?? 9) / (asset.height ?? 16)}
                  sourceThumbnail={asset.thumbnailPath}
                />
              </div>
            )}
            <label className="block text-xs text-text-muted">
              Outline colour
              <input
                aria-label="Outline colour"
                type="color"
                className="mt-1 h-9 w-full rounded border"
                value={settings.outlineColor}
                onChange={(e) => set("outlineColor", e.target.value.toUpperCase())}
              />
            </label>
            <label className="block text-xs text-text-muted">
              Outline width
              <input
                aria-label="Outline width"
                type="range"
                min={1}
                max={40}
                step={1}
                value={settings.outlineWidth}
                onChange={(e) => set("outlineWidth", Number(e.target.value))}
                className="w-full accent-[var(--accent)]"
              />
            </label>
            <label className="block text-xs text-text-muted">
              Character zoom
              <input
                aria-label="Character zoom"
                type="range"
                min={1}
                max={1.4}
                step={0.01}
                value={settings.subjectZoom}
                onChange={(e) => set("subjectZoom", Number(e.target.value))}
                className="w-full accent-[var(--accent)]"
              />
            </label>
          </>
        )}
        {(settings.style === "paper" || settings.style === "paper-outline") && (
          <label className="block text-xs text-text-muted">
            Paper tint
            <input
              aria-label="Paper tint"
              type="color"
              className="mt-1 h-9 w-full rounded border"
              value={settings.paperColor}
              onChange={(e) => set("paperColor", e.target.value.toUpperCase())}
            />
          </label>
        )}
        <label className="block text-xs text-text-muted">
          {moving ? "Effect duration (seconds)" : "Freeze duration (seconds)"}
          <input
            type="number"
            className={field}
            min={0.2}
            max={moving ? 120 : 15}
            disabled={moving && settings.wholeClip}
            step={0.1}
            value={
              moving && settings.wholeClip
                ? Number(((clip.sourceOut - clip.sourceIn) / (clip.speed ?? 1)).toFixed(3))
                : settings.duration
            }
            onChange={(e) => set("duration", Number(e.target.value))}
          />
        </label>
        {settings.style === "halftone" && (
          <>
            <label className="block text-xs text-text-muted">
              Dot pattern
              <select
                className={field}
                value={settings.pattern}
                onChange={(e) => set("pattern", e.target.value as FreezeHighlightSettings["pattern"])}
              >
                <option value="grid">Grid — straight rows</option>
                <option value="wave">Wave — fabric curves</option>
                <option value="radial">Radial — circular rings</option>
              </select>
            </label>
            {settings.pattern !== "grid" && (
              <label className="block text-xs text-text-muted">
                <span className="flex justify-between">
                  Pattern bend<span>{Math.round(settings.bend * 100)}%</span>
                </span>
                <input
                  aria-label="Pattern bend"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.bend}
                  onChange={(e) => set("bend", Number(e.target.value))}
                  className="w-full accent-[var(--accent)]"
                />
              </label>
            )}
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ["color", "Paper colour"],
                  ["darkColor", "Ink colour"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="text-xs text-text-muted">
                  {label}
                  <input
                    aria-label={label}
                    type="color"
                    className="mt-1 block h-9 w-full rounded border"
                    value={settings[key]}
                    onChange={(e) => set(key, e.target.value.toUpperCase())}
                  />
                </label>
              ))}
            </div>
          </>
        )}
        {(
          [
            ["opacity", "Colour opacity", 0, 1, 0.01],
            ["intensity", "Halftone texture", 0, 1, 0.01],
            ["spacing", "Dot size", 2, 20, 1],
            ["zoom", "Zoom", 1, 1.3, 0.01],
          ] as const
        )
          .filter(
            ([key]) =>
              (key !== "spacing" || settings.style === "halftone") &&
              (key !== "intensity" ||
                settings.style === "halftone" ||
                settings.style === "paper" ||
                settings.style === "paper-outline"),
          )
          .map(([key, label, min, max, step]) => (
            <label key={key} className="block text-xs text-text-muted">
              <span className="flex justify-between">
                {key === "intensity" && settings.style !== "halftone" ? "Paper texture" : label}
                <span>{settings[key]}</span>
              </span>
              <input
                aria-label={key === "intensity" && settings.style !== "halftone" ? "Paper texture" : label}
                type="range"
                className="w-full accent-[var(--accent)]"
                min={min}
                max={max}
                step={step}
                value={settings[key]}
                onChange={(e) => set(key, Number(e.target.value))}
              />
            </label>
          ))}
        <label className="block text-xs text-text-muted">
          Freeze audio
          <select
            className={field}
            value={settings.audio}
            onChange={(e) => set("audio", e.target.value as FreezeHighlightSettings["audio"])}
          >
            <option value="none">Original audio</option>
            <option value="echo">Echo voice</option>
            <option value="reverb">Reverb voice</option>
            <option value="impact">Impact accent + original voice</option>
          </select>
        </label>
        {settings.audio !== "none" && (
          <label className="block text-xs text-text-muted">
            Audio effect strength
            <input
              aria-label="Audio effect strength"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={settings.audioStrength}
              onChange={(e) => set("audioStrength", Number(e.target.value))}
              className="w-full accent-[var(--accent)]"
            />
          </label>
        )}
      </fieldset>
      {reason && <p className="text-xs text-text-muted">{reason}</p>}
      <Button
        variant="secondary"
        className="w-full"
        disabled={busy || Boolean(reason)}
        onClick={async () => {
          controller.current = new AbortController();
          setBusy(true);
          setNote(null);
          setProgress(0);
          try {
            const result = await createFreezeHighlight(clip.id, playhead, settings, {

              signal: controller.current.signal,
            });
            setNote(
              result.ok
                ? moving
                  ? "Moving style applied. Image backgrounds are separate editable timeline clips."
                  : editableBackground(settings)
                    ? "Applied. Select the Highlight image track to move the image or adjust its animation speed."
                    : "Freeze Highlight applied. The still and audio remain editable."
                : result.error.message,
            );
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            setNote(
              renderingVideo && message.toLowerCase().includes("cancelled")
                ? "Moving render cancelled. No edit applied."
                : message,
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy
          ? renderingVideo
            ? `Rendering moving style… ${Math.round(progress * 100)}%`
            : "Preparing Freeze Highlight…"
          : moving
            ? "Apply Moving Style"
            : "Apply Freeze Highlight"}
      </Button>
      {busy && renderingVideo && (
        <Button variant="secondary" onClick={() => controller.current?.abort()}>
          {renderingVideo ? "Cancel moving render" : "Cancel render"}
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
