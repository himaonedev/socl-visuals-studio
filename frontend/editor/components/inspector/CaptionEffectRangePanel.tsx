import { useState } from 'react';
import { useProjectStore } from '@/store/project';
import { EffectSubtitleStylePanel } from './EffectSubtitleStylePanel';
import { prepareEffectSubtitles, applyEffectSubtitles, type EffectSubtitleOverride } from '@/timeline/effectSubtitles';

/** Style just a time interval, leaving the caption's original style on either side. */
export function CaptionEffectRangePanel() {
  const project = useProjectStore(s => s.project);
  const [value, setValue] = useState<EffectSubtitleOverride | null>(null);
  const [start, setStart] = useState(0), [end, setEnd] = useState(6);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const apply = async () => {
    setBusy(true); setMessage('');
    try {
      if (!value || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('Pilih rentang waktu dan style terlebih dahulu.');
      const snapshot = useProjectStore.getState().project;
      const plans = await prepareEffectSubtitles(snapshot, start, end, value);
      if (useProjectStore.getState().project !== snapshot) throw new Error('Caption berubah. Coba terapkan lagi.');
      const result = useProjectStore.getState().execute({ label: 'Style caption selama efek', apply: p => applyEffectSubtitles(p, plans) });
      if (!result.ok) throw new Error(result.error.message);
      setMessage('Style diterapkan pada rentang ini; sebelum dan sesudahnya tetap memakai style awal.');
    } catch (e) { setMessage(String(e)); }
    finally { setBusy(false); }
  };
  return <section className="space-y-2 border-t pt-3" aria-label="Style caption selama efek">
    <p className="text-xs text-text-muted">Atur waktu Halftone/freeze pada video, lalu pilih style caption khusus untuk rentang tersebut.</p>
    <div className="flex gap-2">
      <label className="text-xs">Mulai (s)<input aria-label="Mulai style efek" type="number" min="0" step="0.1" value={start} onChange={e => setStart(Number(e.target.value))} className="h-9 w-full rounded border bg-surface-2 px-2" /></label>
      <label className="text-xs">Selesai (s)<input aria-label="Selesai style efek" type="number" min="0" step="0.1" value={end} onChange={e => setEnd(Number(e.target.value))} className="h-9 w-full rounded border bg-surface-2 px-2" /></label>
    </div>
    <EffectSubtitleStylePanel project={project} value={value} onChange={setValue} />
    <button type="button" disabled={busy || !value} onClick={() => void apply()} className="h-9 rounded border px-3 text-xs disabled:opacity-40">{busy ? 'Menyiapkan…' : 'Terapkan style pada rentang'}</button>
    {message && <p role="status" className="text-xs">{message}</p>}
  </section>;
}
