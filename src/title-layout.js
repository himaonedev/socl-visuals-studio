// Generated from backend/src/title-layout.ts by scripts/backend.cjs. Edit the TypeScript source.
'use strict';
// [TITLE-LAYOUT] Auto multi-line shaping for persistent titles — breaks a
// title's words into 1-4 centered lines that read as a tidy block instead of
// one long inline run, the way YouTube-thumbnail titles are hand-laid-out.
// Two shapes: PYRAMID (each line narrower than the last — the natural shape
// for short/even titles) and RHOMBUS (widest in the middle, for titles long
// enough to have a real peak). "auto" picks rhombus only when there are at
// least 3 lines AND an odd count, so the peak sits on a single centre line —
// an even line count has no single middle line to widen, and would need to
// fake symmetry across two, which reads as PYRAMID's job instead.
//
// Pure module — same require()/window.TitleLayout dual-mode as caption-box.js,
// so the renderer preview and the burn (pipeline-inverse-v1.js) compute
// BYTE-IDENTICAL line breaks from the same input. Re-implementing this on
// either side is exactly how preview/burn drift bugs get introduced.
(function (root) {
    function splitWords(text) {
        return String(text == null ? '' : text).trim().split(/\s+/).filter(Boolean);
    }
    // Line count scales gently with word count — a 2-3 word title stays on one
    // line (nothing to shape), most short-form hook titles (4-9 words) land on
    // 2-3 lines, and only a genuinely long title reaches the 4-line cap.
    // Line count scales gently with word count — a 2-3 word title stays on one
    // line (nothing to shape), most short-form hook titles (4-9 words) land on
    // 2-3 lines, and only a genuinely long title reaches the 4-line cap.
    function lineCountFor(n) {
        if (n <= 3)
            return 1;
        if (n <= 6)
            return 2;
        if (n <= 10)
            return 3;
        return 4;
    }
    // Relative per-line character-budget weights, summing to 1.
    function pyramidWeights(n) {
        const w = [];
        for (let i = 0; i < n; i++)
            w.push(n - i);
        const sum = w.reduce((a, b) => a + b, 0);
        return w.map((x) => x / sum);
    }
    function rhombusWeights(n) {
        const mid = (n - 1) / 2;
        const w = [];
        for (let i = 0; i < n; i++)
            w.push(1 / (1 + Math.abs(i - mid)));
        const sum = w.reduce((a, b) => a + b, 0);
        return w.map((x) => x / sum);
    }
    // Greedily fill each line up to its character budget, in reading order —
    // words are never reordered, only split. The LAST line absorbs whatever is
    // left, so rounding error never drops a word.
    function greedyBreaks(words, weights) {
        const totalChars = words.reduce((a, w) => a + w.length + 1, 0);
        const budgets = weights.map((w) => w * totalChars);
        const breaks = [];
        let li = 0, lineChars = 0, lineWordCount = 0;
        for (let i = 0; i < words.length; i++) {
            const addChars = words[i].length + (lineWordCount ? 1 : 0);
            if (li < weights.length - 1 && lineWordCount > 0 && lineChars + addChars > budgets[li]) {
                breaks.push(i);
                li++;
                lineChars = 0;
                lineWordCount = 0;
            }
            lineChars += addChars;
            lineWordCount++;
        }
        return breaks;
    }
    /**
     * Word-index positions (1-based into the word array, i.e. "line N starts at
     * word[breaks[N-1]]") where a new centered line should start. Empty array
     * means "keep it on one line" — the default, unshaped behaviour.
     */
    // `lines` (optional): the caller's own line count for THIS title. Presets use
    // it to ask for a tidy stacked block — a 6-word hook reads faster as three
    // short lines than two long ones, and a 3-line shape leaves a clear middle
    // line to accent. Left out, the length-based default decides exactly as
    // before, so no existing title changes shape.
    function autoTitleBreaks(text, shape, lines) {
        const words = splitWords(text);
        const want = Math.round(Number(lines));
        const n = (Number.isFinite(want) && want >= 1)
            ? Math.min(4, Math.max(1, Math.min(want, words.length)))
            : lineCountFor(words.length);
        if (n <= 1)
            return [];
        const useRhombus = shape === 'rhombus' || (shape !== 'pyramid' && n >= 3 && n % 2 === 1);
        const weights = useRhombus ? rhombusWeights(n) : pyramidWeights(n);
        return greedyBreaks(words, weights);
    }
    /** Convenience: the actual line strings, for tests/inspection. */
    function autoTitleLines(text, shape, lineCount) {
        const words = splitWords(text);
        if (!words.length)
            return [];
        const breaks = autoTitleBreaks(text, shape, lineCount);
        const lines = [];
        let start = 0;
        for (const b of breaks) {
            lines.push(words.slice(start, b).join(' '));
            start = b;
        }
        lines.push(words.slice(start).join(' '));
        return lines;
    }
    // [TITLE-FIT] A title font is sized for the ONE-LINE case (fills a
    // comfortable width at that size). Multiplying line count in without ever
    // shrinking the font is what made an auto-shaped 4-line title cover nearly
    // the whole frame ("full screen") — this scales the font DOWN as more
    // lines appear, so the total block height stays roughly constant instead
    // of growing linearly with line count. Values are deliberately NOT 1/N
    // (that would shrink too aggressively — a 2-line title would look tiny);
    // they're tuned so a 4-line title's total height is close to a 2-line
    // title's, not close to a 1-line title's.
    const FIT_SCALE = { 1: 1, 2: 0.82, 3: 0.7, 4: 0.6 };
    function autoFitScale(lineCount) {
        const n = Math.max(1, Math.min(4, Math.round(lineCount) || 1));
        return FIT_SCALE[n];
    }
    // [HOOK-WORD] The words to accent — the punchline a hook title is BUILT
    // around usually lands at the END ("Kenapa Aku Selalu GAGAL TOTAL"), so the
    // last `count` words are it. Deliberately not a hot-word dictionary lookup:
    // that scores whole PHRASES for virality (clip detection's job), not which
    // words in an already-written title read as its emphasis point. Simple and
    // predictable beats a dictionary match landing on a random earlier word.
    // A 1-word title highlights just that word — never more words than exist.
    function hookWordIndices(text, count) {
        const n = Math.max(1, Math.round(count) || 2);
        const words = splitWords(text);
        if (!words.length)
            return [];
        const start = Math.max(0, words.length - n);
        const idx = [];
        for (let i = start; i < words.length; i++)
            idx.push(i);
        return idx;
    }
    // [AUTO-TITLE] Default penempatan judul, dipakai BERSAMA oleh pipeline
    // (yang kini membuat judul otomatis) dan renderer (tombol "+ Add title" /
    // "Ke video"). Dulu angka-angka ini hidup HANYA di renderer.js dan
    // digandakan di dua tempat di sana — sudah pernah menyimpang sekali
    // (lihat catatan [TITLE-PARITY]). Di sini satu sumber untuk semuanya.
    // x/y dalam ruang kanonik 1080×1920; buildAss menskalakannya per rasio.
    const TITLE_DEFAULT_X = 540;
    const TITLE_DEFAULT_FS = 96;
    const TITLE_DEFAULT_DUR = 3.5;
    const TITLE_Y_OFFSETS = [0, 170, -170, 340, -340];
    function titleDefaultY(existingCount) {
        const n = Number(existingCount) || 0;
        return 960 + TITLE_Y_OFFSETS[n % TITLE_Y_OFFSETS.length];
    }
    // [AUTO-TITLE-REMOVED] `autoTitleFor()` / `autoTitleY()` lived here in
    // 2.3.72-beta: the pipeline used them to generate a persistent title from
    // each clip's hook text. Removed at the user's request after a real Windows
    // run put that title on top of the opening captions. The clearance rule was
    // the weak part — it picked whichever half of the frame cfg.subtitleY left
    // free, but a caption block's real height depends on how its cue wraps,
    // which the pipeline cannot know at placement time. Everything ABOVE this
    // note is about shaping a title that already exists, and is still live for
    // titles added in the Caption Editor.
    // [TITLE-INK-LEADING] Posisi tiap baris dihitung dari TINGGI TINTA, bukan
    // dari kotak em penuh.
    //
    // Kenapa: leading itu proporsional terhadap ukuran baris. Satu kata yang
    // diperbesar karena itu membawa ruang kosong sebesar (baselineEm - capHeight)
    // di ATAS huruf kapitalnya sendiri. Bukan salah penempatan: preview dan burn
    // sama-sama begitu, selisih keduanya cuma 3,1% — itulah "jarak Fbal Ini ke
    // Ternyata masih jauh".
    //
    // TERUKUR, bukan diperkirakan. Burn 1080x1920, \an8\pos(540,305), baris
    // "Fbal Ini" px79 lalu "Ternyata", dipindai pikselnya:
    //
    //                atas tinta b.2   celah tinta
    //   px79 / px79        422             37      <- acuan "normal"
    //   px79 / px200       450             65      <- 28px kelebihan
    //
    //   28px = (baselineEm - capHeight/upem) x (200 - 79) = 0.237 x 121.
    //
    // Angka "46px" di catatan pertama fungsi ini adalah hitungan kasar dari
    // pecahan yang ditebak, sebelum ada pengukuran. Yang benar 28px.
    //
    // Fungsi ini MURNI dan menerima metrik tinta sebagai MASUKAN, karena kedua
    // sisi mendapatkannya dari sumber berbeda: burn membaca tabel font, preview
    // memakai canvas measureText (actualBoundingBoxAscent/Descent). Dengan
    // begitu keduanya memakai rumus yang sama tanpa tabel yang dicerminkan —
    // tabel seperti itu selalu berakhir melenceng, lihat catatan
    // [TRACK-UNIFORM] di renderer.
    //
    // `lines`: [{ inkAscPx, inkDescPx, sizePx }] — tinta DI ATAS dan DI BAWAH
    // garis dasar, plus ukuran visual baris itu (untuk menghitung celahnya).
    // `gapEm`: celah antar baris sebagai pecahan dari ukuran baris yang LEBIH
    // KECIL di antara dua baris bertetangga — memakai yang lebih besar membuat
    // satu kata raksasa membuka jurang lagi, yang justru sedang diperbaiki.
    //
    // Mengembalikan atas-tinta setiap baris, relatif terhadap atas-tinta baris
    // pertama (jadi baris pertama selalu 0).
    // [TITLE-INK-LEADING] Pergeseran KUMULATIF tiap baris terhadap alur alaminya,
    // dalam piksel. Ini primitif yang dipakai KEDUA sisi — burn menambahkannya ke
    // atas-baris libass, preview ke alur kotak-baris CSS-nya. Satu rumus, jadi
    // keduanya tidak bisa berpisah diam-diam.
    //
    // Diturunkan dari model tinta di inkLineTops() di bawah, lalu disederhanakan:
    // dengan celah = ukuranBaris x gapEm dan inkH = ukuranBaris x (emScale-gapEm),
    // selisih antara model tinta dan model kotak-em untuk satu pasang baris jadi
    //
    //   p1 >= p0 : -leadEm x (p1 - p0)          <- kelebihan yang dibawa baris besar
    //   p1 <  p0 : (gapEm - leadEm) x (p1 - p0) <- nol untuk face yang gapEm=leadEm
    //
    // `lines`: [{ sizePx, leadEm?, gapEm? }] — atau angka ukuran saja, yang lalu
    // memakai leadEm/gapEm argumen kedua/ketiga sebagai bawaan.
    //
    // `leadEm`: jarak atas-kotak-baris ke atas-KAPITAL, pecahan ukuran baris.
    //   burn    = baselineEm - capHeight/upem (libass memenuhi Fontsize dengan
    //             usWinAscent+usWinDescent, jadi baseline duduk winAsc di bawah).
    //   preview = (LH - (asc+desc))/2 + asc - capHeight, yaitu half-leading CSS.
    //   Masing-masing memakai angkanya SENDIRI: itu membuat pergeseran tiap sisi
    //   tepat untuk geometri barisnya sendiri. Terukur, memaksa preview memakai
    //   angka burn justru MEMPERBESAR selisih (6,6px tetap, vs 4,4px).
    // `gapEm`: celah antar baris seukuran sama = LH/emScale dikurangi tinggi tinta.
    //
    // Baris pertama selalu 0 — jangkar judul tidak pernah bergeser.
    function inkLeadOffsets(lines, leadEm, gapEm) {
        const dLead = Number.isFinite(+leadEm) ? +leadEm : 0;
        const dGap = Number.isFinite(+gapEm) ? +gapEm : dLead;
        // Tiap baris boleh membawa lead/gap-nya SENDIRI. Judul bisa mengganti font
        // per kata, dan lead itu sifat FACE: Anton 0.545 lawan Open Sauce Two 0.237.
        // Versi pertama fungsi ini hanya menerima satu lead untuk seluruh judul, dan
        // baris ber-face lain jadi meleset 61,5px dari sasaran modelnya sendiri.
        const L = (lines || []).map((v) => {
            const o = (v && typeof v === 'object') ? v : { sizePx: v };
            const lead = Number.isFinite(+o.leadEm) ? +o.leadEm : dLead;
            const gap = Number.isFinite(+o.gapEm) ? +o.gapEm : dGap;
            return { p: +o.sizePx || 0, lead, gap };
        });
        const out = [];
        let acc = 0;
        for (let i = 0; i < L.length; i++) {
            if (i > 0) {
                const a = L[i - 1], b = L[i];
                // Diturunkan dari model tinta, dengan lead/gap per baris:
                //
                //   membesar  : lead_a x p_a - lead_b x p_b
                //   mengecil  : (lead_a - gap_a) x p_a - (lead_b - gap_b) x p_b
                //
                // Untuk satu face keduanya menyusut jadi bentuk lama persis
                // (-lead x dp dan (gap-lead) x dp), jadi angka terukur 374 tetap.
                const step = (b.p >= a.p)
                    ? (a.lead * a.p - b.lead * b.p)
                    : ((a.lead - a.gap) * a.p - (b.lead - b.gap) * b.p);
                // MERAPATKAN saja, tidak pernah merenggangkan. Terukur: dua face
                // (TimesNewRomanMTStd BoldCondensed dan CondensedItalic) punya
                // gap - lead negatif, jadi arah mengecil justru menambah 4,5px — fitur
                // "perapatan" yang merenggangkan. Dan lead baris pertama yang lebih
                // besar dari baris kedua bisa memberi langkah positif juga.
                acc += Math.min(0, step);
            }
            out.push(acc);
        }
        return out;
    }
    function inkLineTops(lines, gapEm) {
        const gp = Number.isFinite(+gapEm) ? +gapEm : 0.18;
        const out = [];
        let y = 0;
        for (let i = 0; i < (lines || []).length; i++) {
            const L = lines[i] || {};
            if (i > 0) {
                const prev = lines[i - 1] || {};
                const smaller = Math.min(+prev.sizePx || 0, +L.sizePx || 0);
                y += (+prev.inkAscPx || 0) + (+prev.inkDescPx || 0) + gp * smaller;
            }
            out.push(Math.round(y));
        }
        return out;
    }
    // [TITLE-LINE-GEOM] Pergeseran tegak tiap baris judul di PREVIEW, dalam satuan
    // kanonik yang sama dengan `sizePx`.
    //
    // Preview memakai kotak-baris CSS (`line-height`, satu angka untuk semua face)
    // sementara libass memakai usWinAscent+usWinDescent milik face itu. Untuk Anton
    // (emScale 1,7334 lawan 1,2) itu ~42px selisih PER BARIS. Fungsi ini meniru
    // model libass, lalu membatalkan tata letak CSS-nya; hasilnya dipasang sebagai
    // `top` pada pembungkus baris (position:relative, jadi alurnya tak berubah).
    //
    // `lines`: [{ sizePx, emScale, baselineEm, capEm, descEm, cssLeadEm }]
    //   sizePx    ukuran baris (kata terbesarnya), satuan kanonik
    //   emScale   (winAsc+winDesc)/upem — jarak antar baris libass per px
    //   baselineEm winAsc/upem — baseline di bawah jangkar atas \an8
    //   capEm     tinggi kapital (OS/2 sCapHeight, atau yMax glyph 'H')
    //   descEm    -hhea.descender/upem
    //   cssLeadEm jarak atas kotak-baris CSS ke atas kapital, diukur canvas:
    //             (LH - (fbAsc+fbDesc))/2 + fbAsc - capEm
    // `cssLineHeight`: angka line-height yang BENAR-BENAR dipakai CSS-nya.
    //
    // Terukur di tiap langkah — lihat catatan di computeLineTops (renderer.js).
    function titleLineTopsCss(lines, cssLineHeight) {
        const L = Array.isArray(lines) ? lines : [];
        if (!L.length)
            return [];
        const LH = Number.isFinite(+cssLineHeight) ? +cssLineHeight : 1.2;
        const offs = inkLeadOffsets(L.map((l) => ({
            sizePx: +l.sizePx || 0,
            leadEm: (+l.baselineEm || 0) - (+l.capEm || 0),
            gapEm: (+l.emScale || 0) - ((+l.capEm || 0) + (+l.descEm || 0)),
        })));
        const out = [];
        let wantBox = 0, haveBox = 0;
        for (let i = 0; i < L.length; i++) {
            if (i > 0) {
                wantBox += (+L[i - 1].sizePx || 0) * (+L[i - 1].emScale || 0);
                haveBox += (+L[i - 1].sizePx || 0) * LH;
            }
            const p = +L[i].sizePx || 0;
            const wantInk = wantBox + (offs[i] || 0) + ((+L[i].baselineEm || 0) - (+L[i].capEm || 0)) * p;
            const haveInk = haveBox + (+L[i].cssLeadEm || 0) * p;
            out.push(wantInk - haveInk);
        }
        return out;
    }
    // [EVENT-WINDOW] Jendela waktu EFEKTIF satu event overlay — judul maupun
    // manual caption. Satu definisi, dipakai burn DAN preview.
    //
    // Kenapa perlu: rentang bisa jadi tidak masuk akal (start dinaikkan melewati
    // end, durasi nol, end hilang), dan sebelum ini kedua sisi menanganinya dengan
    // cara BERBEDA. Terukur pada buildAss lawan logika tampil preview:
    //
    //   start 5, end 2   burn kedip 0,05s   preview TIDAK tampil
    //   start 3, end 3   burn kedip 0,05s   preview TIDAK tampil
    //   start 2, end -   burn kedip 0,05s   preview tampil SELAMANYA (|| 1e9)
    //
    // Sekarang keduanya memakai jendela yang sama, jadi data seburuk apa pun
    // tetap terlihat sama di preview dan di render.
    //
    // 0,05s itu lantai TERAKHIR, bukan minimum yang seharusnya dibuat UI: jalur
    // penulisannya sendiri menjaga minimum 0,1s untuk nilai yang diketik dan 0,3s
    // untuk hasil drag di lane (lantai ergonomi, supaya barnya masih bisa dipegang).
    const MIN_EVENT_SEC = 0.05;
    function eventWindow(start, end) {
        const s = Math.max(0, +start || 0);
        return { start: s, end: Math.max(s + MIN_EVENT_SEC, +end || 1) };
    }
    const api = {
        autoTitleBreaks, autoTitleLines, autoFitScale, hookWordIndices,
        titleDefaultY, TITLE_DEFAULT_X, TITLE_DEFAULT_FS, TITLE_DEFAULT_DUR,
        inkLineTops, inkLeadOffsets, titleLineTopsCss,
        eventWindow, MIN_EVENT_SEC,
    };
    if (typeof module !== 'undefined' && module.exports)
        module.exports = api;
    else
        root.TitleLayout = api;
})(typeof self !== 'undefined' ? self : this);
