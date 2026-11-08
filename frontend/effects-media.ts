import { invoke } from '@tauri-apps/api/core';
import type { ImportedMedia } from './editor/lib/media';

// Prefetch without changing the project or pausing Clipping. Consume each result
// once, and keep the window short so a replaced file is not reused indefinitely.
const pending = new Map<string, { at: number; promise: Promise<ImportedMedia> }>();
const MAX_AGE = 15_000;
export function warmEffectsMedia(path: string): void {
  if (pending.has(path) && Date.now() - pending.get(path)!.at < MAX_AGE) return;
  const promise = invoke<ImportedMedia>('import_socl_clip', { path, metadataOnly: true });
  const entry = { at: Date.now(), promise };
  pending.set(path, entry);
  while (pending.size > 8) pending.delete(pending.keys().next().value!);
  void promise.catch(() => { if (pending.get(path) === entry) pending.delete(path); });
}
export function loadEffectsMedia(path: string): Promise<ImportedMedia> {
  const entry = pending.get(path);
  pending.delete(path);
  if (entry && Date.now() - entry.at < MAX_AGE) return entry.promise;
  return invoke<ImportedMedia>('import_socl_clip', { path, metadataOnly: true });
}
