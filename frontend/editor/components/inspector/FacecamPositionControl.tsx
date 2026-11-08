const positions = [
  ['Kiri atas', .2, .2], ['Tengah atas', .5, .2], ['Kanan atas', .8, .2],
  ['Kiri tengah', .2, .5], ['Tengah', .5, .5], ['Kanan tengah', .8, .5],
  ['Kiri bawah', .2, .8], ['Tengah bawah', .5, .8], ['Kanan bawah', .8, .8],
] as const;

export function FacecamPositionControl({ label, x, y, zoom, onChange, onReset }: {
  label: string; x: number; y: number; zoom?: number;
  onChange: (patch: { x?: number; y?: number; zoom?: number }) => void;
  onReset: () => void;
}) {
  return <section aria-label={label} className="space-y-2 rounded-md border p-3">
    <div className="flex items-center justify-between gap-2"><h4 className="text-xs font-medium">{label}</h4><button type="button" onClick={onReset} className="rounded border px-2 py-1 text-xs">Reset {label}</button></div>
    <div role="group" aria-label={`Grid 9 titik ${label}`} className="grid w-32 grid-cols-3 gap-1 rounded-md border p-1">
      {positions.map(([name, px, py]) => <button key={name} type="button" title={name} aria-label={`${label}: ${name}`} aria-pressed={Math.abs(x-px)<.001 && Math.abs(y-py)<.001}
        onClick={() => onChange({x:px,y:py})} className={`flex h-8 items-center justify-center rounded border ${Math.abs(x-px)<.001 && Math.abs(y-py)<.001 ? 'border-accent bg-accent-soft text-accent' : 'border-transparent text-text-muted hover:bg-surface-2'}`}><span aria-hidden>●</span></button>)}
    </div>
    {(['x','y'] as const).map(axis => <label key={axis} className="block text-xs text-text-muted">{label} {axis.toUpperCase()} (%)<span className="float-right tabular-nums">{Math.round((axis==='x'?x:y)*100)}%</span>
      <input type="range" min="0" max="100" step="1" value={Math.round((axis==='x'?x:y)*100)} onChange={e=>onChange({[axis]:Number(e.target.value)/100})} className="w-full accent-[var(--accent)]" />
    </label>)}
    {zoom !== undefined && <label className="block text-xs text-text-muted">{label} Zoom (%)<span className="float-right tabular-nums">{Math.round(zoom*100)}%</span>
      <input type="range" min="50" max="250" step="1" value={Math.round(zoom*100)} onChange={e=>onChange({zoom:Number(e.target.value)/100})} className="w-full accent-[var(--accent)]" />
    </label>}
  </section>;
}
