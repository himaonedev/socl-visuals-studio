// app/src/edit-history.js
// Pure undo/redo stack for the caption editor. Loaded BOTH by the Electron
// renderer (script tag → window.EditHistory) and by node tests (require).
// Never touches the DOM. The CALLER passes already-serialized snapshots
// (string JSON) so this module can dedupe in O(1) by === and never has to
// clone/freeze anything.
interface LegacyEditHistory {
  push(snapshot: string): void;
  undo(current: string): string | null;
  redo(current: string): string | null;
  canUndo(): boolean;
  canRedo(): boolean;
  clear(): void;
  size(): number;
}
declare var EditHistory: { createHistory(opts?: { limit?: number }): LegacyEditHistory };
(function (root: typeof globalThis) {
  'use strict';

  // createHistory({ limit }) → a small undo/redo controller.
  //   push(snapshot)  — record a pre-mutation snapshot. Dedupes: a snapshot
  //                     equal to the top of the undo stack is ignored. Any
  //                     push clears the redo stack. Oldest entries are dropped
  //                     once the undo stack exceeds `limit`.
  //   undo(current)   — returns the previous snapshot and pushes `current`
  //                     onto the redo stack, or null when nothing to undo.
  //   redo(current)   — symmetric to undo.
  //   canUndo()/canRedo()/clear()/size()
  function createHistory(opts?: { limit?: number }): LegacyEditHistory {
    const requested = opts?.limit;
    const limit = (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) ? Math.floor(requested) : 100;
    let undoStack: string[] = [];
    let redoStack: string[] = [];

    function push(snapshot: string) {
      // Dedupe identical consecutive snapshots — rapid-fire callers (drags,
      // number inputs, no-op clicks) should never bloat the history.
      if (undoStack.length && undoStack[undoStack.length - 1] === snapshot) return;
      undoStack.push(snapshot);
      // A fresh edit invalidates any redo branch.
      redoStack = [];
      // Enforce the cap by dropping the OLDEST snapshot(s).
      if (undoStack.length > limit) undoStack.splice(0, undoStack.length - limit);
    }

    function undo(current: string) {
      if (!undoStack.length) return null;
      const prev = undoStack.pop()!;
      redoStack.push(current);
      return prev;
    }

    function redo(current: string) {
      if (!redoStack.length) return null;
      const next = redoStack.pop()!;
      undoStack.push(current);
      return next;
    }

    function canUndo() { return undoStack.length > 0; }
    function canRedo() { return redoStack.length > 0; }
    function clear() { undoStack = []; redoStack = []; }
    function size() { return undoStack.length; }

    return { push, undo, redo, canUndo, canRedo, clear, size };
  }

  const api = { createHistory };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EditHistory = api;
})(typeof self !== 'undefined' ? self : this);
