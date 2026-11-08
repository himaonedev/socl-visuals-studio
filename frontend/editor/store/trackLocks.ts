import { create } from "zustand";
import { persist } from "zustand/middleware";

interface TrackLocksState {
  locks: Record<string, boolean>;
  toggle: (projectId: string, trackId: string) => void;
}
const key = (projectId: string, trackId: string) => JSON.stringify([projectId, trackId]);
/** Local editor protection, scoped to project and track IDs; never changes rendered media. */
export const useTrackLocksStore = create<TrackLocksState>()(
  persist(
    (set) => ({
      locks: {},
      toggle: (projectId, trackId) =>
        set((s) => {
          const locks = { ...s.locks },
            id = key(projectId, trackId);
          if (locks[id]) delete locks[id];
          else locks[id] = true;
          return { locks };
        }),
    }),
    { name: "cutvii-track-locks-v1", partialize: (s) => ({ locks: s.locks }) },
  ),
);
export const isTrackLocked = (projectId: string, trackId: string) =>
  useTrackLocksStore.getState().locks[key(projectId, trackId)] === true;
export const trackLockKey = key;
