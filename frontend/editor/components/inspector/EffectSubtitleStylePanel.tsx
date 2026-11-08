import { useState } from "react";
import { useTextStyleStore, allStyles } from "@/store/textStyles";
import { StyleEditor } from "@/components/text/StyleEditor";
import { Button } from "@/components/ui/button";
import type { Project } from "@/project/model";
import {
  DEFAULT_EFFECT_SUBTITLE_STYLE,
  effectSubtitleTracks,
  type EffectSubtitleOverride,
} from "@/timeline/effectSubtitles";
const field = "h-9 w-full min-w-0 max-w-full rounded-md border bg-surface-2 px-2 text-sm";
export function EffectSubtitleStylePanel({
  project,
  value,
  onChange,
}: {
  project: Project;
  value: EffectSubtitleOverride | null;
  onChange: (next: EffectSubtitleOverride | null) => void;
}) {
  const mine = useTextStyleStore((s) => s.mine);
  const presets = allStyles({ mine });
  const tracks = effectSubtitleTracks(project);
  const [preset, setPreset] = useState("effect-bold"),
    [customize, setCustomize] = useState(false);
  return (
    <section aria-label="Subtitle style during effect" className="min-w-0 space-y-2 rounded-md border p-2">
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={!!value}
          disabled={!tracks.length}
          onChange={(e) => {
            if (!e.target.checked) {
              onChange(null);
              return;
            }
            const preferred = tracks.filter(
              (t) =>
                /subtitle|caption/i.test(t.name) ||
                t.clips.some((c) => project.assets.find((a) => a.id === c.assetId)?.text?.highlight?.word),
            );
            setPreset("effect-bold");
            onChange({
              trackIds: (preferred.length ? preferred : tracks).map((t) => t.id),
              style: structuredClone(DEFAULT_EFFECT_SUBTITLE_STYLE),
            });
          }}
        />
        Subtitle style during effect
      </label>
      {!tracks.length && (
        <p className="text-xs text-text-muted">
          Generate/import subtitles first to use an effect-specific look.
        </p>
      )}
      {value && (
        <>
          <p className="text-xs text-text-muted">
            Only the checked tracks change during this effect. Before and after it, the original subtitle
            style stays intact.
          </p>
          <div className="space-y-1">
            {tracks.map((track) => (
              <label key={track.id} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  aria-label={`Effect subtitles: ${track.name}`}
                  checked={value.trackIds.includes(track.id)}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      trackIds: e.target.checked
                        ? [...value.trackIds, track.id]
                        : value.trackIds.filter((id) => id !== track.id),
                    })
                  }
                />
                {track.name}
              </label>
            ))}
          </div>
          <label className="block text-xs text-text-muted">
            Effect subtitle preset
            <select
              className={field}
              value={preset}
              onChange={(e) => {
                const id = e.target.value;
                setPreset(id);
                const style =
                  id === "effect-bold"
                    ? DEFAULT_EFFECT_SUBTITLE_STYLE
                    : presets.find((p) => p.id === id)?.style;
                if (style) onChange({ ...value, style: structuredClone(style) });
              }}
            >
              <option value="effect-bold">Halftone caption · dark boxes</option>
              {preset === "custom" && <option value="custom">Custom effect subtitle</option>}
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <Button type="button" variant="secondary" size="sm" onClick={() => setCustomize(!customize)}>
            {customize ? "Hide effect subtitle settings" : "Customize effect subtitle"}
          </Button>
          {customize && (
            <StyleEditor
              showFade={false}
              showWordGrouping={false}
              label="Effect subtitle"
              value={{ style: value.style }}
              onChange={(next) => {
                setPreset("custom");
                onChange({ ...value, style: next.style });
              }}
            />
          )}
          <p className="text-xs text-text-muted">
            Existing active-word timing is preserved. Captions without word timing use estimates if the chosen
            preset highlights words. Font size, position and motion stay as they are. Apply once; one Undo
            restores video and subtitles.
          </p>
        </>
      )}
    </section>
  );
}
