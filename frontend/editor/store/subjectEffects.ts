import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { prepareSubjectEffect, type SubjectMode } from "@/timeline/subjectEffects";

interface State {
  ready: boolean | null;
  reason: string | null;
  busy: boolean;
  fraction: number;
  note: string | null;
  check: () => Promise<void>;
  run: (clipId: string, mode: SubjectMode, blur: number, title: string) => Promise<void>;
  cancel: () => void;
}
let listening: Promise<unknown> | null = null;
export const useSubjectEffectsStore = create<State>((set, get) => ({
  ready: null,
  reason: null,
  busy: false,
  fraction: 0,
  note: null,
  check: async () => {
    try {
      const result = await invoke<{ ready: boolean; reason: string | null }>("subject_runtime");
      set({ ready: result?.ready === true, reason: result?.reason ?? null });
    } catch (error) {
      set({ ready: false, reason: String(error) });
    }
  },
  run: async (clipId, mode, blur, title) => {
    if (get().busy) return;
    set({ busy: true, fraction: 0, note: null });
    listening ??= listen<{ fraction: number }>("subject-progress", (event) =>
      set({ fraction: event.payload.fraction }),
    ).catch(() => null);
    await listening;
    try {
      const result = await prepareSubjectEffect(clipId, mode, blur, title);
      set({
        note: result.ok ? "Subject effect applied. Undo restores the original clip." : result.error.message,
      });
    } catch (error) {
      set({ note: String(error) });
    } finally {
      set({ busy: false });
    }
  },
  cancel: () => {
    void invoke("cancel_ai_job");
  },
}));
