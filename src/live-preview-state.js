// Generated from frontend/legacy-src/live-preview-state.ts by scripts/backend.cjs. Edit the TypeScript source.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports)
        module.exports = api;
    if (root)
        root.LivePreviewState = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    function beginRun(state) {
        return {
            ...state,
            sourcePreview: state.sourcePreview || null,
            clips: state.clips || [],
            retainPreviousClips: !!state.clips?.some(c => c.file),
            pendingClips: [],
            activeClip: state.activeClip ?? -1,
            currentPreviewIdx: state.currentPreviewIdx ?? -1,
        };
    }
    function setSourcePreview(state, preview) {
        return { ...state, sourcePreview: preview || null };
    }
    function setCandidates(state, candidates) {
        if (state.retainPreviousClips) {
            const staged = setCandidates({ ...state, retainPreviousClips: false, clips: state.pendingClips || [] }, candidates);
            return { ...state, pendingClips: staged.clips };
        }
        const previous = new Map((state.clips || []).map(c => [c.candidateId, c]));
        return {
            ...state,
            sourcePreview: state.sourcePreview || null,
            clips: (candidates || []).map((candidate, i) => ({
                ...previous.get(candidate.candidateId),
                ...candidate,
                index: i + 1,
                state: candidate.state || 'waiting',
            })),
        };
    }
    function setCandidateState(state, update) {
        if (!update?.candidateId)
            return state;
        if (state.retainPreviousClips) {
            const staged = setCandidateState({ ...state, retainPreviousClips: false, clips: state.pendingClips || [] }, update);
            return { ...state, pendingClips: staged.clips };
        }
        return {
            ...state,
            clips: (state.clips || []).map(c => c.candidateId === update.candidateId && !c.file ? { ...c, ...update } : c),
        };
    }
    function completeClip(state, clip) {
        if (state.retainPreviousClips) {
            const staged = completeClip({ ...state, retainPreviousClips: false, clips: state.pendingClips || [] }, clip);
            return { ...state, pendingClips: staged.clips };
        }
        const clips = state.clips || [];
        const found = clips.some(c => c.candidateId === clip.candidateId);
        return {
            ...state,
            clips: found
                ? clips.map(c => c.candidateId === clip.candidateId
                    ? { ...c, ...clip, state: 'ready' }
                    : c)
                : [...clips, { ...clip, state: 'ready' }],
        };
    }
    function finishRun(state, success) {
        const replace = success && state.retainPreviousClips && state.pendingClips?.some(c => c.file);
        return {
            ...state,
            ...(replace ? { clips: state.pendingClips, activeClip: -1, currentPreviewIdx: -1 } : {}),
            pendingClips: [], retainPreviousClips: false,
        };
    }
    function snapshot(state) {
        return JSON.stringify({ version: 1, savedAt: Date.now(), clips: state.clips || [],
            sourcePreview: state.sourcePreview || null, pendingClips: state.pendingClips || [],
            retainPreviousClips: !!state.retainPreviousClips, running: !!state.running,
            activeClip: state.activeClip ?? -1, currentPreviewIdx: state.currentPreviewIdx ?? -1 });
    }
    function restoreSnapshot(text) {
        try {
            if (!text || text.length > 4 * 1024 * 1024)
                return null;
            const value = JSON.parse(text);
            const validClips = clips => Array.isArray(clips) && clips.length <= 1000 && clips.every(c => c && typeof c === 'object' && !Array.isArray(c));
            if (value.version !== 1 || !Number.isFinite(value.savedAt) || Date.now() - value.savedAt > 12 * 3600 * 1000 || !validClips(value.clips) || !validClips(value.pendingClips))
                return null;
            return { clips: value.clips, sourcePreview: value.sourcePreview && typeof value.sourcePreview === 'object' ? value.sourcePreview : null,
                pendingClips: value.pendingClips, retainPreviousClips: !!value.retainPreviousClips, running: !!value.running,
                activeClip: Number.isInteger(value.activeClip) ? value.activeClip : -1, currentPreviewIdx: Number.isInteger(value.currentPreviewIdx) ? value.currentPreviewIdx : -1 };
        }
        catch {
            return null;
        }
    }
    return { beginRun, setSourcePreview, setCandidates, setCandidateState, completeClip, finishRun, snapshot, restoreSnapshot };
});
