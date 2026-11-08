import { useId, useRef, useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { FacecamPositionControl } from './FacecamPositionControl';
import type { TimelineClip } from "@/project/model";
import { useProjectStore } from "@/store/project";
import { usePlaybackStore } from "@/store/playback";
import {
  FACECAM_STYLES,
  DEFAULT_FACECAM,
  createFacecamStyle,
  facecamWindow,
  facecamNeedsSubject,
  type FacecamSettings,
  type FacecamStyle,
} from "@/timeline/facecamStyles";

const field = "h-9 w-full rounded-md border bg-surface-2 px-2 text-sm";
export function FacecamStylesPanel({ clip }: { clip: TimelineClip }) {
  const uid = useId();
  const [storedSettings, setSettings] = useState<FacecamSettings>({ ...DEFAULT_FACECAM });
  // Fast Refresh can retain settings created before new controls existed.
  const settings: FacecamSettings = {
    ...DEFAULT_FACECAM, ...storedSettings,
    frameX: storedSettings.frameX ?? DEFAULT_FACECAM.frameX,
    frameY: storedSettings.frameY ?? DEFAULT_FACECAM.frameY,
    frameZoom: storedSettings.frameZoom ?? DEFAULT_FACECAM.frameZoom,
    entry: storedSettings.entry ?? DEFAULT_FACECAM.entry,
    entryDirection: storedSettings.entryDirection ?? DEFAULT_FACECAM.entryDirection,
    entryDuration: storedSettings.entryDuration ?? DEFAULT_FACECAM.entryDuration,
    entryDelay: storedSettings.entryDelay ?? DEFAULT_FACECAM.entryDelay,
  };
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const running = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const project = useProjectStore((s) => s.project);
  const playhead = usePlaybackStore((s) => Math.round(s.playhead * 10) / 10);
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    void listen<{ fraction: number }>("highlight-progress", (e) => {
      if (running.current && Number.isFinite(e.payload.fraction))
        setProgress(Math.max(0, Math.min(1, e.payload.fraction)));
    })
      .then((stop) => {
        if (alive) off = stop;
        else stop();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  const asset = project.assets.find((a) => a.id === clip.assetId);
  if (asset?.type !== "video" || asset.alpha) return null;
  let reason: string | null = null;
  try {
    facecamWindow(project, clip.id, playhead, settings);
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  const definition = FACECAM_STYLES.find((s) => s.id === settings.style)!;
  const set = <K extends keyof FacecamSettings>(key: K, value: FacecamSettings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));
  const positioned = !["lean-in", "slow-push", "silhouette-intro", "bottom-fade"].includes(settings.style);
  return (
    <section aria-label="Facecam styles" className="mt-4 space-y-3 border-t pt-3">
      <h3 className="text-sm font-medium">Facecam styles</h3>
      <fieldset disabled={busy} className="space-y-3">
        <label className="block text-xs text-text-muted" htmlFor={`${uid}-style`}>
          Facecam style
        </label>
        <select
          id={`${uid}-style`}
          className={field}
          value={settings.style}
          onChange={(e) => {
            const style = e.target.value as FacecamStyle;
            const lower = ["name-tag", "glass-card", "freeze-sticker"].includes(style);
            setSettings((s) => ({ ...s, style, entry: FACECAM_STYLES.find(item=>item.id===style)?.text ? s.entry : 'none', y: lower ? 0.7 : 0.28, textSize: lower ? 0.065 : 0.14 }));
            setNote(null);
          }}
        >
          {FACECAM_STYLES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-text-muted">{definition.description}</p>
        {definition.text && <section aria-label="Pengaturan animasi masuk teks/kartu" className="space-y-2 rounded-md border p-3">
          <label className="block text-xs text-text-muted">Animasi masuk teks/kartu
            <select className={field} value={settings.entry} onChange={e=>set('entry',e.target.value as FacecamSettings['entry'])}>
              <option value="none">Tidak ada</option><option value="slide">Slide</option><option value="pop">Pop Zoom</option><option value="slide-pop">Slide + Pop Zoom</option>
            </select>
          </label>
          {settings.entry !== 'none' && <>
            {settings.entry !== 'pop' && <label className="block text-xs text-text-muted">Arah masuk Facecam
              <select className={field} value={settings.entryDirection} onChange={e=>set('entryDirection',e.target.value as FacecamSettings['entryDirection'])}>
                <option value="left">Dari kiri</option><option value="right">Dari kanan</option><option value="top">Dari atas</option><option value="bottom">Dari bawah</option>
              </select>
            </label>}
            <label className="block text-xs text-text-muted">Durasi masuk Facecam (s) <span className="float-right">{settings.entryDuration.toFixed(2)} s</span>
              <input className="w-full accent-[var(--accent)]" type="range" min="0.1" max="3" step="0.05" value={settings.entryDuration} onChange={e=>set('entryDuration',Number(e.target.value))} />
            </label>
            <label className="block text-xs text-text-muted">Delay Facecam (s) <span className="float-right">{settings.entryDelay.toFixed(2)} s</span>
              <input className="w-full accent-[var(--accent)]" type="range" min="0" max="5" step="0.05" value={settings.entryDelay} onChange={e=>set('entryDelay',Number(e.target.value))} />
            </label>
            <button type="button" className="rounded border px-2 py-1 text-xs" onClick={()=>setSettings(s=>({...s,entry:'none',entryDirection:'left',entryDuration:.45,entryDelay:0}))}>Reset animasi masuk</button>
            <p className="text-xs text-text-muted">Hanya teks, name tag, atau kartu yang masuk. Video/orang tetap di tempat, termasuk selama delay. Posisi akhirnya mengikuti grid Teks/kartu.</p>
          </>}
        </section>}
        <FacecamPositionControl label="Video/orang" x={settings.frameX} y={settings.frameY} zoom={settings.frameZoom}
          onChange={patch=>setSettings(s=>({...s,frameX:patch.x??s.frameX,frameY:patch.y??s.frameY,frameZoom:patch.zoom??s.frameZoom}))}
          onReset={()=>setSettings(s=>({...s,frameX:.5,frameY:.5,frameZoom:1}))} />
        <p className="text-xs text-text-muted">Mengatur framing video/orang untuk semua style. Posisi teks/kartu diatur terpisah di bawah. Klik Apply Facecam Style untuk melihat hasil di timeline.</p>
        <label className="block text-xs text-text-muted">
          Facecam duration (seconds)
          <input
            className={field}
            type="number"
            min={0.2}
            max={30}
            step={0.1}
            value={settings.duration}
            onChange={(e) => set("duration", Number(e.target.value))}
          />
        </label>
        {definition.text && (
          <>
            <label className="block text-xs text-text-muted">
              {settings.style === "spotlight" ? "Facecam text (optional)" : "Facecam text"}
              <input
                className={field}
                value={settings.text}
                maxLength={48}
                onChange={(e) => set("text", e.target.value)}
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-text-muted">
                Facecam font
                <select className={field} value={settings.font} onChange={(e) => set("font", e.target.value)}>
                  <option>Noto Sans</option>
                  <option>Anton</option>
                  <option>Lato</option>
                  <option>Barlow</option>
                </select>
              </label>
              <label className="text-xs text-text-muted">
                Text size (% width)
                <input
                  className={field}
                  type="number"
                  min={3}
                  max={25}
                  step={0.5}
                  value={Math.round(settings.textSize * 1000) / 10}
                  onChange={(e) => set("textSize", Number(e.target.value) / 100)}
                />
              </label>
            </div>
          </>
        )}
        {["lean-in", "slow-push"].includes(settings.style) && (
          <label className="block text-xs text-text-muted">
            Zoom animasi Facecam
            <input
              className={field}
              type="number"
              min={1}
              max={1.6}
              step={0.01}
              value={settings.zoom}
              onChange={(e) => set("zoom", Number(e.target.value))}
            />
          </label>
        )}
        {settings.style === "slow-push" && (
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={settings.parallax}
              onChange={(e) => set("parallax", e.target.checked)}
            />
            Subject parallax (heavier)
          </label>
        )}
        {!["lean-in", "slow-push", "text-behind", "backdrop-word", "silhouette-intro"].includes(
          settings.style,
        ) && (
          <label className="block text-xs text-text-muted">
            Facecam intensity
            <input
              className="w-full accent-[var(--accent)]"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={settings.strength}
              onChange={(e) => set("strength", Number(e.target.value))}
            />
          </label>
        )}
        {positioned && <FacecamPositionControl label="Teks/kartu" x={settings.x} y={settings.y}
          onChange={patch=>setSettings(s=>({...s,x:patch.x??s.x,y:patch.y??s.y}))}
          onReset={()=>setSettings(s=>({...s,x:0.5,y:["name-tag","glass-card","freeze-sticker"].includes(s.style) ? 0.7 : 0.28}))} />}
        {!["lean-in", "slow-push", "bottom-fade"].includes(settings.style) && (
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ["accent", "Accent"],
                ["textColor", "Text colour"],
                ["background", "Card / silhouette"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="text-[10px] text-text-muted">
                {label}
                <input
                  className="block h-8 w-full cursor-pointer rounded border"
                  type="color"
                  aria-label={`Facecam ${label}`}
                  value={settings[key]}
                  onChange={(e) => set(key, e.target.value)}
                />
              </label>
            ))}
          </div>
        )}
        {settings.style === "glass-card" && (
          <>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ["fromValue", "Counter from"],
                  ["toValue", "Counter to"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="text-xs text-text-muted">
                  {label}
                  <input
                    className={field}
                    type="number"
                    min={-1e9}
                    max={1e9}
                    step={1}
                    value={settings[key]}
                    onChange={(e) => set(key, Number(e.target.value))}
                  />
                </label>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={settings.graph}
                onChange={(e) => set("graph", e.target.checked)}
              />
              Decorative rising graph
            </label>
            <p className="text-xs text-text-muted">
              Enter your own numbers. The optional graph is decorative, not a data chart.
            </p>
          </>
        )}
      </fieldset>
      <p className="text-xs text-text-muted">
        {facecamNeedsSubject(settings)
          ? "Uses the existing local subject model. Best with one clear person. "
          : "No subject AI needed. "}
        Applies from the playhead, up to 30 seconds at 30 fps / 1920 px. Original audio continues. The
        rendered effect is baked into a new video clip; one Undo restores the original.
      </p>
      {reason && <p className="text-xs text-text-muted">{reason}</p>}
      <Button
        variant="secondary"
        className="w-full"
        disabled={busy || Boolean(reason)}
        onClick={async () => {
          if (running.current) return;
          running.current = true;
          controller.current = new AbortController();
          setBusy(true);
          setProgress(0);
          setNote(null);
          const saved = { ...settings };
          const time = usePlaybackStore.getState().playhead;
          try {
            const runtime = await invoke<{ ready: boolean; reason: string | null }>("highlight_runtime", {
              subject: facecamNeedsSubject(saved),
            });
            if (!runtime?.ready)
              throw new Error(runtime?.reason ?? "The existing local style runtime is unavailable.");
            const result = await createFacecamStyle(clip.id, time, saved, controller.current.signal);
            setNote(
              result.ok
                ? "Facecam style applied. Play the timeline to preview it; Undo restores the original."
                : result.error.message,
            );
          } catch (error) {
            setNote(error instanceof Error ? error.message : String(error));
          } finally {
            running.current = false;
            setBusy(false);
          }
        }}
      >
        {busy ? `Rendering facecam… ${Math.round(progress * 100)}%` : "Apply Facecam Style"}
      </Button>
      {busy && (
        <Button variant="secondary" onClick={() => controller.current?.abort()}>
          Cancel facecam render
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
