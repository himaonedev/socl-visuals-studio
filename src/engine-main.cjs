// Generated from backend/src/engine-main.ts by scripts/backend.cjs. Edit the TypeScript source.
// Transitional Node engine. Desktop lifecycle and license gates removed.
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, session, screen, net } = require("../engine/platform.cjs"), path = require("path"), fs = require('fs'), os = require('os'), { removeLegacyHookModel } = require("./legacy-hook-model-cleanup");
let startupPhase = 'boot';
const setPhase = _0x2f428f => { startupPhase = _0x2f428f; };
function crashLogCandidates() {
    const _0x3cfc74 = { 'ypWuJ': "userData", 'nbfUR': "startup-crash.log" }, _0x1b6737 = [];
    try {
        _0x1b6737.push(path.join(app.getPath(_0x3cfc74.ypWuJ), _0x3cfc74.nbfUR));
    }
    catch { }
    try {
        _0x1b6737.push(path.join(os.tmpdir(), "socl-visuals-startup-crash.log"));
    }
    catch { }
    return _0x1b6737;
}
const CRASH_LOG_MAX = 0x100 * 0x400;
function rotateIfBig(_0xa66507) {
    const _0x5ace86 = { 'kVgBb': function (_0x3a0caa, _0x126e16) { return _0x3a0caa > _0x126e16; } };
    try {
        if (_0x5ace86.kVgBb(fs.statSync(_0xa66507).size, CRASH_LOG_MAX))
            fs.renameSync(_0xa66507, _0xa66507 + '.1');
    }
    catch { }
}
function redact(_0x414b1d) {
    const _0x16db2f = { 'CSECN': function (_0x58c3ac, _0x282aa6) { return _0x58c3ac(_0x282aa6); }, 'FfnzH': function (_0x4b7b98, _0x38f7ed) { return _0x4b7b98 == _0x38f7ed; }, 'ouwen': function (_0x501216, _0x4193a8) { return _0x501216 > _0x4193a8; }, 'djvEf': function (_0x4d1185, _0x3188ce) { return _0x4d1185 + _0x3188ce; }, 'GzRcl': " \u2026(dipotong)", 'tkvdP': "[^\\s\"',;}\\]]+", 'gNASs': "Bearer [disamarkan]", 'idVVw': function (_0x2c03d9, _0xcdefea) { return _0x2c03d9 + _0xcdefea; }, 'lPDHi': "$1: [disamarkan]", 'iZGCF': "$1_[disamarkan]", 'AFZgQ': "[disamarkan]" };
    let _0xeb2294 = _0x16db2f.CSECN(String, _0x16db2f.FfnzH(_0x414b1d, null) ? '' : _0x414b1d);
    if (_0x16db2f.ouwen(_0xeb2294.length, 0x4b0))
        _0xeb2294 = _0x16db2f.djvEf(_0xeb2294.slice(0x0, 0x4b0), _0x16db2f.GzRcl);
    const _0x3d4cf0 = _0x16db2f.tkvdP;
    return _0xeb2294.replace(new RegExp("\\bBearer\\s+" + _0x3d4cf0, 'gi'), _0x16db2f.gNASs).replace(new RegExp(_0x16db2f.idVVw("\\b(authorization|api[-_ ]?key|apikey|token|secret)\\b\\s*[:=]\\s*(?:Bearer\\s+)?", _0x3d4cf0), 'gi'), _0x16db2f.lPDHi).replace(/\b(sk|gsk|rk|pk)[-_][A-Za-z0-9_-]{8,}/gi, _0x16db2f.iZGCF).replace(/\bAIza[A-Za-z0-9_-]{10,}/g, "AIza[disamarkan]").replace(/\b[A-Za-z0-9_-]{32,}\b/g, _0x16db2f.AFZgQ);
}
function writeCrashLog(_0x3a194c, _0xe3707b, _0x33cde0) {
    const _0x5f1321 = { 'VzcNc': "userData", 'MyPyL': function (_0x11179e, _0x2fd0f1) { return _0x11179e || _0x2fd0f1; }, 'uRBcR': function (_0x136651, _0x292e0a) { return _0x136651(_0x292e0a); }, 'AJupd': function (_0x26f652, _0x492684) { return _0x26f652(_0x492684); }, 'XcDLg': function (_0x44f196, _0x435085) { return _0x44f196(_0x435085); }, 'iMCpJ': "(tidak ada stack)", 'YBBHC': function (_0x4c8df9) { return _0x4c8df9(); } }, _0x1f4447 = !(_0x33cde0 && _0x33cde0.noStack);
    let _0x1dd453;
    try {
        const _0x35cace = _0x5f1321.MyPyL(_0xe3707b, {});
        _0x1dd453 = ['='.repeat(0x46), "waktu        : " + new Date().toISOString(), "jenis        : " + _0x3a194c, "fase startup : " + startupPhase, "versi        : " + ((() => {
                ;
                try {
                    return app.getVersion();
                }
                catch {
                    return '?';
                }
            })()), "platform     : " + process.platform + '\x20' + process.arch + (" | electron ") + process.versions.electron, "exe          : " + process.execPath, "dir kode     : " + __dirname, "userData     : " + ((() => {
                ;
                try {
                    return app.getPath(_0x5f1321.VzcNc);
                }
                catch {
                    return '?';
                }
            })()), "pesan        : " + redact(_0x35cace && (_0x35cace.message || _0x35cace.toString && _0x35cace.toString()) || _0x5f1321.uRBcR(String, _0xe3707b)), "kode         : " + (_0x35cace.code || '-') + ("   syscall: ") + (_0x35cace.syscall || '-') + ("   path: ") + _0x5f1321.AJupd(redact, _0x35cace.path || '-'), ..._0x1f4447 ? ["stack        :", _0x5f1321.XcDLg(redact, _0x35cace && _0x35cace.stack || _0x5f1321.iMCpJ)] : [], ''].join('\x0a');
    }
    catch {
        return null;
    }
    for (const _0x3afa92 of _0x5f1321.YBBHC(crashLogCandidates)) {
        try {
            return fs.mkdirSync(path.dirname(_0x3afa92), { 'recursive': !![] }), rotateIfBig(_0x3afa92), fs.appendFileSync(_0x3afa92, _0x1dd453, "utf8"), _0x3afa92;
        }
        catch { }
    }
    return null;
}
function showFatalBox(_0x9aa8d0, _0x16aef3) {
    const _0x263871 = { 'xavXz': "Kesalahan tidak diketahui", 'tnEZL': function (_0x569679, _0x4b6f33) { return _0x569679 + _0x4b6f33; } };
    if (process.env.GITHUB_ACTIONS || process.env.SOCL_NO_ERROR_DIALOG)
        return;
    try {
        const _0x47a44b = _0x9aa8d0 && (_0x9aa8d0.message || String(_0x9aa8d0)) || _0x263871.xavXz;
        dialog.showErrorBox("SOCL Visuals Studio gagal dibuka", _0x263871.tnEZL("Aplikasi berhenti saat memulai (fase: " + startupPhase + ').\x0a\x0a' + _0x47a44b + '\x0a\x0a', _0x16aef3 ? "Detailnya ditulis di:\n" + _0x16aef3 + ("\n\nKirimkan file itu ke support supaya bisa ditelusuri.") : "Log detail tidak bisa ditulis."));
    }
    catch { }
}
const workRoot = require("./work-root"), SF = require("./session-files"), { runPipeline, cancelPipeline, flushRunLog, renderClipEdit, applyClipCrop, fixCaptionTypos, regenerateClipMeta, exportToUserFolder, deliveredClipFor, trackerAvailable, killTree, testProviderConnection, renderPlanFor, detectHwEncoder } = require("./pipeline-inverse-v1"), { persistClipPatch } = require("./clip-report"), { bootstrap, BIN_DIR, binPath, canExec, refreshYtdlp, refreshDeno, refreshFfmpeg } = require("./bootstrap"), secrets = require("./secrets"), { inspectCookiesFile } = require("./cookies-file"), { audit } = require("./audit"), { isPrerelease, compareVersions, pickLatestTag } = require("./update-check");
const IS_PROD = app.isPackaged;
const APP_NAME = "SOCL Visuals Studio", OUTPUT_ROOT = path.join(os.homedir(), 'Movies', APP_NAME), CFG_PATH = path.join(app.getPath('userData'), "settings.json");
const DEFAULTS = { 'apiKey': '', 'baseUrl': '', 'model': '', 'freeModel': '', 'aiProvider': '', 'geminiKey': '', 'geminiModel': "gemini-flash-latest", 'groqKey': '', 'groqModel': "openai/gpt-oss-120b", 'openaiKey': '', 'openaiModel': "gpt-4o-mini", 'anthropicKey': '', 'anthropicModel': "claude-haiku-4-5", 'openrouterKey': '', 'openrouterModel': "openrouter/free", 'openrouterFallbacks': '', 'sumopodKey': '', 'sumopodModel': "deepseek-v4-pro", 'localAsr': "ask", 'whisperModelSize': "small", 'cookiesPath': '', 'cookiesBrowser': '', 'exportPath': '', 'workRoots': [], 'clipCount': 0x5, 'clipDuration': "auto", 'deadAirCut': !![], 'clipMode': 'auto', 'manualSegments': [], 'format': 'face', 'resolution': "1080p", 'burnSubtitles': !![], 'smartTrack': ![], 'hookProvider': "groq", 'subtitleStyle': "neon_green", 'subtitleFont': '', 'subtitleOffsetMs': 0x0, 'subtitleGlow': !![], 'subtitleBoxColor': '', 'hookAutoBurn': ![], 'hookPreset': "blok_neon", 'hookCase': '', 'captionKinetic': '', 'captionAlign': "center", 'captionDim': 0x0, 'collageBroll': ![], 'hookTeaser': ![], 'collageStyle': "auto", 'brollSec': 'auto', 'hookTeaserSec': "auto", 'cloudAsr': !![], 'videoFx': '', 'subtitleFontSize': 0x40, 'subtitleY': 0x21c, 'subtitleX': 0x21c, 'subtitleAnim': "pop", 'emojiStickers': ![], 'subtitleLang': "auto" }, RETIRED_GEMINI_MODELS = new Set(["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-1.5-flash", "gemini-1.5-pro"]), RETIRED_GROQ_MODELS = new Set(["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "moonshotai/kimi-k2-instruct"]), RETIRED_OPENROUTER_MODELS = new Set(["meta-llama/llama-3.3-70b-instruct:free"]), RETIRED_KEYLESS_BASEURL = /^https?:\/\/api\.opencode\.ai(?:\/|$)/i, RETIRED_KEYLESS_MODELS = new Set(["nemotron-3-ultra-free"]);
function readCfg() {
    const _0x2f0e8b = { 'dYvnM': 'utf8', 'yzfuV': function (_0x2758e2, _0x6c1ab9) { return _0x2758e2(_0x6c1ab9); }, 'HTWGZ': function (_0x2b2745, _0x3de4b9) { return _0x2b2745 === _0x3de4b9; }, 'fSkhW': "riot_potong" };
    let _0x40472b;
    try {
        _0x40472b = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CFG_PATH, _0x2f0e8b.dYvnM)) };
    }
    catch {
        _0x40472b = { ...DEFAULTS };
    }
    if (RETIRED_GEMINI_MODELS.has(_0x40472b.geminiModel))
        _0x40472b.geminiModel = DEFAULTS.geminiModel;
    if (RETIRED_GROQ_MODELS.has(_0x40472b.groqModel))
        _0x40472b.groqModel = DEFAULTS.groqModel;
    if (RETIRED_OPENROUTER_MODELS.has(_0x40472b.openrouterModel))
        _0x40472b.openrouterModel = DEFAULTS.openrouterModel;
    if (RETIRED_KEYLESS_BASEURL.test(_0x2f0e8b.yzfuV(String, _0x40472b.baseUrl || '')))
        _0x40472b.baseUrl = DEFAULTS.baseUrl;
    if (RETIRED_KEYLESS_MODELS.has(_0x40472b.model))
        _0x40472b.model = DEFAULTS.model;
    if (RETIRED_KEYLESS_MODELS.has(_0x40472b.freeModel))
        _0x40472b.freeModel = DEFAULTS.freeModel;
    if (_0x40472b.hookProvider === 'local')
        _0x40472b.hookProvider = DEFAULTS.hookProvider;
    if (_0x2f0e8b.HTWGZ(_0x40472b.hookPreset, _0x2f0e8b.fSkhW)) {
        _0x40472b.hookPreset = "riot";
        if (!_0x40472b.videoFx)
            _0x40472b.videoFx = "cut_pink";
    }
    _0x40472b.emojiStickers = ![];
    /turbo|large|medium/i.test(String(_0x40472b.whisperModelSize || '')) && (_0x40472b.whisperModelSize = DEFAULTS.whisperModelSize);
    if (secrets.available())
        for (const _0x3334d9 of secrets.SECRET_FIELDS) {
            const _0x28b6e7 = secrets.get(_0x3334d9);
            if (_0x28b6e7)
                _0x40472b[_0x3334d9] = _0x28b6e7;
        }
    return _0x40472b;
}
function writeCfg(_0x308083) {
    if (process.env.SOCL_NATIVE_SETTINGS === '1')
        return require('../engine/platform.cjs').persistSettings(_0x308083);
    const _0x3cb1ad = { ..._0x308083 };
    if (secrets.available())
        for (const _0x7fe41b of secrets.SECRET_FIELDS) {
            _0x7fe41b in _0x3cb1ad && (secrets.set(_0x7fe41b, _0x3cb1ad[_0x7fe41b]), _0x3cb1ad[_0x7fe41b] = '');
        }
    const _0x5452d8 = { ...readCfg(), ..._0x3cb1ad };
    if (secrets.available()) {
        for (const _0x3eddac of secrets.SECRET_FIELDS)
            _0x5452d8[_0x3eddac] = '';
    }
    return fs.mkdirSync(path.dirname(CFG_PATH), { 'recursive': !![] }), fs.writeFileSync(CFG_PATH, JSON.stringify(_0x5452d8, null, 0x2)), readCfg();
}
let binPaths = { 'ytdlp': null, 'ffmpeg': null, 'ffprobe': null }, pipelineRunActive = ![], pipelineCancelRequested = ![];
function requestPipelineCancel() { const _0x5a3378 = { 'ncMqT': function (_0x579559) { return _0x579559(); } }; return pipelineCancelRequested = !![], _0x5a3378.ncMqT(cancelPipeline); }
ipcMain.handle("fonts:metrics", (_0x2757af, _0x569322) => {
    const _0x4e7f00 = { 'NwuSZ': function (_0xf7b66e, _0x59cbc5) { return _0xf7b66e(_0x59cbc5); }, 'eRTHc': "./font-metrics.js", 'BLAaD': "./pipeline-inverse-v1.js", 'ZDVoM': "assets", 'Goiac': function (_0x2bd167, _0x2c7676) { return _0x2bd167 !== _0x2c7676; }, 'hqcDU': function (_0x4085e7, _0x370554) { return _0x4085e7 != _0x370554; }, 'jpQig': function (_0x2ef373, _0x587c03) { return _0x2ef373 > _0x587c03; } }, _0x254648 = {};
    try {
        const _0x565f45 = _0x4e7f00.NwuSZ(require, _0x4e7f00.eRTHc), { __test: _0x552dd7 } = require(_0x4e7f00.BLAaD), _0x29321c = _0x552dd7 && _0x552dd7.SUB_STYLES || {}, _0x21571d = path.join(__dirname, '..', _0x4e7f00.ZDVoM, "fonts");
        for (const _0x207c47 of Array.isArray(_0x569322) ? _0x569322 : []) {
            const _0x1f4988 = String(_0x207c47 && _0x207c47.style || ''), _0x20b060 = String(_0x207c47 && _0x207c47.fn || ''), _0x35f934 = _0x1f4988 + '|' + _0x20b060;
            if (_0x4e7f00.Goiac(_0x254648[_0x35f934], undefined))
                continue;
            const _0x5e141e = _0x29321c[_0x1f4988] || {}, _0x109c27 = _0x20b060 || _0x5e141e.font || "Open Sauce Two ExtraBold", _0x3639bd = !!_0x5e141e.bold, _0x2683ac = _0x565f45.fontInkExtentEm(_0x109c27, _0x21571d, _0x3639bd, ![]) || _0x565f45.fontInkExtentEm(_0x109c27, _0x21571d, ![], ![]), _0x15d2a3 = _0x565f45.fontEmScale(_0x109c27, _0x21571d, _0x3639bd, ![]);
            _0x254648[_0x35f934] = _0x2683ac && _0x4e7f00.hqcDU(_0x2683ac.baselineEm, null) && Number.isFinite(_0x15d2a3) && _0x4e7f00.jpQig(_0x15d2a3, 0x0) ? { 'face': _0x109c27, 'emScale': _0x15d2a3, 'baselineEm': _0x2683ac.baselineEm, 'capEm': _0x2683ac.ascEm, 'descEm': _0x2683ac.descEm, 'inkCenterEm': _0x565f45.fontInkCenterEm(_0x109c27, _0x21571d, _0x3639bd, ![]) } : null;
        }
    }
    catch { }
    return _0x254648;
});
// Handled by Rust legacy_settings.
ipcMain.handle("catalog:get", () => require("./catalog-loader").current());
// Handled by Rust legacy_settings.
ipcMain.handle("ai:test-provider", async (_0x1c8881, _0x5a23b1 = {}) => {
    const _0x58d7db = { 'NHidi': function (_0x1c7249, _0x1137ff) { return _0x1c7249(_0x1137ff); }, 'Wobnz': "groqModel", 'qwfog': "anthropicModel", 'HcQHP': "sumopodModel", 'xcXgW': function (_0x21c58c) { return _0x21c58c(); }, 'rFYAa': function (_0x5b80ba, _0x29aa91) { return _0x5b80ba(_0x29aa91); } }, _0x145ec8 = _0x58d7db.NHidi(String, _0x5a23b1.provider || '').toLowerCase(), _0x4392e8 = { 'gemini': "geminiModel", 'groq': _0x58d7db.Wobnz, 'openai': "openaiModel", 'anthropic': _0x58d7db.qwfog, 'openrouter': "openrouterModel", 'sumopod': _0x58d7db.HcQHP }, _0xa7a567 = _0x58d7db.xcXgW(readCfg), _0xc3ede1 = _0x4392e8[_0x145ec8];
    if (_0xc3ede1 && String(_0x5a23b1.model || '').trim())
        _0xa7a567[_0xc3ede1] = _0x58d7db.rFYAa(String, _0x5a23b1.model).trim();
    return testProviderConnection(_0xa7a567, _0x145ec8, _0x58d7db.NHidi(String, _0x5a23b1.key || ''));
});
// Handled by Rust legacy_settings.
// Handled by Rust legacy_settings.
ipcMain.handle("get-bin-paths", () => binPaths);
// File/folder pickers are implemented in Rust: src-tauri/src/legacy_native.rs.
ipcMain.handle("set-cookies", async (_0x246f0d, _0x1f849d = {}) => {
    const _0x51e61b = { 'MTKFn': "userData", 'nCHLP': "cookies.txt", 'LWnkx': 'openFile', 'VPloH': "Cookies", 'zRZzV': "txt", 'gpMny': "File not found", 'loXyg': function (_0x51a71a, _0xfb4f34) { return _0x51a71a(_0xfb4f34); }, 'HrpSE': function (_0x52846f, _0x2aa604) { return _0x52846f(_0x2aa604); } }, _0x4aaedf = path.join(app.getPath(_0x51e61b.MTKFn), _0x51e61b.nCHLP);
    if (_0x1f849d.clear) {
        try {
            fs.unlinkSync(_0x4aaedf);
        }
        catch { }
        return await writeCfg({ 'cookiesPath': '' }), { 'ok': !![], 'path': '' };
    }
    let _0x4f3169 = _0x1f849d.filePath;
    if (!_0x4f3169) {
        const _0x2a88f0 = await dialog.showOpenDialog({ 'properties': [_0x51e61b.LWnkx], 'filters': [{ 'name': _0x51e61b.VPloH, 'extensions': [_0x51e61b.zRZzV] }] });
        if (_0x2a88f0.canceled)
            return { 'ok': ![] };
        _0x4f3169 = _0x2a88f0.filePaths[0x0];
    }
    if (!_0x4f3169 || !fs.existsSync(_0x4f3169))
        return { 'ok': ![], 'error': _0x51e61b.gpMny };
    let _0x129b4b;
    try {
        _0x129b4b = fs.readFileSync(_0x4f3169);
    }
    catch (_0x525a01) {
        return { 'ok': ![], 'error': "Gagal membaca file: " + (_0x525a01.message || _0x525a01) };
    }
    const _0x2404b7 = _0x51e61b.loXyg(inspectCookiesFile, _0x129b4b);
    if (!_0x2404b7.ok)
        return { 'ok': ![], 'error': _0x2404b7.message, 'code': _0x2404b7.code, 'name': path.basename(_0x4f3169) };
    try {
        fs.writeFileSync(_0x4aaedf, _0x2404b7.content);
    }
    catch (_0x5959af) {
        return { 'ok': ![], 'error': "Gagal menyimpan file: " + (_0x5959af.message || _0x5959af) };
    }
    return await _0x51e61b.HrpSE(writeCfg, { 'cookiesPath': _0x4aaedf }), { 'ok': !![], 'path': _0x4aaedf, 'name': path.basename(_0x4f3169), 'cookieRows': _0x2404b7.cookieRows, 'skippedRows': _0x2404b7.skippedRows, 'fixed': _0x2404b7.fixed };
});
ipcMain.handle("app-info", async () => {
    const _0xbe5aba = { 'eytYp': function (_0x29df45, _0x45fa3b) { return _0x29df45 > _0x45fa3b; }, 'iYoMU': function (_0x227065, _0x3b11c7, _0x5b22e7) { return _0x227065(_0x3b11c7, _0x5b22e7); }, 'cBYGB': function (_0x569daa, _0x1f993e) { return _0x569daa + _0x1f993e; }, 'jVZox': function (_0x3ac545) { return _0x3ac545(); } };
    let _0x53bdbe = 0x0;
    const _0x557969 = async (_0x1bde3a, _0x5be3aa = 0x0) => {
        ;
        if (_0xbe5aba.eytYp(_0x5be3aa, 0x6))
            return;
        let _0x2d2f62;
        try {
            _0x2d2f62 = await fs.promises.readdir(_0x1bde3a, { 'withFileTypes': !![] });
        }
        catch {
            return;
        }
        for (const _0xf9f4d2 of _0x2d2f62) {
            const _0x5f3023 = path.join(_0x1bde3a, _0xf9f4d2.name);
            if (_0xf9f4d2.isDirectory())
                await _0xbe5aba.iYoMU(_0x557969, _0x5f3023, _0xbe5aba.cBYGB(_0x5be3aa, 0x1));
            else {
                if (_0xf9f4d2.isFile())
                    try {
                        _0x53bdbe += (await fs.promises.stat(_0x5f3023)).size;
                    }
                    catch { }
            }
        }
    };
    for (const _0x3eb2fe of await workRoot.sessionRoots(OUTPUT_ROOT, _0xbe5aba.jVZox(readCfg).workRoots)) {
        try {
            await _0x557969(_0x3eb2fe);
        }
        catch { }
    }
    let _0x3da1e8 = "Tidak diketahui", _0x12cbd0 = 0x0;
    try {
        const _0x1f981a = os.cpus();
        _0x12cbd0 = _0x1f981a.length;
        if (_0x1f981a[0x0].model)
            _0x3da1e8 = _0x1f981a[0x0].model.trim();
    }
    catch { }
    return { 'version': app.getVersion(), 'runtime': 'Tauri 2', 'node': process.versions.node, 'outputRoot': OUTPUT_ROOT, 'cfgPath': CFG_PATH, 'diskBytes': _0x53bdbe, 'bin': binPaths, 'device': { 'platform': process.platform, 'arch': process.arch, 'osRelease': os.release(), 'cpuModel': _0x3da1e8, 'cpuCores': _0x12cbd0, 'totalRamBytes': os.totalmem() } };
});
const ENGINE_META = [{ 'id': "ytdlp", 'bin': 'yt-dlp', 'name': "yt-dlp", 'args': ["--version"], 'repo': "yt-dlp/yt-dlp", 'why': "Pengunduh video. Kalau basi \u2192 download YouTube 403 / gagal." }, { 'id': "deno", 'bin': "deno", 'name': 'Deno', 'args': ["--version"], 'repo': "denoland/deno", 'why': "Memecahkan kode JS YouTube \u2014 tanpa ini stream cuma 360p buram." }, { 'id': 'ffmpeg', 'bin': 'ffmpeg', 'name': "FFmpeg", 'args': ["-version"], 'repo': null, 'why': "Memotong & me-render klip. Jarang perlu update." }], _probesInFlight = new Set();
async function waitForProbes() { await Promise.allSettled([..._probesInFlight]); }
function probeEngineVersion(_0x2b2fc7, _0x112801) { const _0x1a264b = { 'rGRqy': function (_0x5a3611, _0x120d79, _0x3dfcf5) { return _0x5a3611(_0x120d79, _0x3dfcf5); } }, _0x3f6381 = _0x1a264b.rGRqy(probeEngineVersionRaw, _0x2b2fc7, _0x112801); return _probesInFlight.add(_0x3f6381), _0x3f6381.finally(() => _probesInFlight.delete(_0x3f6381)), _0x3f6381; }
function probeEngineVersionRaw(_0x5c41bc, _0x3aba27) {
    const _0x33cf1e = { 'jSdDp': function (_0x19453e, _0x5097d1) { return _0x19453e(_0x5097d1); }, 'ollqz': function (_0x4a1a31, _0x4f398d) { return _0x4a1a31(_0x4f398d); }, 'xvObu': function (_0x49a4e2, _0x42d8c6) { return _0x49a4e2(_0x42d8c6); }, 'CvEqO': "child_process" };
    return new Promise(_0x4bf549 => {
        const _0x2b0933 = { 'zrAiH': function (_0x2ee2e9, _0xbc077a) { ; return _0x33cf1e.jSdDp(_0x2ee2e9, _0xbc077a); }, 'EcMtj': function (_0x191eae, _0x283cd7) { ; return _0x33cf1e.ollqz(_0x191eae, _0x283cd7); } }, _0x38b34e = resolvedEnginePath(_0x5c41bc);
        if (!_0x33cf1e.jSdDp(canExec, _0x38b34e))
            return _0x33cf1e.xvObu(_0x4bf549, null);
        const { execFile: _0x4911ef } = require(_0x33cf1e.CvEqO);
        _0x4911ef(_0x38b34e, _0x3aba27, { 'timeout': 0x4e20 }, (_0xd66d0b, _0x420dbb) => {
            ;
            if (_0xd66d0b)
                return _0x4bf549(null);
            const _0x451cc3 = _0x2b0933.zrAiH(String, _0x420dbb || ''), _0x294ebb = _0x451cc3.match(/ffmpeg version (\S+)/i) || _0x451cc3.match(/deno (\d[\w.-]*)/i) || _0x451cc3.trim().match(/^(\d[\w.\-]*)/);
            _0x2b0933.EcMtj(_0x4bf549, _0x294ebb ? _0x294ebb[0x1] : _0x451cc3.trim().split('\x0a')[0x0].slice(0x0, 0x18) || null);
        });
    });
}
const LATEST_FALLBACK = { 'yt-dlp/yt-dlp': "https://assets.socialvisuals.xyz/mirror/yt-dlp/latest.txt", 'denoland/deno': "https://dl.deno.land/release-latest.txt" };
async function fallbackLatestTag(_0x42a6c2, _0x584e7c) {
    const _0x41f394 = { 'gLQPx': "SOCL-Visuals", 'taJpR': function (_0x5f0e68, _0x4264c2) { return _0x5f0e68(_0x4264c2); } }, _0x29bc25 = LATEST_FALLBACK[_0x42a6c2];
    if (!_0x29bc25)
        return null;
    const _0x243014 = new AbortController(), _0x5b6533 = setTimeout(() => _0x243014.abort(), _0x584e7c);
    try {
        const _0x3b806b = await fetch(_0x29bc25, { 'headers': { 'User-Agent': _0x41f394.gLQPx }, 'signal': _0x243014.signal });
        if (!_0x3b806b.ok)
            return null;
        const _0x310544 = (await _0x3b806b.text()).trim().replace(/^v/, '');
        return /^\d+(\.\d+)+$/.test(_0x310544) ? _0x310544 : null;
    }
    catch {
        return null;
    }
    finally {
        _0x41f394.taJpR(clearTimeout, _0x5b6533);
    }
}
async function githubLatestTag(_0x1a1375, _0x3e5401 = 0x1b58) { return await githubLatestTagOnly(_0x1a1375, _0x3e5401) || fallbackLatestTag(_0x1a1375, _0x3e5401); }
async function githubLatestTagOnly(_0x39d401, _0xa45e49 = 0x1b58) {
    const _0x1f0906 = { 'ZDTGr': function (_0x3feba6, _0x437bb9, _0x5df7a2) { return _0x3feba6(_0x437bb9, _0x5df7a2); }, 'qtdEN': "SOCL-Visuals", 'ecJCj': "application/vnd.github+json", 'JsLRs': function (_0x40ea26, _0x44731c) { return _0x40ea26(_0x44731c); }, 'bwpRu': function (_0xce8b7b, _0x3297b5) { return _0xce8b7b(_0x3297b5); } };
    if (!_0x39d401)
        return null;
    const _0x58ee0a = new AbortController(), _0x353d7a = setTimeout(() => _0x58ee0a.abort(), _0xa45e49);
    try {
        const _0x415acd = await _0x1f0906.ZDTGr(fetch, "https://api.github.com/repos/" + _0x39d401 + ("/releases/latest"), { 'headers': { 'User-Agent': _0x1f0906.qtdEN, 'Accept': _0x1f0906.ecJCj }, 'signal': _0x58ee0a.signal });
        if (!_0x415acd.ok)
            return null;
        const _0x46420a = await _0x415acd.json();
        return _0x1f0906.JsLRs(String, _0x46420a.tag_name || '').replace(/^v/, '') || null;
    }
    catch {
        return null;
    }
    finally {
        _0x1f0906.bwpRu(clearTimeout, _0x353d7a);
    }
}
function updateAvailable(_0x1d887c, _0x1b94c8) {
    const _0x156980 = { 'ggvmE': function (_0x44a366, _0x23f71a) { return _0x44a366 !== _0x23f71a; } };
    if (!_0x1d887c || !_0x1b94c8)
        return ![];
    return _0x156980.ggvmE(_0x1d887c, _0x1b94c8);
}
ipcMain.handle("engines:status", async () => {
    const _0x1d0ece = { 'tWBbp': function (_0x4ffa86, _0x15be29, _0x2db01a) { return _0x4ffa86(_0x15be29, _0x2db01a); }, 'aICIP': function (_0x11d2bd, _0x4d0be1) { return _0x11d2bd(_0x4d0be1); }, 'ubVUM': function (_0x41882f, _0xfb36a) { return _0x41882f || _0xfb36a; } }, _0x7a6aa5 = { 'checked': ![] }, _0x296892 = await Promise.all(ENGINE_META.map(async (_0x1dd28d) => {
        const [_0x14cf1d, _0x5524e5] = await Promise.all([_0x1d0ece.tWBbp(probeEngineVersion, _0x1dd28d.bin, _0x1dd28d.args), _0x1d0ece.aICIP(githubLatestTag, _0x1dd28d.repo)]);
        if (_0x5524e5)
            _0x7a6aa5.checked = !![];
        return { 'id': _0x1dd28d.id, 'name': _0x1dd28d.name, 'why': _0x1dd28d.why, 'installed': _0x1d0ece.ubVUM(_0x14cf1d, null), 'latest': _0x5524e5 || null, 'updateAvailable': _0x1d0ece.tWBbp(updateAvailable, _0x14cf1d, _0x5524e5), 'present': !!_0x14cf1d };
    }));
    return { 'rows': _0x296892, 'online': _0x7a6aa5.checked, 'appVersion': app.getVersion() };
});
const engineUpdates = new Map();
function resolvedEnginePath(name) {
    const managed = binPath(name);
    if (fs.existsSync(managed))
        return managed;
    const key = name === 'yt-dlp' ? 'ytdlp' : name;
    return binPaths[key] || managed;
}
async function updateEngine(id, sender) {
    const install = { ytdlp: refreshYtdlp, deno: refreshDeno, ffmpeg: refreshFfmpeg }[id];
    if (!install)
        return { ok: false, error: 'Komponen tak dikenal' };
    if (engineUpdates.has(id))
        return engineUpdates.get(id);
    const task = (async () => {
        await waitForProbes();
        const progress = (message, pct) => { try {
            sender.send('engines-progress', { id, message, pct });
        }
        catch { } };
        try {
            const installedPath = await install(progress);
            if (typeof installedPath !== 'string' || !fs.existsSync(installedPath))
                throw new Error('Installer tidak menghasilkan binary yang dapat dipakai');
            binPaths[id] = installedPath;
            const version = await probeEngineVersion(id === 'ytdlp' ? 'yt-dlp' : id, id === 'ffmpeg' ? ['-version'] : ['--version']);
            if (!version)
                throw new Error('Binary terpasang tetapi pemeriksaan versinya gagal');
            progress('Siap dipakai', 1);
            return { ok: true, version };
        }
        catch (error) {
            return { ok: false, error: error.message || String(error) };
        }
    })();
    engineUpdates.set(id, task);
    try {
        return await task;
    }
    finally {
        engineUpdates.delete(id);
    }
}
ipcMain.handle('engines:update', (event, id) => updateEngine(id, event.sender));
ipcMain.handle('engines:fixYoutube', async (event) => {
    const result = {};
    for (const id of ['ytdlp', 'deno']) {
        const installed = await updateEngine(id, event.sender);
        result[id] = installed.ok ? true : installed.error;
    }
    return result;
});
const UPDATE_REPO = "cultivatestd-lang/socl-visuals-releases", DOWNLOAD_PAGE_URL = "https://socialvisuals.xyz/download";
async function fetchReleasesJson(_0x3fc7dd) {
    const _0x2e6325 = { 'hGhrs': function (_0x2328b4, _0x1a5567, _0x280ca8) { return _0x2328b4(_0x1a5567, _0x280ca8); }, 'Dixnk': "application/vnd.github+json", 'lxwBR': function (_0x3f7913, _0x208c12) { return _0x3f7913(_0x208c12); } }, _0x16d420 = new AbortController(), _0x1fc221 = setTimeout(() => _0x16d420.abort(), 0x2710);
    try {
        const _0x3b78d8 = await _0x2e6325.hGhrs(fetch, "https://api.github.com/repos/" + UPDATE_REPO + _0x3fc7dd, { 'headers': { 'User-Agent': "SOCL-Visuals-Studio", 'Accept': _0x2e6325.Dixnk }, 'signal': _0x16d420.signal });
        if (!_0x3b78d8.ok)
            throw new Error("GitHub API " + _0x3b78d8.status);
        return await _0x3b78d8.json();
    }
    finally {
        _0x2e6325.lxwBR(clearTimeout, _0x1fc221);
    }
}
async function fetchLatestReleaseTag(_0x317215, _0x11c984 = ![]) {
    const _0x24445e = { 'wTaVp': function (_0x1cbb8e, _0x341003) { return _0x1cbb8e(_0x341003); }, 'oLIDA': "/releases/latest", 'caGPq': function (_0x27bdad, _0x32a5de, _0x28c3ba, _0x1701f5) { return _0x27bdad(_0x32a5de, _0x28c3ba, _0x1701f5); } };
    if (!isPrerelease(_0x317215) && !_0x11c984) {
        const _0x562a0b = await _0x24445e.wTaVp(fetchReleasesJson, _0x24445e.oLIDA);
        return _0x562a0b.tag_name || '';
    }
    return _0x24445e.caGPq(pickLatestTag, await fetchReleasesJson("/releases?per_page=30"), _0x317215, { 'includePrerelease': _0x11c984 });
}
ipcMain.handle("check-update", async () => {
    const _0x1ff503 = { 'crdyc': function (_0x11856f) { return _0x11856f(); }, 'YQDTp': function (_0x49de46, _0x28b6c7, _0x523db2) { return _0x49de46(_0x28b6c7, _0x523db2); }, 'GonBK': function (_0x2beb69, _0x45820c) { return _0x2beb69 > _0x45820c; } };
    try {
        const _0x20c3fc = app.getVersion(), _0x1e926d = _0x1ff503.crdyc(readCfg).updateBetaChannel === !![], _0x484439 = await _0x1ff503.YQDTp(fetchLatestReleaseTag, _0x20c3fc, _0x1e926d), _0xd53342 = String(_0x484439).replace(/^v/i, '').trim();
        if (!_0xd53342)
            return { 'ok': ![], 'error': "Tidak ada tag rilis." };
        return { 'ok': !![], 'current': _0x20c3fc, 'latest': _0xd53342, 'isBeta': isPrerelease(_0xd53342), 'hasUpdate': _0x1ff503.GonBK(_0x1ff503.YQDTp(compareVersions, _0xd53342, _0x20c3fc), 0x0), 'downloadUrl': DOWNLOAD_PAGE_URL };
    }
    catch (_0x1ccbca) {
        return { 'ok': ![], 'error': _0x1ccbca.message };
    }
});
ipcMain.handle("open-download-page", () => { ; shell.openExternal(DOWNLOAD_PAGE_URL); });
ipcMain.handle("clear-cache", async () => {
    ;
    try {
        for (const { dir: _0x513f11 } of await workRoot.listSessions([OUTPUT_ROOT], Infinity)) {
            await fs.promises.rm(_0x513f11, { 'recursive': !![], 'force': !![] });
        }
        return { 'ok': !![] };
    }
    catch (_0x3822d5) {
        return { 'ok': ![], 'error': _0x3822d5.message };
    }
});
ipcMain.handle("run-pipeline", async (_0x30075a, _0x2413a4) => {
    const _0x13d86a = { 'usJJZ': "question", 'aWuxW': "Transkrip offline", 'iknjc': "Lewati", 'FwEAx': "groq", 'CVfpL': function (_0x1a933e, _0xe18b0b) { return _0x1a933e === _0xe18b0b; }, 'iukvk': "offline", 'JPSbp': 'skip', 'VIIEr': function (_0x323ed9) { return _0x323ed9(); }, 'AqQOQ': "Source is empty (URL atau file).", 'sdiHc': function (_0x65a862, _0x377060, _0x50a49f) { return _0x65a862(_0x377060, _0x50a49f); }, 'faUjK': "yellow", 'iJMYu': function (_0x4ac933, _0x56448e) { return _0x4ac933 !== _0x56448e; }, 'EoREP': function (_0x295cdb) { return _0x295cdb(); }, 'eFGTd': function (_0x424bbf, _0x534e2c) { return _0x424bbf !== _0x534e2c; }, 'nxqvd': function (_0x2e372e, _0x2956cd, _0x568273) { return _0x2e372e(_0x2956cd, _0x568273); }, 'wiFFc': "pipeline-log", 'DvKaj': function (_0xfc01f7, _0x3927c7) { return _0xfc01f7(_0x3927c7); }, 'iAAbX': "pipeline.log" };
    if (pipelineRunActive)
        throw new Error("Tidak bisa memulai: proses lain masih berjalan. Batalkan atau tunggu proses itu selesai.");
    const _0x33ab29 = _0x30075a.sender, _0x387f1e = { ..._0x13d86a.VIIEr(readCfg), ..._0x2413a4.overrides || {} }, _0x566faa = _0x2413a4.source, _0x438a9c = _0x2413a4.subtitleFile || null, _0x1ef86b = !!_0x2413a4.noTranscript;
    if (!_0x566faa)
        throw new Error(_0x13d86a.AqQOQ);
    const _0x3b72e8 = 'socl-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0x0, 0x13), _0xae58b = (_0x34557b, _0x4a6d7a) => {
        ;
        try {
            _0x33ab29.send(_0x34557b, _0x4a6d7a);
        }
        catch { }
    };
    pipelineRunActive = !![], pipelineCancelRequested = ![];
    let _0x491d0b = null;
    try {
        const _0x169570 = await workRoot.resolveWorkRoot({ 'exportPath': _0x387f1e.exportPath, 'defaultRoot': OUTPUT_ROOT });
        if (_0x169570.fallbackReason)
            _0x13d86a.sdiHc(_0xae58b, "pipeline-log", { 'line': "\u26A0 Memakai folder internal untuk proses ini: " + _0x169570.fallbackReason + (". Hasil tetap dicoba disalin ke folder ekspor."), 'kind': _0x13d86a.faUjK });
        else {
            if (_0x13d86a.iJMYu(_0x169570.root, OUTPUT_ROOT)) {
                const _0x3cd66e = _0x13d86a.EoREP(readCfg).workRoots, _0x31da03 = workRoot.rememberRoot(_0x3cd66e, _0x169570.root);
                if (_0x13d86a.eFGTd(JSON.stringify(_0x31da03), JSON.stringify(_0x3cd66e)))
                    await writeCfg({ 'workRoots': _0x31da03 });
            }
        }
        _0x491d0b = path.join(_0x169570.root, _0x3b72e8), fs.mkdirSync(_0x491d0b, { 'recursive': !![] });
        const _0x4d2c4f = secrets.diagnose(), _0x6e012 = secrets.warningFor(_0x4d2c4f);
        if (_0x6e012)
            _0x13d86a.nxqvd(_0xae58b, _0x13d86a.wiFFc, { 'line': _0x6e012, 'kind': _0x13d86a.faUjK });
        if (pipelineCancelRequested)
            throw new Error("cancelled");
        const _0x358e4c = await _0x13d86a.DvKaj(runPipeline, { 'source': _0x566faa, 'sessionDir': _0x491d0b, 'cfg': _0x387f1e, 'binPaths': binPaths, 'subtitleFile': _0x438a9c, 'noTranscript': _0x1ef86b, 'secretsLocked': !_0x4d2c4f.ok, 'onConfirmDownload': async ({ title: _0x40b904, message: _0x3539e6, detail: _0x3c888e, groqUrl: _0xa34bef }) => {
                const _0x3d6220 = mainWin && !mainWin.isDestroyed() ? mainWin : null, _0x359d73 = { 'type': _0x13d86a.usJJZ, 'buttons': ["Ambil Groq key (gratis)", _0x13d86a.aWuxW, _0x13d86a.iknjc], 'defaultId': 0x0, 'cancelId': 0x2, 'title': _0x40b904, 'message': _0x3539e6, 'detail': _0x3c888e, 'checkboxLabel': "Jangan tanya lagi", 'checkboxChecked': ![] }, _0x138b92 = _0x3d6220 ? await dialog.showMessageBox(_0x3d6220, _0x359d73) : await dialog.showMessageBox(_0x359d73), _0x26b754 = _0x138b92.response === 0x0 ? _0x13d86a.FwEAx : _0x13d86a.CVfpL(_0x138b92.response, 0x1) ? _0x13d86a.iukvk : _0x13d86a.JPSbp;
                if (_0x13d86a.CVfpL(_0x26b754, _0x13d86a.FwEAx) && _0xa34bef)
                    try {
                        await shell.openExternal(_0xa34bef);
                    }
                    catch { }
                if (_0x138b92.checkboxChecked && _0x26b754 !== _0x13d86a.iukvk)
                    await writeCfg({ 'localAsr': ![] });
                return _0x26b754;
            }, 'userDataDir': app.getPath("userData"), 'onLog': (_0x4f4104, _0x458cb1 = '') => _0xae58b("pipeline-log", { 'line': _0x4f4104, 'kind': _0x458cb1 }), 'onProgress': (_0x2f519c, _0x5f4bea, _0x5c5b3b) => _0xae58b("pipeline-progress", { 'step': _0x2f519c, 'detail': _0x5f4bea, 'percent': _0x5c5b3b }), 'onSourcePreview': _0x15fdb9 => _0xae58b("pipeline-source-preview", _0x15fdb9), 'onClipsDetected': _0x209a5c => _0xae58b("pipeline-clips-detected", _0x209a5c), 'onClipState': _0x1690d9 => _0xae58b("pipeline-clip-state", _0x1690d9), 'onClip': _0x2e1ae4 => _0xae58b("pipeline-clip", _0x2e1ae4) });
        return _0xae58b("pipeline-done", _0x358e4c), _0x358e4c;
    }
    catch (_0x1e56eb) {
        if (_0x491d0b) {
            await _0x13d86a.VIIEr(flushRunLog);
            const _0xcb8063 = SF.dataPath(_0x491d0b, _0x13d86a.iAAbX);
            await fs.promises.mkdir(path.dirname(_0xcb8063), { 'recursive': !![] }).catch(() => { });
            const _0x58a8ba = fs.promises.appendFile(_0xcb8063, '[' + new Date().toISOString() + ("] === run FAILED: ") + (_0x1e56eb.message || _0x1e56eb) + '\x0a' + ((_0x1e56eb.stack || '') + '\x0a' + (_0x1e56eb.stderr ? "--- stderr:\n" + _0x1e56eb.stderr + '\x0a' : ''))).catch(() => { });
            await Promise.race([_0x58a8ba, new Promise(_0x23f8fe => setTimeout(_0x23f8fe, 0x1388))]);
        }
        _0x13d86a.nxqvd(_0xae58b, "pipeline-error", { 'message': _0x1e56eb.message || _0x13d86a.DvKaj(String, _0x1e56eb) });
        throw _0x1e56eb;
    }
    finally {
        pipelineRunActive = ![];
        ;
    }
});
ipcMain.handle("cancel-pipeline", () => requestPipelineCancel());
const trackerBundle = require("./tracker-bundle");
ipcMain.handle("tracker:isInstalled", () => trackerBundle.isInstalled());
ipcMain.handle("tracker:ready", () => trackerAvailable());
ipcMain.handle("tracker:platform", () => trackerBundle.platformKey());
ipcMain.handle("tracker:version", () => trackerBundle.MANIFEST.version);
ipcMain.handle("tracker:remove", () => { return trackerBundle.remove(), !![]; });
const whisperBundle = require("./whisper-bundle");
if (process.env.SOCL_NATIVE_WHISPER !== '1') {
    ipcMain.handle("whisper:status", (_0x45c62f, _0x291afb) => { const _0x78bfde = _0x291afb || readCfg().whisperModelSize || whisperBundle.MANIFEST.defaultModel; return { 'supported': whisperBundle.isSupportedPlatform(), 'platform': whisperBundle.platformKey(), 'installed': whisperBundle.isSupportedPlatform() && whisperBundle.isInstalled(_0x78bfde), 'binary': whisperBundle.isSupportedPlatform() && whisperBundle.binaryInstalled(), 'model': _0x78bfde, 'sizeMB': Math.round(whisperBundle.downloadSize(_0x78bfde) / 0x100000), 'models': whisperBundle.modelNames().map(_0x5c679a => ({ 'id': _0x5c679a, 'label': whisperBundle.modelSpec(_0x5c679a).label, 'mb': Math.round(whisperBundle.modelSpec(_0x5c679a).size / 0x100000), 'installed': whisperBundle.isSupportedPlatform() && whisperBundle.modelInstalled(_0x5c679a) })) }; });
    ipcMain.handle("whisper:ensure", async (_0x4ccf0d, _0x1d6c12) => {
        const _0x54a363 = { 'fFaXJ': "whisper-progress" }, _0x10d7a3 = _0x11fbcd => {
            ;
            try {
                _0x4ccf0d.sender.send(_0x54a363.fFaXJ, _0x11fbcd);
            }
            catch { }
        };
        try {
            const _0x5ccbb = _0x1d6c12 || readCfg().whisperModelSize || whisperBundle.MANIFEST.defaultModel;
            return await whisperBundle.ensureInstalled(_0x5ccbb, _0x10d7a3), { 'ok': !![] };
        }
        catch (_0x506f08) {
            return { 'ok': ![], 'error': _0x506f08.message };
        }
    });
    ipcMain.handle("whisper:remove", () => { ; return whisperBundle.remove(), !![]; });
}
const ctxBundle = require("./context-model/bundle");
ipcMain.handle("ctxmodel:status", () => ({ 'supported': ctxBundle.isSupported(), 'platform': ctxBundle.platformKey(), 'installed': ctxBundle.isSupported() && ctxBundle.isInstalled(), 'sizeMB': Math.round(ctxBundle.downloadBytes() / 0x100000) }));
ipcMain.handle("ctxmodel:ensure", async (_0x4adb1e) => {
    const _0x4cf5d2 = { 'DZypD': "ctxmodel-progress" }, _0x23bf88 = _0x54cc15 => {
        ;
        try {
            _0x4adb1e.sender.send(_0x4cf5d2.DZypD, _0x54cc15);
        }
        catch { }
    };
    try {
        return await ctxBundle.ensureInstalled(_0x23bf88), { 'ok': !![] };
    }
    catch (_0x32a3e8) {
        return { 'ok': ![], 'error': _0x32a3e8.message };
    }
});
ipcMain.handle("ctxmodel:remove", () => { ; return ctxBundle.remove(), !![]; });
ipcMain.handle("tracker:ensure", async (_0x1d88b9) => {
    const _0x3d0aff = _0x4e7164 => {
        ;
        try {
            _0x1d88b9.sender.send("tracker-progress", _0x4e7164);
        }
        catch { }
    };
    try {
        const _0x4700dc = await trackerBundle.ensureInstalled(_0x3d0aff);
        return _0x4700dc && _0x4700dc.fallback ? { 'ok': !![], 'fallback': _0x4700dc.fallback } : { 'ok': !![] };
    }
    catch (_0x44793b) {
        return { 'ok': ![], 'error': _0x44793b.message };
    }
});
const editorLogger = _0x255d44 => (_0x21ac0a, _0x436faf = '') => {
    const _0x13a3ea = { 'psoeO': "pipeline-log" };
    try {
        _0x255d44.send(_0x13a3ea.psoeO, { 'line': _0x21ac0a, 'kind': _0x436faf });
    }
    catch { }
}, renderProgressSender = (_0xde6cb6, _0x5d525a, _0x525bde = ![]) => {
    const _0x1c58de = { 'xplax': function (_0x2c2c2e, _0x1d132c) { return _0x2c2c2e * _0x1d132c; }, 'bDXVP': function (_0x485065, _0x245c66) { return _0x485065(_0x245c66); }, 'TlrNd': function (_0x2368b0, _0x25c3d9) { return _0x2368b0 < _0x25c3d9; }, 'BzPTD': function (_0x2de314, _0x4939dc) { return _0x2de314 - _0x4939dc; }, 'mMfpw': "render-progress" };
    let _0x4fc407 = 0x0, _0x59f7ca = -0x1;
    return (_0x48a817, _0x402fb0) => {
        const _0xf6a6db = Math.round(_0x1c58de.xplax(Math.max(0x0, Math.min(0x1, _0x1c58de.bDXVP(Number, _0x48a817) || 0x0)), 0x64)), _0x25bc13 = Date.now();
        if (_0xf6a6db === _0x59f7ca || _0x1c58de.TlrNd(_0xf6a6db, 0x64) && _0x1c58de.BzPTD(_0x25bc13, _0x4fc407) < 0xfa)
            return;
        _0x4fc407 = _0x25bc13, _0x59f7ca = _0xf6a6db;
        try {
            _0xde6cb6.send(_0x1c58de.mMfpw, { 'clipIndex': _0x5d525a, 'pct': _0xf6a6db, 'stage': _0x402fb0, 'preview': _0x525bde });
        }
        catch { }
    };
};
ipcMain.handle("apply-crop", async (_0x49b602, _0x3f5b1a) => {
    const _0x27e7d8 = { 'tSGgO': function (_0x3077de, _0x32c697) { return _0x3077de || _0x32c697; }, 'tQvPz': "[apply-crop] start", 'UxcLy': function (_0x1a86f5, _0x1456e5) { return _0x1a86f5(_0x1456e5); }, 'shXmO': "[apply-crop/report]", 'EIdGM': "[apply-crop] FAIL\n" }, { clipIndex: _0x42b063, clipFile: _0x24cf18, srcVideo: _0x398090, clipStart: _0x385554, clipEnd: _0x4f6c4d, clipFormat: _0x309b8e, clipResolution: _0x412030, cropX: _0x46817b, cropY: _0x458c0f, cropScale: _0x30adc6, cropKeyframes: _0x52e6ce, cropAspect: _0xeee2d5, cropRect: _0x251ad9, splitCrop: _0x5e1d0e } = _0x27e7d8.tSGgO(_0x3f5b1a, {});
    console.log(_0x27e7d8.tQvPz, { 'clipFile': _0x24cf18, 'srcVideo': _0x398090, 'clipStart': _0x385554, 'clipEnd': _0x4f6c4d, 'clipFormat': _0x309b8e, 'clipResolution': _0x412030, 'cropAspect': _0xeee2d5 });
    try {
        const _0x3be9ce = await applyClipCrop({ 'srcFile': _0x24cf18, 'srcVideo': _0x398090, 'clipStart': _0x385554, 'clipEnd': _0x4f6c4d, 'clipFormat': _0x309b8e, 'clipResolution': _0x412030, 'cropX': _0x46817b, 'cropY': _0x458c0f, 'cropScale': _0x30adc6, 'cropKeyframes': _0x52e6ce, 'cropAspect': _0xeee2d5, 'cropRect': _0x251ad9, 'splitCrop': _0x5e1d0e, 'binPaths': binPaths, 'onLog': _0x27e7d8.UxcLy(editorLogger, _0x49b602.sender) });
        console.log("[apply-crop] ok", _0x3be9ce);
        const _0x39b21d = await _0x27e7d8.UxcLy(persistClipPatch, { 'outputFile': _0x3be9ce.file, 'clipIndex': _0x42b063, 'patch': { 'file': _0x3be9ce.file, 'rawFile': _0x3be9ce.file, 'thumbnail': _0x3be9ce.thumbnail, 'subsBurned': ![], 'splitCrop': _0x5e1d0e || null, ..._0x5e1d0e ? { 'trackPlan': null, 'cropAspect': null, 'cropRect': null, 'cropKF': null } : {} } });
        if (_0x39b21d.error)
            console.warn(_0x27e7d8.shXmO, _0x39b21d.error);
        return _0x3be9ce;
    }
    catch (_0x39216e) {
        return console.error(_0x27e7d8.EIdGM, _0x39216e.stack || _0x39216e.message || _0x39216e), { 'error': _0x39216e.message || String(_0x39216e) };
    }
});
ipcMain.handle("batch-render-plan", (_0xc49eda, _0x19ed1e = {}) => { const _0x3af629 = { 'WNeMG': "./mem-available" }, _0x46960b = Math.max(0x1, Math.floor(Number(_0x19ed1e.clipCount) || 0x1)), _0x3d9b4a = detectHwEncoder(); return renderPlanFor({ 'smartTrack': ![], 'hw': _0x3d9b4a, 'cpus': os.cpus().length, 'freeMemBytes': require(_0x3af629.WNeMG).availableMemBytes(), 'clips': _0x46960b, 'resolution': _0x19ed1e.resolution }); });
ipcMain.handle("render-edit", async (_0x4c77b6, _0x476f3e) => {
    const _0x259cee = { 'ymAQD': function (_0x10ffc7, _0x4f2179) { return _0x10ffc7 || _0x4f2179; }, 'fylpA': function (_0x2ea310, _0x3013b8) { return _0x2ea310(_0x3013b8); }, 'FHGei': function (_0xbc428) { return _0xbc428(); }, 'QMldq': "[render-edit] ok", 'GLYzH': function (_0x2b6263, _0xf87549) { return _0x2b6263(_0xf87549); }, 'iAjAH': function (_0xa2cdee, _0x57fddd) { return _0xa2cdee > _0x57fddd; }, 'XxoLr': "[render-edit/report]", 'vzZaM': "[render-edit] FAIL\n" }, { clipIndex: _0x399bfe, clipFile: _0x4b8c99, srcVideo: _0x3cbc53, clipStart: _0x348f34, clipEnd: _0x2139b4, clipFormat: _0x4c5873, clipResolution: _0x379f1d, cropX: _0x2c300a, cropY: _0x203be1, cropScale: _0x4ca07b, cropKeyframes: _0x433910, cropAspect: _0x4063c8, cropRect: _0x341ca6, cueWords: _0x1499e7, style: _0x250ca8, titles: _0x3568d6, manualCaptions: _0x214dff, trackPlan: _0x51b906, watermark: _0x598895, aiStickerCache: _0x3131a6, broll: _0x142f47, timeline: _0x144d26 } = _0x259cee.ymAQD(_0x476f3e, {});
    console.log("[render-edit] start", { 'clipFile': _0x4b8c99, 'srcVideo': _0x3cbc53, 'clipStart': _0x348f34, 'clipEnd': _0x2139b4, 'clipFormat': _0x4c5873, 'clipResolution': _0x379f1d, 'titles': _0x3568d6.length || 0x0, 'wm': !!(_0x598895 && _0x598895.enabled), 'ffmpeg': binPaths.ffmpeg, 'platform': process.platform });
    try {
        const _0x24d675 = await _0x259cee.fylpA(renderClipEdit, { 'srcFile': _0x4b8c99, 'srcVideo': _0x3cbc53, 'clipStart': _0x348f34, 'clipEnd': _0x2139b4, 'clipFormat': _0x4c5873, 'clipResolution': _0x379f1d, 'cropX': _0x2c300a, 'cropY': _0x203be1, 'cropScale': _0x4ca07b, 'cropKeyframes': _0x433910, 'cropAspect': _0x4063c8, 'cropRect': _0x341ca6, 'cueWords': _0x1499e7, 'style': _0x250ca8, 'titles': _0x3568d6, 'manualCaptions': _0x214dff, 'binPaths': binPaths, 'trackPlan': _0x51b906, 'watermark': _0x598895, 'cfg': _0x259cee.FHGei(readCfg), 'aiStickerCache': _0x3131a6, 'broll': _0x142f47, 'timeline': _0x144d26, 'onLog': editorLogger(_0x4c77b6.sender), 'onProgress': renderProgressSender(_0x4c77b6.sender, _0x399bfe) });
        console.log(_0x259cee.QMldq, _0x24d675);
        const _0x4b8eb9 = await _0x259cee.GLYzH(persistClipPatch, { 'outputFile': _0x24d675.file, 'clipIndex': _0x399bfe, 'patch': { 'file': _0x24d675.file, 'thumbnail': _0x24d675.thumbnail, 'subsBurned': Array.isArray(_0x1499e7) && _0x259cee.iAjAH(_0x1499e7.length, 0x0), 'aiStickerCache': _0x24d675.aiStickerCache, 'titles': Array.isArray(_0x3568d6) ? _0x3568d6 : [], 'titlesBurned': Array.isArray(_0x3568d6) && _0x3568d6.length > 0x0, 'watermarkBurnedSnapshot': _0x598895 ? JSON.stringify(_0x598895) : undefined } });
        if (_0x4b8eb9.error)
            console.warn(_0x259cee.XxoLr, _0x4b8eb9.error);
        const _0x5263c9 = await exportToUserFolder(_0x259cee.FHGei(readCfg), [_0x24d675.file], path.dirname(_0x24d675.file || ''), _0x4613f9 => console.log("[render-edit/export]", _0x4613f9));
        if (_0x5263c9.dir)
            _0x24d675.exportedTo = _0x5263c9.dir;
        if (_0x5263c9.error)
            _0x24d675.exportWarning = _0x5263c9.error;
        return _0x24d675;
    }
    catch (_0x3e0708) {
        return console.error(_0x259cee.vzZaM, _0x3e0708.stack || _0x3e0708.message || _0x3e0708), { 'error': _0x3e0708.message || String(_0x3e0708) };
    }
});
ipcMain.handle("render-preview", async (_0x5b6fe6, _0x2efd6f) => {
    const _0x2f1d25 = { 'jgXwP': function (_0x29cfec, _0x450dea) { return _0x29cfec || _0x450dea; }, 'sCxLd': "[render-preview] start", 'cqVis': function (_0x3dfab9) { return _0x3dfab9(); }, 'wDPuE': function (_0x301a0a, _0x5621a6) { return _0x301a0a(_0x5621a6); } }, { clipFile: _0x131401, srcVideo: _0x4e1625, clipStart: _0x31feee, clipEnd: _0x448502, clipFormat: _0x464fca, clipResolution: _0x5bef36, cropX: _0x5cfa33, cropY: _0x54403a, cropScale: _0x226680, cropKeyframes: _0xb693d8, cropAspect: _0x5d0eeb, cropRect: _0x4ed29d, cueWords: _0x3e55c2, style: _0x1c6e7d, titles: _0x547570, manualCaptions: _0x4973db, trackPlan: _0x3b90fa, watermark: _0x5c6288, aiStickerCache: _0x17bb54 } = _0x2f1d25.jgXwP(_0x2efd6f, {});
    console.log(_0x2f1d25.sCxLd, { 'clipFile': _0x131401, 'srcVideo': _0x4e1625, 'titles': _0x547570.length || 0x0, 'wm': !!(_0x5c6288 && _0x5c6288.enabled), 'ffmpeg': binPaths.ffmpeg, 'platform': process.platform });
    try {
        const _0x1a350b = await renderClipEdit({ 'srcFile': _0x131401, 'srcVideo': _0x4e1625, 'clipStart': _0x31feee, 'clipEnd': _0x448502, 'clipFormat': _0x464fca, 'clipResolution': _0x5bef36, 'cropX': _0x5cfa33, 'cropY': _0x54403a, 'cropScale': _0x226680, 'cropKeyframes': _0xb693d8, 'cropAspect': _0x5d0eeb, 'cropRect': _0x4ed29d, 'cueWords': _0x3e55c2, 'style': _0x1c6e7d, 'titles': _0x547570, 'manualCaptions': _0x4973db, 'binPaths': binPaths, 'preview': !![], 'trackPlan': _0x3b90fa, 'watermark': _0x5c6288, 'cfg': _0x2f1d25.cqVis(readCfg), 'aiStickerCache': _0x17bb54, 'onLog': editorLogger(_0x5b6fe6.sender), 'onProgress': renderProgressSender(_0x5b6fe6.sender, (_0x2efd6f || {}).clipIndex, !![]) });
        return console.log("[render-preview] ok", _0x1a350b), _0x1a350b;
    }
    catch (_0x218fea) {
        return console.error("[render-preview] FAIL\n", _0x218fea.stack || _0x218fea.message || _0x218fea), { 'error': _0x218fea.message || _0x2f1d25.wDPuE(String, _0x218fea) };
    }
});
const WM_ROOT = () => path.join(app.getPath("userData"), "watermarks"), WM_ALLOWED_EXT = new Set(['png', "webp", "jpg", "jpeg"]), WM_MAX_BYTES = 0x5 * 0x400 * 0x400;
ipcMain.handle("wm:saveAsset", async (_0x9353f4, _0x55ede8) => {
    const _0x55a844 = { 'dZpNn': function (_0x1f7b54, _0xf73830) { return _0x1f7b54 || _0xf73830; }, 'ufWeW': function (_0x49a2c3, _0x431d34) { return _0x49a2c3(_0x431d34); }, 'ilNMf': function (_0x9ff990, _0x58caa5) { return _0x9ff990 > _0x58caa5; }, 'YYduL': function (_0x3188fe, _0x39ff7a) { return _0x3188fe / _0x39ff7a; }, 'aWYKO': function (_0x29278b, _0x43eaa5) { return _0x29278b / _0x43eaa5; }, 'fSMRo': 'crypto', 'qOOoK': "hex", 'LlKyM': function (_0x2039db) { return _0x2039db(); }, 'Asfbq': function (_0x43faa2) { return _0x43faa2(); } };
    try {
        const { filename: _0x1a33f4, bytes: _0x44139b } = _0x55a844.dZpNn(_0x55ede8, {});
        if (!_0x1a33f4 || !_0x44139b)
            return { 'error': "Missing filename/bytes" };
        const _0x291c9c = _0x55a844.ufWeW(String, _0x1a33f4).toLowerCase().split('.').pop();
        if (!WM_ALLOWED_EXT.has(_0x291c9c))
            return { 'error': "Format tidak didukung (" + _0x291c9c + ("). Gunakan PNG/WebP/JPEG.") };
        const _0x5be04a = Buffer.isBuffer(_0x44139b) ? _0x44139b : Buffer.from(_0x44139b);
        if (_0x55a844.ilNMf(_0x5be04a.length, WM_MAX_BYTES))
            return { 'error': "File terlalu besar (" + _0x55a844.YYduL(_0x55a844.aWYKO(_0x5be04a.length, 0x400), 0x400).toFixed(0x1) + ("MB). Max 5MB.") };
        if (_0x5be04a.length < 0x20)
            return { 'error': "File terlalu kecil / rusak." };
        const _0x1da2a8 = _0x55a844.ufWeW(require, _0x55a844.fSMRo), _0x36253e = _0x1da2a8.createHash("sha1").update(_0x5be04a).digest(_0x55a844.qOOoK).slice(0x0, 0x10);
        fs.mkdirSync(_0x55a844.LlKyM(WM_ROOT), { 'recursive': !![] });
        const _0x2c626b = path.join(_0x55a844.Asfbq(WM_ROOT), _0x36253e + '.' + _0x291c9c);
        if (!fs.existsSync(_0x2c626b))
            fs.writeFileSync(_0x2c626b, _0x5be04a);
        return { 'path': _0x2c626b, 'filename': _0x1a33f4, 'ext': _0x291c9c, 'bytes': _0x5be04a.length };
    }
    catch (_0x295ac3) {
        return console.error("[wm:saveAsset] FAIL", _0x295ac3), { 'error': _0x295ac3.message || String(_0x295ac3) };
    }
});
ipcMain.handle("wm:deleteAsset", async (_0x5a1cce, _0x52394c) => {
    const _0x44657f = { 'nqqjU': function (_0x51e29a, _0x4aecf7) { return _0x51e29a + _0x4aecf7; }, 'nbdks': "Path outside watermarks dir", 'Odqhl': function (_0x22b938, _0x45ae73) { return _0x22b938(_0x45ae73); } };
    try {
        if (!_0x52394c)
            return { 'ok': !![] };
        const _0x56be01 = path.resolve(_0x52394c), _0x2e3da3 = path.resolve(WM_ROOT());
        if (!_0x56be01.startsWith(_0x44657f.nqqjU(_0x2e3da3, path.sep)) && _0x56be01 !== _0x2e3da3)
            return { 'ok': ![], 'error': _0x44657f.nbdks };
        if (fs.existsSync(_0x56be01))
            fs.unlinkSync(_0x56be01);
        return { 'ok': !![] };
    }
    catch (_0x1572dd) {
        return { 'ok': ![], 'error': _0x1572dd.message || _0x44657f.Odqhl(String, _0x1572dd) };
    }
});
ipcMain.handle("ai-fix-typos", async (_0x57b33e, _0x5795b6) => {
    const _0x1311f8 = { 'cyliu': function (_0x39fdf3, _0x2da9d5) { return _0x39fdf3(_0x2da9d5); } };
    try {
        return await fixCaptionTypos(readCfg(), _0x5795b6 || {});
    }
    catch (_0x106ca4) {
        return { 'error': _0x106ca4.message || _0x1311f8.cyliu(String, _0x106ca4) };
    }
});
ipcMain.handle("clip:saveMeta", async (_0x381a90, _0x32be70 = {}) => {
    const _0x451cf4 = { 'Kpnqy': function (_0xd4c4e6, _0x253436) { return _0xd4c4e6 === _0x253436; }, 'BwZRu': function (_0x1d033e, _0x535fa7) { return _0x1d033e(_0x535fa7); } }, { outputFile: _0x3a6899, clipIndex: _0x5e5663, title: _0x22b481, hook: _0x3c6a64, why: _0x470d98 } = _0x32be70, _0x5c4b42 = {};
    if (_0x451cf4.Kpnqy(typeof _0x22b481, "string"))
        _0x5c4b42.title = _0x22b481;
    if (typeof _0x3c6a64 === "string")
        _0x5c4b42.hook = _0x3c6a64;
    if (_0x451cf4.Kpnqy(typeof _0x470d98, 'string'))
        _0x5c4b42.why = _0x470d98;
    if (!Object.keys(_0x5c4b42).length)
        return { 'updated': ![], 'reason': "empty-patch" };
    try {
        const _0x291308 = await _0x451cf4.BwZRu(persistClipPatch, { 'outputFile': _0x3a6899, 'clipIndex': _0x5e5663, 'patch': _0x5c4b42 });
        if (_0x291308.error)
            console.warn("[clip:saveMeta]", _0x291308.error);
        return _0x291308;
    }
    catch (_0x1a14be) {
        return { 'updated': ![], 'error': _0x1a14be.message || String(_0x1a14be) };
    }
});
ipcMain.handle("ai-regen-hook", async (_0x26fef1, _0x4306b5) => {
    const _0x5f5034 = { 'CEJRa': function (_0x2dcb5f, _0x2a029c) { return _0x2dcb5f(_0x2a029c); } };
    try {
        return await regenerateClipMeta(readCfg(), _0x4306b5 || {});
    }
    catch (_0x3ba5e8) {
        return { 'error': _0x3ba5e8.message || _0x5f5034.CEJRa(String, _0x3ba5e8) };
    }
});
ipcMain.handle("list-history", async () => { const _0x21a98d = await workRoot.sessionRoots(OUTPUT_ROOT, readCfg().workRoots), _0x45d16f = await workRoot.listSessions(_0x21a98d, 0x32), _0x489ed4 = await workRoot.readReports(_0x45d16f.map(_0x3e7493 => _0x3e7493.dir), undefined, { 'firstRoot': OUTPUT_ROOT }); return _0x45d16f.map((_0x4b7ec0, _0x452b02) => ({ 'jobId': _0x4b7ec0.jobId, 'dir': _0x4b7ec0.dir, 'report': _0x489ed4[_0x452b02] })); });
ipcMain.handle("reveal-clip", async (_0x25632d, _0xec1f99 = {}) => {
    const _0x102df8 = { 'FZNWo': function (_0x28b17c) { return _0x28b17c(); } }, _0x3d901b = deliveredClipFor(_0x102df8.FZNWo(readCfg), _0xec1f99 && _0xec1f99.file, _0xec1f99 && _0xec1f99.clipIndex);
    if (!_0x3d901b)
        return { 'ok': ![] };
    return shell.showItemInFolder(_0x3d901b), { 'ok': !![], 'path': _0x3d901b };
});
ipcMain.handle("open-output", async (_0x4853fd, _0x48a0d1) => {
    const _0x6bca8b = { 'ntrLx': function (_0x418bd4, _0x3d8206) { return _0x418bd4(_0x3d8206); }, 'gHgJI': function (_0x367537, _0x1b9637) { return _0x367537 === _0x1b9637; }, 'gmDzB': "string", 'JVEOf': function (_0x3b6769, _0x3c6f0a) { return _0x3b6769(_0x3c6f0a); }, 'tYvxK': "./pipeline-inverse-v1", 'bnssE': function (_0x5294b6, _0x585665) { return _0x5294b6 && _0x585665; } }, _0x45e643 = readCfg(), _0x275e15 = _0x6bca8b.ntrLx(String, _0x45e643.exportPath || '').trim(), _0x5864ab = _0x1f6d07 => {
        ;
        try {
            return fs.statSync(_0x1f6d07).isDirectory();
        }
        catch {
            return ![];
        }
    };
    let _0x13add7 = _0x6bca8b.gHgJI(typeof _0x48a0d1, _0x6bca8b.gmDzB) && _0x48a0d1 && _0x6bca8b.JVEOf(_0x5864ab, _0x48a0d1) ? _0x48a0d1 : null;
    if (_0x13add7)
        try {
            const _0x7aac3d = _0x6bca8b.ntrLx(require, _0x6bca8b.tYvxK), _0x10d393 = _0x7aac3d.hasilDirFor(_0x45e643, _0x7aac3d.sessionRootFor(_0x13add7));
            if (_0x10d393 && _0x6bca8b.ntrLx(_0x5864ab, _0x10d393) && fs.readdirSync(_0x10d393).some(_0x491b89 => /\.(mp4|mov|webm|mkv)$/i.test(_0x491b89)))
                _0x13add7 = _0x10d393;
        }
        catch { }
    if (_0x6bca8b.bnssE(!_0x13add7, _0x275e15))
        try {
            await workRoot.ensureDir(_0x275e15), _0x13add7 = _0x275e15;
        }
        catch { }
    if (!_0x13add7)
        _0x13add7 = OUTPUT_ROOT;
    return shell.openPath(_0x13add7), _0x13add7;
});
ipcMain.handle("history-thumb", async (_0x395475, _0x166d88) => {
    const _0x3ed083 = { 'COBDT': function (_0x54c4e7, _0x5ba1bd, _0x715dbf) { return _0x54c4e7(_0x5ba1bd, _0x715dbf); }, 'PTSpW': function (_0x556825, _0x2b855b) { return _0x556825(_0x2b855b); }, 'MdEeW': "ffmpeg thumbnail extract timed out after 15s", 'ZisNx': function (_0x4eb906, _0x2db883) { return _0x4eb906 + _0x2db883; }, 'MLQKW': "-ss", 'OdWmN': "0.5", 'qJvpf': '-vf', 'nnHFc': "scale=320:-2", 'dUSVa': function (_0x41d824, _0x38c415, _0x20101b, _0x34b0d9) { return _0x41d824(_0x38c415, _0x20101b, _0x34b0d9); }, 'EyVqg': 'ignore', 'nmRWO': function (_0x5790ee, _0x3c1ad3, _0x57d2bb) { return _0x5790ee(_0x3c1ad3, _0x57d2bb); }, 'nsesu': "string", 'VThBS': ".thumbs", 'bAqxx': function (_0x5c2ee2, _0xc9ce07) { return _0x5c2ee2 + _0xc9ce07; }, 'qnZjC': ".jpg", 'BVznH': function (_0x3bb0f0, _0x367bc2) { return _0x3bb0f0 > _0x367bc2; }, 'JCaib': "[history-thumb] failed:" };
    let _0x42441b = null;
    try {
        if (!_0x166d88 || typeof _0x166d88 !== _0x3ed083.nsesu || !fs.existsSync(_0x166d88))
            return null;
        const _0x1c4fcb = binPaths && binPaths.ffmpeg;
        if (!_0x1c4fcb)
            return null;
        const _0xa8e849 = path.join(path.dirname(_0x166d88), _0x3ed083.VThBS);
        _0x42441b = path.join(_0xa8e849, _0x3ed083.bAqxx(path.basename(_0x166d88).replace(/\.[^.]+$/, ''), _0x3ed083.qnZjC));
        if (fs.existsSync(_0x42441b))
            try {
                if (_0x3ed083.BVznH(fs.statSync(_0x42441b).size, 0x0))
                    return _0x42441b;
                fs.unlinkSync(_0x42441b);
            }
            catch { }
        fs.mkdirSync(_0xa8e849, { 'recursive': !![] });
        const { spawn: _0x55572a } = require("child_process");
        return await new Promise((_0x1f6bf2, _0x2cf6d9) => {
            const _0xe80438 = { 'jVFbb': function (_0x3ef20a, _0x8c6fdd, _0x5594da) { ; return _0x3ed083.COBDT(_0x3ef20a, _0x8c6fdd, _0x5594da); }, 'vXtGV': "SIGKILL", 'vQdLS': function (_0x2fc3fc, _0x39c8fe) { ; return _0x3ed083.PTSpW(_0x2fc3fc, _0x39c8fe); }, 'pPebQ': _0x3ed083.MdEeW, 'EkOCM': function (_0x23b187, _0x1bbb33) { return _0x23b187 === _0x1bbb33; }, 'aGKIB': function (_0x374cd8) { return _0x374cd8(); }, 'mExdt': function (_0x150010, _0x2cc83c) { return _0x3ed083.ZisNx(_0x150010, _0x2cc83c); } }, _0x460b90 = ['-y', _0x3ed083.MLQKW, _0x3ed083.OdWmN, '-i', _0x166d88, "-frames:v", '1', _0x3ed083.qJvpf, _0x3ed083.nnHFc, "-q:v", '4', _0x42441b], _0x3d2827 = _0x3ed083.dUSVa(_0x55572a, _0x1c4fcb, _0x460b90, { 'stdio': [_0x3ed083.EyVqg, _0x3ed083.EyVqg, _0x3ed083.EyVqg] });
            let _0x431b89 = ![];
            const _0x45149e = _0x3ed083.nmRWO(setTimeout, () => {
                ;
                if (_0x431b89)
                    return;
                _0x431b89 = !![], _0xe80438.jVFbb(killTree, _0x3d2827, _0xe80438.vXtGV), _0xe80438.vQdLS(_0x2cf6d9, new Error(_0xe80438.pPebQ));
            }, 0x3a98);
            _0x3d2827.on('error', _0x37eb61 => {
                ;
                if (_0x431b89)
                    return;
                _0x431b89 = !![], _0xe80438.vQdLS(clearTimeout, _0x45149e), _0xe80438.vQdLS(_0x2cf6d9, _0x37eb61);
            }), _0x3d2827.on("close", _0x353d05 => {
                ;
                if (_0x431b89)
                    return;
                _0x431b89 = !![], clearTimeout(_0x45149e), _0xe80438.EkOCM(_0x353d05, 0x0) ? _0xe80438.aGKIB(_0x1f6bf2) : _0x2cf6d9(new Error(_0xe80438.mExdt("ffmpeg exit ", _0x353d05)));
            });
        }), fs.existsSync(_0x42441b) && fs.statSync(_0x42441b).size > 0x0 ? _0x42441b : null;
    }
    catch (_0x25bac2) {
        console.warn(_0x3ed083.JCaib, _0x25bac2.message || _0x25bac2);
        try {
            if (_0x42441b)
                fs.unlinkSync(_0x42441b);
        }
        catch { }
        return null;
    }
});
const mainWin = { isDestroyed: () => false, webContents: require('../engine/platform.cjs').sender };
const splashWin = null;
fs.mkdirSync(path.dirname(CFG_PATH), { recursive: true });
fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
binPaths = {
    ffmpeg: fs.existsSync(binPath('ffmpeg')) ? binPath('ffmpeg') : require('ffmpeg-static'),
    ffprobe: require('@ffprobe-installer/ffprobe').path,
    ytdlp: fs.existsSync(binPath('yt-dlp')) ? binPath('yt-dlp') : null,
    deno: fs.existsSync(binPath('deno')) ? binPath('deno') : null,
};
ipcMain.handle('engine:bootstrap', async () => {
    binPaths = await bootstrap((type, value) => mainWin.webContents.send('splash-update', { type, value }));
    return binPaths;
});
module.exports = { readCfg, writeCfg, requestPipelineCancel, outputRoot: OUTPUT_ROOT, getBinPaths: () => binPaths };
// Standalone Node parity oracle; disabled in the desktop application.
if (process.env.SOCL_NATIVE_SETTINGS !== String(1)) {
    ipcMain.handle("get-settings", () => readCfg());
    ipcMain.handle("set-settings", (_0x2ad911, _0x42651d) => writeCfg(workRoot.stripMainOwnedSettings(_0x42651d || {})));
    ipcMain.handle("secrets:available", () => secrets.available());
    ipcMain.handle("secrets:diagnose", () => { const _0xf5a6d5 = secrets.diagnose(); return { ..._0xf5a6d5, 'warning': secrets.warningFor(_0xf5a6d5) }; });
}
