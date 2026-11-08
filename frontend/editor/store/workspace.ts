import { create } from 'zustand';
export const useWorkspaceStore = create<{ mode: 'effects' | 'caption'; clipBound: boolean }>(() => ({ mode: 'effects', clipBound: false }));
