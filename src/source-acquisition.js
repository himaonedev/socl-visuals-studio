// Generated from backend/src/source-acquisition.ts by scripts/backend.cjs. Edit the TypeScript source.
const fs = require('node:fs');
const path = require('node:path');
const SOURCE_VIDEO_EXTENSIONS = Object.freeze(['mp4', 'mkv', 'webm', 'mov', 'm4v']);
const SOURCE_HEIGHT_CAPS = Object.freeze({ '720p': 720, '1080p': 1080, '2K': 1440, '4K': 2160 });
const YTDLP_STALL_MS = 90_000;
// yt-dlp is silent while ffmpeg merges the video+audio streams (see pipeline).
const YTDLP_MERGE_STALL_MS = 20 * 60_000;
// [FACE-SOURCE-CAP] Face 9:16 keeps only a 9:16 slice of a 16:9 frame — at a
// 1080p source that slice is 607 px wide, upscaled 1.78× to a 1080-wide
// output. Capping the source at the tier's own height was the "export 1080 /
// 2K tapi burik" report. Measured (VMAF vs a 2160p-derived reference, same
// scene, h264_videotoolbox at the tier bitrate):
//   1080p out: src 1080 → 80.3 · src 1440 → 87.1 · src 2160 → 93.7
//   2K out:    src 1440 → 84.2 · src 2160 → 94.6
// So face downloads one step up. 1080p stops at 1440, not 2160: 4K VP9 is ~3×
// the bytes and every stage decodes the source again (track, scene, render),
// which low-end Windows machines pay for. Blur/square/landscape scale the whole
// frame (or a full-height square) and never need more than the tier.
const FACE_SOURCE_HEIGHT_CAPS = Object.freeze({ '720p': 1080, '1080p': 1440, '2K': 2160, '4K': 2160 });
function sourceHeightCap(resolution, format) {
    const isFace = !format || format === 'face';
    const caps = isFace ? FACE_SOURCE_HEIGHT_CAPS : SOURCE_HEIGHT_CAPS;
    return caps[resolution] || caps['1080p'];
}
function ytdlpNetworkArgs() {
    return [
        '--socket-timeout', '15',
        '--retries', '3',
        '--fragment-retries', '5',
        '--retry-sleep', 'http:exp=1:8',
        '--http-chunk-size', '10M',
    ];
}
function youtubePrimaryExtractorArgs() {
    return ['--extractor-args', 'youtube:player-client=web_embedded'];
}
// [EMBED-UNAVAILABLE] No player-client override: yt-dlp picks its own client
// order. Used to retry a video the embedded client calls "Video unavailable" —
// owners can block playback outside YouTube (FIFA highlights, TV, some music),
// and that block is exactly what web_embedded asks for. Measured on such a
// video with the app's args: web_embedded → unavailable, this → 1080p,
// android_vr → HTTP 403.
function youtubeDefaultClientArgs() {
    return [];
}
// [AUDIO-TRACK-LANG] YouTube serves multi-audio tracks (auto-dubbing / localized tracks).
// When selecting bestaudio without `lang` in the sort spec, yt-dlp sorts purely by bitrate (`br`).
// Dubbed audio tracks (like Indonesian dub `251-5` at 141kbps) often have a higher bitrate than the
// original English track (`251-0` at 119kbps), causing yt-dlp to download the dubbed audio instead
// of the original audio. Adding `lang` (or `lang:<target>`) ensures original tracks (`pref: 10`)
// beat dubbed tracks (`pref: -1`), or matches the requested audio language when explicitly set.
function ytdlpFormatSort(subtitleLang = 'auto') {
    const norm = String(subtitleLang || 'auto').trim().toLowerCase();
    const langPref = (norm && norm !== 'auto') ? `lang:${norm},lang` : 'lang';
    return `${langPref},res,vcodec:vp9,br`;
}
// [LOCAL-AUDIO-TRACK-LANG] For imported / local video containers containing multiple audio tracks,
// select the best audio stream index. In auto mode, prioritize original audio tracks, non-dubbed
// tracks, and English/default tracks over auto-dubbed tracks (e.g. Indonesian dub).
// When an explicit language is requested (e.g. 'en', 'id', 'ja'), prioritize tracks matching that language.
function findBestAudioStream(streams, preferredLang = 'auto') {
    if (!Array.isArray(streams))
        return null;
    const audioStreams = streams.filter(s => s && s.codec_type === 'audio');
    if (!audioStreams.length)
        return null;
    if (audioStreams.length === 1)
        return audioStreams[0].index;
    const pref = String(preferredLang || 'auto').trim().toLowerCase();
    // 1. If explicit language requested (not 'auto'):
    if (pref && pref !== 'auto') {
        const byLang = audioStreams.find(s => {
            const lang = String(s.tags?.language || s.tags?.lang || '').toLowerCase();
            const title = String(s.tags?.title || s.tags?.handler_name || '').toLowerCase();
            return lang === pref || lang.startsWith(pref + '-') ||
                (pref === 'id' && (lang === 'ind' || title.includes('indo'))) ||
                (pref === 'en' && (lang === 'eng' || title.includes('eng')));
        });
        if (byLang)
            return byLang.index;
    }
    // 2. Auto mode:
    // a. Prefer stream with disposition.original === 1
    const orig = audioStreams.find(s => s.disposition?.original === 1);
    if (orig)
        return orig.index;
    // b. Filter out dubbing tracks if non-dub tracks exist
    const nonDub = audioStreams.filter(s => !s.disposition?.dub);
    const candidates = nonDub.length ? nonDub : audioStreams;
    // c. Prefer English or original language track if tagged
    const eng = candidates.find(s => {
        const lang = String(s.tags?.language || s.tags?.lang || '').toLowerCase();
        const title = String(s.tags?.title || s.tags?.handler_name || '').toLowerCase();
        return lang === 'eng' || lang === 'en' || title.includes('original') || title.includes('english');
    });
    if (eng)
        return eng.index;
    // d. Prefer default stream
    const def = candidates.find(s => s.disposition?.default === 1);
    if (def)
        return def.index;
    return candidates[0].index;
}
function isolatedYtdlpArgs(args = []) {
    return [
        '--ignore-config',
        ...args.filter((arg) => arg !== '--ignore-config' && arg !== '--no-config'),
    ];
}
function sourceInventory(sessionDir) {
    const names = fs.readdirSync(sessionDir)
        .filter((name) => name.toLowerCase().startsWith('source.'))
        .sort();
    return names.map((name) => {
        const entryPath = path.join(sessionDir, name);
        try {
            const stat = fs.statSync(entryPath);
            return { name, path: entryPath, size: stat.size, isFile: stat.isFile() };
        }
        catch (error) {
            return {
                name,
                path: entryPath,
                size: null,
                isFile: false,
                statError: error && error.code ? error.code : 'UNKNOWN',
            };
        }
    });
}
function isCompletedSourceVideo(entry) {
    if (!entry.isFile || entry.size <= 0 || /\.f[^.]+\./i.test(entry.name))
        return false;
    if (/\.temp\./i.test(entry.name))
        return false;
    if (/\.(part|ytdl|temp)$/i.test(entry.name))
        return false;
    const extension = path.extname(entry.name).slice(1).toLowerCase();
    return SOURCE_VIDEO_EXTENSIONS.includes(extension);
}
function resolveDownloadedVideo(sessionDir) {
    const inventory = sourceInventory(sessionDir);
    for (const extension of SOURCE_VIDEO_EXTENSIONS) {
        const preferred = inventory.find((entry) => entry.name.toLowerCase() === `source.${extension}`);
        if (preferred && isCompletedSourceVideo(preferred))
            return preferred.path;
    }
    const completed = inventory.find(isCompletedSourceVideo);
    return completed ? completed.path : null;
}
function probeHasVideoStream(raw) {
    let probe;
    try {
        probe = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }
    catch {
        return false;
    }
    return Boolean(probe
        && typeof probe === 'object'
        && Array.isArray(probe.streams)
        && probe.streams.some((stream) => stream && stream.codec_type === 'video'));
}
function formatBytes(size) {
    const bytes = Number.isFinite(size) && size >= 0 ? size : 0;
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function inventoryDescriptor(inventory) {
    if (!Array.isArray(inventory) || inventory.length === 0)
        return 'tidak ada berkas source.*';
    return inventory.map((entry) => {
        if (entry.statError)
            return `${entry.name} (stat gagal: ${entry.statError})`;
        return `${entry.name} (${formatBytes(entry.size)})`;
    }).join(', ');
}
function acquisitionFailureMessage(inventory, reason) {
    const detail = reason ? ` ${reason}.` : '';
    return [
        `yt-dlp selesai tanpa error, tetapi video selesai tidak ditemukan.${detail}`,
        `Berkas source yang terdeteksi: ${inventoryDescriptor(inventory)}.`,
        'Konfigurasi yt-dlp eksternal sudah diabaikan oleh aplikasi.',
        'Coba ulang unduhan, perbarui yt-dlp atau aplikasi, atau impor file lokal.',
    ].join(' ');
}
// [GGC-400] YouTube streams are often served from a Google cache node inside the
// user's ISP (host rr<N>---sn-<isp-node>.googlevideo.com). Measured 2026-10-19 on
// an Indonesian ISP: that node answered HTTP 400 for EVERY format of one video
// (all player clients, stable and nightly yt-dlp) while other videos and the
// same video's backup node — the second entry of the URL's own `mn` list —
// answered 206. yt-dlp never tries the backup node, so the download failed.
function looksLikeVideoData400(raw) {
    return /unable to download video data: HTTP Error 400/i.test(String(raw || ''));
}
// Points every googlevideo URL in a yt-dlp info JSON at the backup node from its
// `mn` list. Returns how many URLs changed (0 → nothing to retry with).
function rewriteToBackupNode(info) {
    let changed = 0;
    const fix = (u) => {
        try {
            const x = new URL(u);
            const m = /^rr(\d+)---(sn-[a-z0-9-]+)\.googlevideo\.com$/i.exec(x.hostname);
            const mn = String(x.searchParams.get('mn') || '').split(',').filter(Boolean);
            if (!m || mn.length < 2 || mn[0] !== m[2])
                return u;
            x.hostname = `rr${m[1]}---${mn[1]}.googlevideo.com`;
            changed++;
            return x.toString();
        }
        catch {
            return u;
        }
    };
    for (const list of [info && info.formats, info && info.requested_formats]) {
        for (const f of Array.isArray(list) ? list : []) {
            if (f && typeof f.url === 'string')
                f.url = fix(f.url);
        }
    }
    if (info && typeof info.url === 'string')
        info.url = fix(info.url);
    // HLS/DASH-manifest formats (e.g. 614, vp9 1080p m3u8) cannot be redirected:
    // their fragment URLs come from the manifest and name the cache node again.
    // Drop them once direct streams were moved, so the selector picks those.
    if (changed > 0 && Array.isArray(info.formats)) {
        const direct = (f) => f && typeof f.url === 'string' && /^https?$/.test(String(f.protocol || 'https'));
        if (info.formats.some((f) => direct(f) && f.vcodec && f.vcodec !== 'none')) {
            info.formats = info.formats.filter((f) => direct(f) || !/googlevideo\.com/.test(String(f && (f.manifest_url || f.url) || '')));
        }
    }
    return changed;
}
// Shown when the backup node did not help either: the remedy is another network,
// not cookies or a newer yt-dlp (what the generic 403/gate messages suggest).
function cacheNodeRejectedMessage(site = 'YouTube') {
    return `Server cache ${site} di jaringan internetmu menolak video ini (HTTP 400), dan jalur cadangan langsung ke server Google juga tidak berhasil. Ini bukan kerusakan aplikasi dan bukan masalah cookies.\n\nCoba:\n1. Jalankan ulang beberapa menit lagi.\n2. Pakai jaringan lain (mis. hotspot HP) atau nyalakan VPN — server cache itu milik penyedia internet yang sedang kamu pakai.\n3. Atau download videonya manual lalu pakai menu Import file lokal.`;
}
module.exports = {
    looksLikeVideoData400,
    rewriteToBackupNode,
    cacheNodeRejectedMessage,
    SOURCE_VIDEO_EXTENSIONS,
    YTDLP_STALL_MS,
    YTDLP_MERGE_STALL_MS,
    sourceHeightCap,
    ytdlpNetworkArgs,
    youtubePrimaryExtractorArgs,
    youtubeDefaultClientArgs,
    ytdlpFormatSort,
    findBestAudioStream,
    isolatedYtdlpArgs,
    sourceInventory,
    resolveDownloadedVideo,
    probeHasVideoStream,
    acquisitionFailureMessage,
};
