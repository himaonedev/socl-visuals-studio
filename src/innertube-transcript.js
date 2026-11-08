// Generated from backend/src/innertube-transcript.ts by scripts/backend.cjs. Edit the TypeScript source.
// Direct YouTube Innertube caption fetch — bypasses yt-dlp entirely for the
// common case of "video already has captions" instead of shelling out to a
// subprocess for a metadata-only request.
//
// [WHY] Measured on a real video (2026-08-06): yt-dlp's own subtitle-fetch
// path (spawn + webpage scrape + format resolution) took 13.9s and is prone
// to YouTube's subtitle-endpoint 429s. A competitor app doing this exact
// thing — direct HTTPS calls to the player API, no subprocess — did the
// same job in 1.13s, confirmed from its own debug log: ANDROID_VR rejected
// in ~260ms ("Sign in to confirm you're not a bot" — EXPECTED, not an
// error), cascade to ANDROID succeeds in ~340ms, then one GET to the
// timedtext endpoint. This module reproduces that exact cascade.
//
// Client context fields are copied from yt-dlp's own INNERTUBE_CLIENTS
// table (yt_dlp/extractor/youtube/_base.py) rather than guessed — these are
// public, non-secret values already embedded in every Android YouTube app
// build, and yt-dlp (already bundled in this app) sends the identical
// values today via its own subprocess. No API key is required for these
// app clients; identification is via the X-YouTube-Client-* headers.
'use strict';
const CLIENTS = [
    {
        name: 'ANDROID_VR',
        clientNameHeader: '28',
        context: {
            clientName: 'ANDROID_VR',
            clientVersion: '1.65.10',
            deviceMake: 'Oculus',
            deviceModel: 'Quest 3',
            androidSdkVersion: 32,
            userAgent: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
            osName: 'Android',
            osVersion: '12L',
        },
    },
    {
        name: 'ANDROID',
        clientNameHeader: '3',
        context: {
            clientName: 'ANDROID',
            clientVersion: '20.10.38',
            androidSdkVersion: 30,
            userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
            osName: 'Android',
            osVersion: '11',
        },
    },
];
const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player';
const DEFAULT_TIMEOUT_MS = 15000;
function extractVideoId(urlOrId) {
    if (!urlOrId)
        return null;
    if (/^[\w-]{11}$/.test(urlOrId))
        return urlOrId;
    const patterns = [
        /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/|youtube\.com\/live\/)([\w-]{11})/,
    ];
    for (const re of patterns) {
        const m = urlOrId.match(re);
        if (m)
            return m[1];
    }
    return null;
}
async function fetchWithTimeout(url, opts, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await fetch(url, { ...opts, signal: ctrl.signal });
    }
    finally {
        clearTimeout(t);
    }
}
// Tries each client in order; returns the first player response whose
// captions.playerCaptionsTracklistRenderer is present. A client "rejecting"
// (LOGIN_REQUIRED / bot-check) is the EXPECTED shape for ANDROID_VR — it is
// not logged as a failure, only as a cascade step.
async function fetchPlayerResponse(videoId, { onLog, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    let lastStatus = null;
    for (const client of CLIENTS) {
        const t0 = Date.now();
        const body = JSON.stringify({
            context: { client: client.context },
            videoId,
        });
        let res;
        try {
            res = await fetchWithTimeout(PLAYER_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-YouTube-Client-Name': client.clientNameHeader,
                    'X-YouTube-Client-Version': client.context.clientVersion,
                    'User-Agent': client.context.userAgent,
                    Origin: 'https://www.youtube.com',
                },
                body,
            }, timeoutMs);
        }
        catch (e) {
            onLog?.(`innertube: ${client.name} network error (${e.message}) — mencoba client lain…`);
            continue;
        }
        const elapsedMs = Date.now() - t0;
        if (!res.ok) {
            lastStatus = res.status;
            onLog?.(`innertube: ${client.name} HTTP ${res.status} (${elapsedMs}ms) — mencoba client lain…`);
            continue;
        }
        const json = await res.json();
        const status = json?.playabilityStatus?.status;
        const captionsNode = json?.captions?.playerCaptionsTracklistRenderer;
        if (status && status !== 'OK' && !captionsNode) {
            // e.g. LOGIN_REQUIRED ("Sign in to confirm you're not a bot") — the
            // expected shape for ANDROID_VR before falling through to ANDROID.
            lastStatus = status;
            onLog?.(`innertube: ${client.name} ditolak (${status}, ${elapsedMs}ms) — cascade ke client berikutnya…`);
            continue;
        }
        if (!captionsNode?.captionTracks?.length) {
            lastStatus = 'NO_CAPTIONS';
            onLog?.(`innertube: ${client.name} OK tapi video tidak punya caption track (${elapsedMs}ms)`);
            continue;
        }
        onLog?.(`innertube: ${client.name} OK (${elapsedMs}ms), ${captionsNode.captionTracks.length} caption track(s)`);
        return captionsNode;
    }
    const err = new Error(`Innertube: semua client gagal (terakhir: ${lastStatus})`);
    err.code = 'INNERTUBE_ALL_CLIENTS_FAILED';
    throw err;
}
function langCodeOf(track) {
    return (track.languageCode || '').toLowerCase();
}
// [AUTODUB-ASR] On a video YouTube AI-dubbed (observed: 77k-ugH5yF0, 20 dub
// languages), every dubbed audio track gets its own ASR caption track, marked
// variant=timing-optimized in its baseUrl. Those transcribe the dub — a
// machine translation — not what is said on screen. Ordinary ASR tracks carry
// no variant, or a different one (variant=gemini on Qtl8lJwbd4g's own speech).
function isAutoDubAsr(track) {
    if (track.kind !== 'asr' || !track.baseUrl)
        return false;
    try {
        return new URL(track.baseUrl).searchParams.get('variant') === 'timing-optimized';
    }
    catch {
        return false;
    }
}
// Mirrors the existing yt-dlp candidate cascade (preferred -> id/ms sibling
// -> en -> any), but resolved in ONE pass since Innertube returns every
// available track up front instead of requiring one network round-trip per
// language guess.
function pickBestTrack(allTracks, preferredLang, langHint) {
    if (!allTracks.length)
        return null;
    const norm = String(preferredLang || 'auto').toLowerCase();
    // [AUTODUB-ASR] Dub transcripts go last. On 77k-ugH5yF0 all 21 tracks were
    // ASR with no isDefault and no track for the uploader's (wrong) en-US hint,
    // so auto fell through to tracks[0] — the Arabic dub, as YouTube sorts by
    // language name — and the session was labelled Arabic. Auto asks for the
    // video's own language, so it never takes a dub while the spoken audio has
    // a track; an explicit language still gets one when it is all there is.
    const spoken = allTracks.filter(t => !isAutoDubAsr(t));
    const tracks = norm === 'auto' && spoken.length
        ? spoken
        : [...spoken, ...allTracks.filter(isAutoDubAsr)];
    if (norm === 'auto') {
        // [METADATA-LANG-FIX] The isDefault/manual/first-track heuristics below
        // only look at the track list itself, never at what language the video
        // is actually IN. On a video with many fan-contributed manual tracks
        // (observed: a MrBeast video, English original), the first non-ASR track
        // in YouTube's array can be an unrelated language (Arabic) — picked
        // blindly even though isDefault was unset and metadata clearly says the
        // video is English. When the caller has a real signal for the video's
        // spoken language (yt-dlp's `original_language`/`language` from
        // info.json), prefer a track matching THAT first, manual over ASR.
        const hintBase = String(langHint || '').toLowerCase().split(/[-_]/)[0];
        if (hintBase) {
            const hintManual = tracks.find(t => langCodeOf(t).split(/[-_]/)[0] === hintBase && t.kind !== 'asr');
            if (hintManual)
                return hintManual;
            const hintAny = tracks.find(t => langCodeOf(t).split(/[-_]/)[0] === hintBase);
            if (hintAny)
                return hintAny;
        }
        // [AUTO-LANG-FIX] YouTube orders captionTracks by the VIEWER's region/locale,
        // not by the video's original language. For an English video viewed from
        // Indonesia, tracks[0] is often the 'id' ASR auto-translation, not the
        // original 'en' track — so blindly returning tracks[0] gave Indonesian
        // subtitles on English videos.
        //
        // Priority order (when no metadata language hint matched a track):
        //  1. Track marked isDefault=true by YouTube (= original upload language)
        //  2. Any manual (human-authored) track — human subs beat auto-generated
        //  3. First track whose kind is NOT 'asr' (auto-translation)
        //  4. tracks[0] as final fallback (was the only behaviour before this fix)
        const defaultTrack = tracks.find(t => t.isDefault === true);
        if (defaultTrack)
            return defaultTrack;
        const manualTrack = tracks.find(t => t.kind !== 'asr');
        if (manualTrack)
            return manualTrack;
        return tracks[0];
    }
    let hit = tracks.find(t => langCodeOf(t) === norm && t.kind !== 'asr');
    if (hit)
        return hit;
    hit = tracks.find(t => langCodeOf(t) === norm);
    if (hit)
        return hit;
    const sibling = norm === 'id' ? 'ms' : norm === 'ms' ? 'id' : null;
    if (sibling) {
        hit = tracks.find(t => langCodeOf(t) === sibling);
        if (hit)
            return hit;
    }
    hit = tracks.find(t => langCodeOf(t) === 'en');
    if (hit)
        return hit;
    return tracks[0];
}
function srtTimestamp(ms) {
    const clamped = Math.max(0, Math.round(ms));
    const h = Math.floor(clamped / 3600000);
    const m = Math.floor((clamped % 3600000) / 60000);
    const s = Math.floor((clamped % 60000) / 1000);
    const msRem = clamped % 1000;
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(msRem, 3)}`;
}
// [DUPLICATE-EVENT-DEDUP] YouTube's own json3 payload can contain literal
// back-to-back duplicate events — same tStartMs, same dDurationMs, same
// spoken text — differing only in an invisible per-seg `pPenId` (a caption
// pen/style id). Observed on a real video (Qtl8lJwbd4g, manual 'en' track):
// EVERY event in the entire 20-minute track was doubled this way (1612 ->
// 806 after dedup, exactly halved, always adjacent pairs) — not a one-off
// glitch in one section. Undeduped, this doubles the word count for the
// whole video — each real spoken word gets two entries at nearly the same
// timestamp — which drags every later burned caption increasingly behind
// the actual audio, since burn logic advances one display slot per array
// entry regardless of how many entries share one moment of real speech.
// Called from BOTH json3ToSrt and json3ToWords (not just the Innertube fetch
// path) — the yt-dlp fallback in pipeline-inverse-v1.js's
// srtFromJson3Subtitle() parses the same json3 shape straight from a
// yt-dlp-downloaded subtitle file, completely bypassing
// fetchTranscriptViaInnertube, so a dedup applied only there would leave
// that path exposed to the identical bug on the identical data.
//
// [FLASH-REVEAL-DEDUP] Beyond the exact tStartMs+dDurationMs duplicate pairs
// above the video also emits a "flash" pattern on short exclamatory lines:
// the same text posted 2-3 times back to back, ~67ms apart, where every
// occurrence but the LAST has a throwaway ~67ms duration and only the final
// one carries the real display window. Measured throughout the same video:
// "Start the timer!" at 8033ms/67ms, 8100ms/67ms, then 8167ms/900ms — same
// shape 155 times across the full 20-minute track, not just at the start.
// Keeping an early occurrence would burn the word ~100ms too early AND at
// the wrong (too-short) duration; keeping the last is both temporally
// correct and matches the event that actually has a sane duration.
// Real repeated dialogue ("No! No!") spoken seconds apart must NOT collapse
// — only the sub-second flash-reveal artifact should. Every observed flash
// gap was 67-134ms; 1000ms leaves generous headroom for encoder jitter
// without reaching into territory where two separate spoken lines live.
const FLASH_REVEAL_MAX_GAP_MS = 1000;
function dedupeEvents(events) {
    const out = [];
    let runText = null;
    for (const ev of events) {
        if (!Array.isArray(ev.segs) || typeof ev.tStartMs !== 'number') {
            out.push(ev);
            runText = null;
            continue;
        }
        const text = ev.segs.map(s => s.utf8 || '').join('');
        const prev = out[out.length - 1];
        const gapMs = prev && typeof prev.tStartMs === 'number' ? ev.tStartMs - prev.tStartMs : Infinity;
        if (text === runText && gapMs <= FLASH_REVEAL_MAX_GAP_MS) {
            out[out.length - 1] = ev; // replace the previous run member with this later, more-authoritative one
        }
        else {
            out.push(ev);
            runText = text;
        }
    }
    return out;
}
// json3 events -> SRT text. Events without `segs` are gap/style markers,
// not captions, and are skipped. Consecutive whitespace-only segs collapse
// to nothing so blank cues never appear.
function json3ToSrt(json3) {
    const events = dedupeEvents(Array.isArray(json3?.events) ? json3.events : []);
    const blocks = [];
    let n = 0;
    for (const ev of events) {
        if (!Array.isArray(ev.segs) || typeof ev.tStartMs !== 'number')
            continue;
        // Same zero-width-character gap as json3ToWords below — .trim() alone
        // leaves a seg that is ONLY U+200B/200C/200D/FEFF non-empty, which would
        // otherwise pass this guard as a real (invisible) subtitle cue.
        const text = ev.segs.map(s => s.utf8 || '').join('').replace(/\n+/g, ' ').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
        if (!text)
            continue;
        const startMs = ev.tStartMs;
        const durMs = typeof ev.dDurationMs === 'number' ? ev.dDurationMs : 2000;
        n += 1;
        blocks.push(`${n}\n${srtTimestamp(startMs)} --> ${srtTimestamp(startMs + durMs)}\n${text}\n`);
    }
    return blocks.join('\n');
}
// [WORD-TIMING-INNERTUBE] json3 ASR events carry a REAL start time for every
// word: segs[].tOffsetMs, milliseconds from the event's tStartMs (the first
// seg of an event has no offset — it starts at tStartMs itself). json3ToSrt
// above cannot keep that (SRT has no word-level timing), and the event's
// dDurationMs is a DISPLAY duration — the line stays on screen while the next
// line shows below it, so cues overlap and end seconds after the words were
// actually spoken. Measured on a real 44-min source (Unoj73VqEao, id asr):
// re-interpolating word times from those display cues put 97% of caption
// chunks >0.5s late, mean +1.64s — while the per-word offsets in the SAME
// payload sit within ~0.1-0.3s of a local Whisper ground truth. This extracts
// them as a flat {text,start,end} list (absolute seconds), the exact shape the
// pipeline's ASR `words` path already consumes for tight caption sync.
//
// A word's end is not in the payload; the next word's start is used, capped
// at +1.2s so a word before a long silence doesn't hold the screen, with a
// small floor so zero-width words can't happen. Manual (human-authored)
// tracks have no tOffsetMs at all — for those this returns [] and the caller
// keeps the cue-level path, whose timing is already speech-accurate.
function json3ToWords(json3) {
    const events = dedupeEvents(Array.isArray(json3?.events) ? json3.events : []);
    const words = [];
    let sawOffset = false;
    for (const ev of events) {
        if (!Array.isArray(ev.segs) || typeof ev.tStartMs !== 'number')
            continue;
        if (ev.aAppend)
            continue; // "\n" display markers, not speech
        for (const s of ev.segs) {
            // [ZERO-WIDTH-SEG-FILTER] YouTube pads json3 segs with invisible
            // formatting characters (U+200B zero-width space, U+200C/200D
            // zero-width non-joiner/joiner, U+FEFF BOM) — often as whole standalone
            // segs, sometimes glued onto the front of a real word. JS's .trim()
            // does NOT strip these (they're Unicode "format" chars, not
            // "separator" whitespace), so an un-stripped seg like '​' passes
            // every downstream truthy/non-empty check as if it were a real spoken
            // word. Measured on a real video (Qtl8lJwbd4g): 5643 of 9292 word
            // entries (61%) were PURE zero-width junk, plus 806 more with a
            // zero-width glyph stuck to a real word. chunkWordsToCues groups a
            // fixed N words per caption line — with 61% of "words" being invisible
            // filler, each line covers far less real speech than intended, so
            // captions fall further behind the audio as the video goes on.
            const t = String(s.utf8 || '').replace(/\n+/g, ' ').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
            if (!t)
                continue;
            if (typeof s.tOffsetMs === 'number')
                sawOffset = true;
            const start = (ev.tStartMs + (typeof s.tOffsetMs === 'number' ? s.tOffsetMs : 0)) / 1000;
            // [SPEAKER-MARKER] ">>" (speaker change) is not a spoken word.
            for (const p of t.split(/\s+/).filter(Boolean)) {
                const w = p.replace(/^(?:>{2,}|&gt;&gt;)/, '');
                if (w)
                    words.push({ text: w, start, end: 0 });
            }
        }
    }
    if (!sawOffset)
        return [];
    for (let i = 0; i < words.length; i++) {
        const next = i + 1 < words.length ? words[i + 1].start : words[i].start + 0.8;
        words[i].end = Math.max(words[i].start + 0.08, Math.min(next, words[i].start + 1.2));
    }
    return words;
}
// Fetches one caption track's body as json3. `fmt=json3` asks YouTube for the
// structured JSON format instead of the default XML/TTML — far simpler to
// parse correctly, and the only format carrying per-word timing.
async function fetchTrackJson3(track, { onLog, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const url = new URL(track.baseUrl);
    url.searchParams.set('fmt', 'json3');
    const t0 = Date.now();
    const res = await fetchWithTimeout(url.toString(), { method: 'GET' }, timeoutMs);
    if (!res.ok)
        throw new Error(`Innertube: gagal ambil caption body (HTTP ${res.status})`);
    const json3 = await res.json();
    onLog?.(`innertube: caption body diunduh (${Date.now() - t0}ms)`);
    return json3;
}
// Public entry point. Returns { srt, words, lang, kind, trackCount } or
// throws. `words` is [] for tracks without per-word timing (manual subs).
async function fetchTranscriptViaInnertube(urlOrVideoId, { lang = 'auto', langHint, onLog, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const videoId = extractVideoId(urlOrVideoId);
    if (!videoId)
        throw new Error('Innertube: tidak bisa mengekstrak video ID');
    const captionsNode = await fetchPlayerResponse(videoId, { onLog, timeoutMs });
    const track = pickBestTrack(captionsNode.captionTracks, lang, langHint);
    if (!track)
        throw new Error('Innertube: tidak ada caption track yang cocok');
    const dubCount = captionsNode.captionTracks.filter(isAutoDubAsr).length;
    if (dubCount)
        onLog?.(`innertube: ${dubCount} track transkrip dubbing AI dikesampingkan${isAutoDubAsr(track) ? ' — tapi yang terpilih justru track dubbing' : ''}`);
    const json3 = await fetchTrackJson3(track, { onLog, timeoutMs });
    const srt = json3ToSrt(json3);
    if (!srt.trim())
        throw new Error('Innertube: caption track kosong setelah parsing');
    return {
        srt,
        words: json3ToWords(json3),
        lang: langCodeOf(track) || 'und',
        kind: track.kind === 'asr' ? 'asr' : 'manual',
        trackCount: captionsNode.captionTracks.length,
    };
}
module.exports = { fetchTranscriptViaInnertube, extractVideoId, pickBestTrack, json3ToSrt, json3ToWords, dedupeEvents };
