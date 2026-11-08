import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** App-wide close confirmation; independent of the currently visible workspace. */
export function CloseConfirmation() {
  const [open, setOpen] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let disposed = false;
    const off = getCurrentWindow().onCloseRequested(event => {
      event.preventDefault();
      if (!disposed) setOpen(true);
    }).catch(() => () => {});
    return () => { disposed = true; void off.then(unlisten => unlisten()).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (!open) return;
    cancel.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setOpen(false); }
      if (event.key === 'Tab') {
        event.preventDefault();
        const buttons = cancel.current?.parentElement?.querySelectorAll('button');
        const next = document.activeElement === buttons?.[0] ? buttons?.[1] : buttons?.[0];
        next?.focus();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open]);
  if (!open) return null;
  return <div style={{ position: 'fixed', inset: 0, zIndex: 2147483647, background: '#0009', display: 'grid', placeItems: 'center' }}>
    <div role="alertdialog" aria-modal="true" aria-labelledby="quit-title" aria-describedby="quit-description" style={{ boxSizing: 'border-box', background: '#1d2015', color: '#e5e5df', border: '1px solid #343923', borderRadius: 8, padding: 16, width: 'min(448px, 90vw)', fontFamily: 'Arial, sans-serif', fontSize: 13, lineHeight: '20px', textAlign: 'left', textShadow: 'none' }}>
      <style>{`.socl-quit-button:hover { filter: brightness(1.2); } .socl-quit-button:focus { outline: none; } .socl-quit-button:focus-visible { outline: 2px solid #a8b56a; outline-offset: 2px; }`}</style>
      <h2 id="quit-title" style={{ margin: 0, padding: 0, fontSize: 13, lineHeight: '20px', fontWeight: 600 }}>Quit without saving?</h2>
      <p id="quit-description" style={{ margin: '8px 0 0', padding: 0, color: '#989b8f', fontSize: 13, lineHeight: '20px', fontWeight: 400 }}>You have unsaved changes. If you quit now they will be lost.</p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 16 }}>
        <button className="socl-quit-button" style={{ appearance: 'none', background: 'transparent', color: '#e5e5df', border: 0, borderRadius: 6, padding: '6px 12px', margin: 0, font: '600 13px/20px Arial, sans-serif', boxShadow: 'none', cursor: 'pointer' }} ref={cancel} onClick={() => setOpen(false)}>Cancel</button>
        <button className="socl-quit-button" style={{ appearance: 'none', background: '#34271f', color: '#ef4444', border: 0, borderRadius: 6, padding: '6px 12px', margin: 0, font: '600 13px/20px Arial, sans-serif', boxShadow: 'none', cursor: 'pointer' }} onClick={() => { void getCurrentWindow().destroy(); }}>Quit without saving</button>
      </div>
    </div>
  </div>;
}
