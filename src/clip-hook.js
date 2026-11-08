// Generated from backend/src/clip-hook.ts by scripts/backend.cjs. Edit the TypeScript source.
'use strict';
// [CLIP-HOOK] The on-video hook text, separate from the clip TITLE.
//
// Pattern studied from a competitor's 40 real clips (ATM: idea, not code):
// the title is a headline ("Kerokan Bisa Serangan Jantung? Bahaya!") but the
// hook on the video is 2–4 words in capitals, built on the clip's ONE subject,
// often a question or an exclamation:
//   KENAPA GILANG GAGAL VISA?   KEROKAN DI DADA?   BAHAYA NAHAN PIPIS!
//   3 MENIT PERTAMA!            MESSI ATAU RONALDO? KURANG TIDUR?
// Theirs also showed cut-off hooks ("JALAN INDONESIA DI", "ONLYFANS BROKE A")
// from a blind character cap. Ours is word-based and never ends on a
// connector, so it is always a complete phrase.
//
// Pure module: no AI, no I/O. Used when no AI hook came back, and to clean
// whatever the AI did return.
const STOP = new Set(('yang dan di ke dari itu ini aku saya gua gue lu lo kamu dia kita kami mereka untuk dengan karena jadi ada juga tapi aja saja sih kok nya pun lagi udah sudah akan bisa kalau kalo atau ya iya nah tuh padahal loh sih sekitar kira-kira hampir deh dong kan lah eh ee em hmm oke ok gitu gini kayak kaya banget sangat lebih paling sama terus trus abis habis mau ingin harus pas waktu nanti tadi masih belum enggak nggak gak ga tidak bukan apa siapa mana bagaimana gimana kenapa mengapa ketika saat sekarang udah emang memang aja benar bener sebenarnya ternyata soalnya biar supaya agar sampai hingga oleh pada dalam luar atas bawah setelah sebelum orang hal cara banyak semua setiap sendiri bikin buat ngomong bilang kata kasih punya yaitu adalah merupakan sebuah suatu salah the a an to of and is are was were be been in on at it that this for you i we they he she me my your our so but or as with from by about just like really very then than there here what when how why who which can could would should will do did does not no yes oh uh um yeah okay right well also im ive id ill youre youve hes shes its thats theres lets dont doesnt didnt cant wont isnt arent him her his hers them their me us gonna wanna gotta got get go going went come bro guys man dude lol oh ah'.split(' ')));
const CONNECTOR_END = new Set(('di ke dari dan atau yang untuk dengan pada dalam the a an of to and or in on at for with from by but tapi karena jadi kalau'.split(' ')));
const FILLER = /\b(eh+|ee+|em+|hmm+|uh+|um+|anu|apa namanya|gitu loh|you know|i mean)\b/gi;
const DANGER_ID = /\b(bahaya|berbahaya|jangan|risiko|resiko|mati|meninggal|kematian|serangan|kanker|racun|celaka|darurat|fatal|kecelakaan|stroke|infeksi|penyakit|rusak|gagal ginjal)\b/i;
const DANGER_EN = /\b(danger|dangerous|never|risk|deadly|death|died|kill|poison|emergency|fatal|cancer|stroke|infection|disease)\b/i;
const WHY_ID = /\b(kenapa|mengapa|alasan|gara-gara|penyebab)\b/i;
const WHY_EN = /\b(why|reason|because of|cause)\b/i;
const HOW_ID = /\b(gimana|bagaimana|cara)\b/i;
const HOW_EN = /\b(how to|how did|how do|how)\b/i;
// [..] / (..) are transcript annotations ([tertawa], [musik], (berdehem)), never speech.
const clean = (s) => String(s || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
const wordsOf = (s) => clean(s).split(/\s+/).filter(Boolean);
const bare = (w) => String(w || '').toLowerCase().replace(/[^\p{L}\p{N}-]/gu, ''); // "let's" -> lets
// Rank 1–3 word phrases by frequency × specificity. Names (capitalised mid-
// sentence) and numbers count extra: the competitor's best hooks are almost
// always "<name/thing> + twist".
function keyphrases(text, { max = 5 } = {}) {
    const raw = wordsOf(text);
    const toks = raw.map((w, i) => ({ w: w.replace(/[^\p{L}\p{N}'%-]/gu, ''), b: bare(w), cap: i > 0 && /^\p{Lu}/u.test(w) && !/[.!?]$/.test(raw[i - 1] || ''), num: /\d/.test(w) }))
        .filter((t) => t.b);
    const score = new Map();
    const add = (key, display, s) => {
        const cur = score.get(key) || { display, s: 0, n: 0 };
        cur.s += s;
        cur.n++;
        score.set(key, cur);
    };
    for (let i = 0; i < toks.length; i++) {
        for (let n = 1; n <= 3 && i + n <= toks.length; n++) {
            const g = toks.slice(i, i + n);
            if (STOP.has(g[0].b) || STOP.has(g[g.length - 1].b))
                continue;
            if (g.some((t) => t.b.length < 2))
                continue;
            const content = g.filter((t) => !STOP.has(t.b));
            if (!content.length)
                continue;
            const bonus = g.reduce((a, t) => a + (t.cap ? 1.2 : 0) + (t.num ? 0.8 : 0), 0);
            add(g.map((t) => t.b).join(' '), g.map((t) => t.w).join(' '), (1 + 0.35 * (n - 1)) * (1 + bonus) * Math.min(1.6, 0.5 + content[0].b.length / 8));
        }
    }
    return [...score.values()].filter((x) => x.n >= 1)
        .map((x) => ({ phrase: x.display, score: x.s * (x.n > 1 ? 1 + Math.log(x.n) : 1) }))
        .sort((a, b) => b.score - a.score).slice(0, max);
}
// Capitals, no emoji/quotes, ≤4 words, never ending on a connector.
function normalizeHookText(s, { maxWords = 4 } = {}) {
    let t = String(s || '').replace(/^[\s,.;:!?-]+/, '').replace(/["“”'‘’]/g, '').replace(/[\p{Extended_Pictographic}‍️]/gu, '').replace(/\s+/g, ' ').trim();
    if (!t)
        return '';
    const punct = /[?!]$/.test(t) ? t.slice(-1) : '';
    let ws = t.replace(/[.,;:?!]+$/g, '').split(' ').filter(Boolean);
    if (ws.length > maxWords)
        ws = ws.slice(0, maxWords);
    while (ws.length > 1 && (CONNECTOR_END.has(bare(ws[ws.length - 1])) || /^(itu|ini|tuh|nih|sih|ya|kan|dong|deh)$/i.test(bare(ws[ws.length - 1]))))
        ws.pop();
    if (!ws.length)
        return '';
    return (ws.join(' ') + punct).toUpperCase();
}
// Strip leading fillers/stop words so a quoted phrase starts on substance.
function trimLead(ws, keepQ) {
    const Q = /^(kenapa|mengapa|gimana|bagaimana|siapa|apa|why|how|what|who)$/i;
    while (ws.length > 1 && STOP.has(bare(ws[0])) && !(keepQ && Q.test(bare(ws[0]))))
        ws.shift();
    return ws;
}
// The first real question spoken in the clip's opening, e.g.
// "kenapa Gilang gagal visa?" -> KENAPA GILANG GAGAL VISA?
function spokenQuestion(opener) {
    const sentences = opener.split(/(?<=[.!?])\s+/);
    for (const sen of sentences) {
        if (!/\?$/.test(sen.trim()))
            continue;
        let ws = trimLead(sen.replace(/\?+$/, '').split(/\s+/).filter(Boolean), true);
        // Start at a question word when there is one ("so how did you…" -> "how did…").
        const qi = ws.findIndex((w) => /^(kenapa|mengapa|gimana|bagaimana|siapa|why|how|what|who)$/i.test(bare(w)));
        if (qi > 0)
            ws = ws.slice(qi);
        // A spoken question keeps its own grammar (up to 5 words, like
        // "HOW DID YOU GET CAST?"); longer ones are too long to read in 3 s.
        const content = ws.filter((w) => !STOP.has(bare(w)));
        if (content.length >= 1) {
            let head = ws.slice(0, 5);
            while (head.length > 2 && CONNECTOR_END.has(bare(head[head.length - 1])))
                head.pop();
            if (head.filter((w) => !STOP.has(bare(w))).length >= 1)
                return normalizeHookText(`${head.join(' ')}?`, { maxWords: 5 });
        }
    }
    return '';
}
// Hook from the clip's own words when no AI hook exists.
function localHookText(text, lang = 'id') {
    const t = clean(text);
    if (!t)
        return '';
    const en = lang === 'en';
    const opener = t.split(/\s+/).slice(0, 45).join(' ');
    // 1. "X atau Y?" / "X vs Y" spoken as such.
    const vs = opener.match(/(\p{L}[\p{L}\p{N}-]*(?:\s+\p{L}[\p{L}\p{N}-]*)?)\s+(atau|vs\.?|versus|or)\s+(\p{L}[\p{L}\p{N}-]*)\s*\?/iu);
    if (vs && !STOP.has(bare(vs[1].split(' ').pop())) && !STOP.has(bare(vs[3]))) {
        const left = vs[1].split(' ').filter((w) => !STOP.has(bare(w))).slice(-1)[0] || vs[1];
        return normalizeHookText(`${left} ${en ? 'or' : 'atau'} ${vs[3]}?`);
    }
    // 2. A question actually asked in the opening.
    const q = spokenQuestion(opener);
    const kp = keyphrases(t, { max: 4 });
    let core = kp.length ? kp[0].phrase.split(/\s+/).slice(0, 3).join(' ') : '';
    if (q && q.split(' ').length >= 2)
        return q;
    // 3. A number with its unit and the word after it ("3 menit pertama").
    const num = t.match(/\b(\d+(?:[.,]\d+)?)\s+(menit|detik|jam|hari|minggu|bulan|tahun|juta|ribu|miliar|kali|persen|minutes?|hours?|days?|weeks?|months?|years?|million|thousand|times|usd|dolar|dollars?|rupiah|euro|januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)(?:\s+(\p{L}+))?/iu);
    if (num) {
        const tail = num[3] && !STOP.has(bare(num[3])) ? ` ${num[3]}` : '';
        return normalizeHookText(`${num[1]} ${num[2]}${tail}!`);
    }
    if (!core)
        return '';
    // A lone short word ("TANGGAL", "JAM") is not a hook — take the best
    // multi-word phrase instead, or give up so the title is used.
    if (core.split(' ').length === 1 && core.length < 7) {
        const multi = kp.find((k) => k.phrase.split(/\s+/).length >= 2);
        if (!multi)
            return '';
        core = multi.phrase.split(/\s+/).slice(0, 3).join(' ');
    }
    // Danger framing only when the danger is what the clip OPENS on.
    if ((en ? DANGER_EN : DANGER_ID).test(opener))
        return normalizeHookText(`${en ? 'danger' : 'bahaya'} ${core}!`);
    if ((en ? WHY_EN : WHY_ID).test(opener))
        return normalizeHookText(`${en ? 'why' : 'kenapa'} ${core}?`);
    if ((en ? HOW_EN : HOW_ID).test(opener))
        return normalizeHookText(`${en ? 'how' : 'cara'} ${core}?`);
    return normalizeHookText(core);
}
// [HOOK-GATE] Same gate as the SOCL Worker (cloud/asr-worker/src/index.js) —
// keep the two in sync; test/clip-hook.test.js checks they agree.
const HOOK_VOCAB = new Set(('mengapa kau kamu lu elo gue aku kita mereka dia tetap tetep masih untuk kalo kalau dan di ke dari dengan biar supaya agar tanpa sih dong deh loh ya yg tuh nih gak ga bukan lho emang memang aja bahaya berbahaya jangan stop salah bukan gila ngeri pantesan ternyata serius rahasia mitos fakta beneran doang percuma tebak kata dokter baru tau tahu cuma kenapa gimana siapa berapa awas wajib harus bisa gak nggak enggak bikin cara bedanya beda lebih paling banget banyak sedikit kurang lagi masih udah sudah semua selama orang kamu kalian lo gue aku kita pakai pake pakek jadi sama atau vs versus pov kok aja buat yang nya ini itu ada tanpa kalau never stop why how what who secret myth truth wrong never only just really your you this that the and or not').split(' '));
const FLAT_HOOK = /^(apa itu|ini dia|fakta menarik|wajib tau|wajib tahu|simak|tonton)\b|^(\S+ ){0,3}(beda|berbeda|apa|penting)[?!]?$/i;
// A hook needs a PUNCH: a ?/!, a trigger word, or a leading number.
const POWER = new Set(('bahaya jangan stop salah bukan gila ngeri pantesan ternyata serius rahasia mitos beneran doang percuma tebak awas wajib kenapa gimana berapa cuma baru pov kok never why how secret myth truth wrong only').split(' '));
const stemOf = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function inText(w, hay) {
    const x = stemOf(w);
    if (!x)
        return true;
    if (/^\d+$/.test(x))
        return hay.includes(x);
    const core = x.replace(/^(meng|meny|mem|men|me|di|ber|ter|ke|se|nge|ng)/, '').replace(/(nya|kan|an|in|lah|kah)$/, '');
    if (hay.includes(x) || (core.length >= 4 && hay.includes(core)))
        return true;
    // Auto-captions spell loan words loosely ("gargle"/"gargel"): one edit away counts.
    if (x.length >= 5)
        for (const h of hay.split(' '))
            if (Math.abs(h.length - x.length) <= 1 && near1(h, x))
                return true;
    return false;
}
function near1(a, b) {
    let i = 0, j = 0, d = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            i++;
            j++;
            continue;
        }
        if (++d > 1)
            return false;
        if (a.length > b.length)
            i++;
        else if (b.length > a.length)
            j++;
        else {
            i++;
            j++;
        }
    }
    return d + (a.length - i) + (b.length - j) <= 1;
}
function hookQuality(row, transcript, topic = '', { strict = false } = {}) {
    const hay = ` ${String(transcript + ' ' + topic).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
    const hw = String(row.hook || '').split(/\s+/).filter(Boolean);
    const tw = String(row.title || '').split(/\s+/).filter(Boolean);
    if (hw.length < 2 || hw.length > 6)
        return 'hook_len';
    if (tw.length < 4 || tw.length > 16)
        return 'title_len';
    if (FLAT_HOOK.test(String(row.hook).trim()))
        return 'flat';
    if (/[^\p{L}\p{N}\s?!,.:&'-]/u.test(String(row.hook)))
        return 'symbol';
    if (!/[?!]$/.test(String(row.hook).trim()) && !hw.some((w) => POWER.has(stemOf(w))) && !/^\d/.test(hw[0]))
        return 'no_punch';
    // Every hook word is either from the clip/video or common hook vocabulary:
    // catches typos and invented subjects in one rule.
    // One everyday word the speaker did not say ("wajah" for "muka") is fine;
    // a short garble ("GAU") or two+ outside words means typo or invention.
    const alien = hw.filter((w) => stemOf(w).length >= 3 && !HOOK_VOCAB.has(stemOf(w)) && !inText(w, hay));
    // Up to two everyday outside words when the clip's own words carry the hook
    // (the judge then checks meaning); a short garble is always rejected.
    const grounded = hw.filter((w) => stemOf(w).length >= 3 && !HOOK_VOCAB.has(stemOf(w)) && inText(w, hay)).length;
    const allow = strict ? 0 : grounded >= 2 ? 2 : 1;
    if (alien.length > allow || alien.some((w) => stemOf(w).length < 4))
        return `alien:${stemOf(alien[0])}`;
    if (!hw.some((w) => stemOf(w).length >= 3 && !HOOK_VOCAB.has(stemOf(w)) && inText(w, hay)))
        return 'no_subject';
    if (tw.filter((w) => stemOf(w).length >= 4 && !HOOK_VOCAB.has(stemOf(w)) && inText(w, hay)).length < 2)
        return 'title_ungrounded';
    if (stemOf(row.hook) === stemOf(row.title))
        return 'hook_is_title';
    return '';
}
// ============================================================================
// [SOCL-HOOK-V2] Local viral-hook formula — no AI, free, unlimited.
// Ideas (not text) from hook-writing playbooks: a hook is a PHRASE, not a
// sentence; it flips a belief, opens a gap, raises stakes, leads with a number
// or names an authority. Everything is pulled from what the clip SAYS:
//   • the SUBJECT  = the clip's most distinctive words (TF-IDF vs the video)
//   • the TRIGGER  = "stopword" markers that signal a twist or a warning —
//                    padahal / ternyata / justru / bukan…tapi / jangan / awas
//   • the EMOTION  = a viral-emotion lexicon (fear, shame, money, health, love)
// Candidates from every archetype are scored and the best that passes
// hookQuality() wins. Pure function; tuned on real SOCL session transcripts.
// ============================================================================
const EMO = new Map(Object.entries({
    // fear / health / danger
    bahaya: 3, berbahaya: 3, mati: 3, meninggal: 3, kematian: 3, kanker: 3, stroke: 3, racun: 3, keracunan: 3, celaka: 3, lumpuh: 3, buta: 2, infeksi: 2,
    penyakit: 2, sakit: 1.5, nyeri: 1.5, alergi: 2, keropos: 2, rusak: 2, takut: 2, serem: 2, seram: 2, ngeri: 2.5, horor: 2, trauma: 2.5, depresi: 2.5, stres: 1.5,
    // shock / emotion
    kaget: 2, syok: 2, nangis: 2.5, menangis: 2.5, marah: 2, emosi: 1.5, malu: 2, nyesel: 2.5, menyesal: 2.5, kecewa: 2, sedih: 2, bangga: 1.5, gila: 2, parah: 2,
    aneh: 1.5, lucu: 1.5, ngakak: 2, bohong: 2.5, tipu: 2.5, penipuan: 2.5, rahasia: 2, mitos: 2.5, salah: 1.5, keliru: 1.5, fakta: 1, viral: 1.5, heboh: 2,
    // money / status
    gaji: 2, utang: 2.5, hutang: 2.5, bangkrut: 3, miliar: 2.5, triliun: 2.5, juta: 1.5, kaya: 2, miskin: 2, dipecat: 3, pecat: 2.5, mahal: 1.5, gratis: 1.5, murah: 1,
    // love / family / conflict
    cerai: 3, selingkuh: 3, putus: 2, mantan: 2, nikah: 1.5, pacar: 1.5, istri: 1, suami: 1, ibu: 1, ayah: 1, anak: 1, berantem: 2, ribut: 2, dibully: 2.5,
    // english
    danger: 3, dead: 3, died: 3, death: 3, cancer: 3, scared: 2, shocked: 2, cried: 2.5, crying: 2.5, angry: 2, ashamed: 2, regret: 2.5, secret: 2, lie: 2.5, lied: 2.5,
    myth: 2.5, wrong: 1.5, broke: 2.5, fired: 3, million: 2, billion: 2.5, rich: 2, divorce: 3, cheated: 3, crazy: 2, insane: 2, never: 1,
}));
const FLIP_RE = /\b(padahal|ternyata|justru|sebenarnya|sebenernya|malah|rupanya|actually|turns out|in fact)\b/i;
const BUT_RE = /\bbukan\b(.{2,40}?)\b(tapi|tetapi|melainkan)\b/i;
const STAKES_RE = /\b(jangan|awas|gak boleh|nggak boleh|enggak boleh|tidak boleh|dilarang|stop|hindari|never|don'?t|stop)\b/i;
const FILLER_W = new Set('eh ee em hmm uh um anu ya iya yah nah tuh kan sih dong deh loh lho gitu gini kayak kaya jadi terus trus oke ok oh wah wih ha hah dok dokter pak bu bang kak bro mas mbak guys gais cuy coy tu teh'.split(' '));
const PRONOUN = new Set('aku saya gue gua gw lu lo elo kamu kau dia kita kami mereka i you we they he she'.split(' '));
const Q_WORD = /^(kenapa|mengapa|gimana|bagaimana|apa|apakah|siapa|berapa|kapan|dimana|bisa|boleh|beneran|emang|masa|why|how|what|who|which|can|is|are|do|does|should)$/;
// A hook must not end on a word that needs its complement ("TANGGAL", "SAMA").
const NEEDS_MORE = new Set('kena tanggal jam nomor sama kayak kaya seperti lebih paling mau bakal biar buat untuk pas waktu'.split(' '));
// Everyday verbs/adverbs: frequent in a clip but never its SUBJECT.
const GENERIC = new Set(('boleh bisa mau tau tahu kemudian berarti real besok mungkin maksudnya maksud pakai makai bikin kasih ambil ngambil lihat liat ngeliat tanya nanya dateng datang pergi pulang tadi nanti sekarang kemarin hari orang semua lagi banget kali emang beneran cuma cuman doang bener benar gede kecil baik bagus jelek pas kayaknya kayanya pokoknya intinya sebenarnya sebenernya ngomong bilang dibilang denger dengar kerja main mulai abis selesai coba cobain tetap tetep pernah sering jarang lama sebentar langsung tiba tiba-tiba berapa segini segitu begitu begini harus perlu ngerti paham inget ingat lupa suka senang seneng enak nggak enggak gak ga bukan iya ya oke'.split(' ')));
const sentencesOf = (t) => clean(t).replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.split(' ').length >= 3);
const dedupeStutter = (ws) => ws.filter((w, i) => i === 0 || bare(w) !== bare(ws[i - 1]));
// IDF over ~60 s chunks of the whole video, so a word every chunk repeats
// (the show's name, "dok") is not mistaken for this clip's subject.
function idfTable(corpus) {
    const chunks = [];
    const words = clean(corpus).toLowerCase().split(/\s+/);
    for (let i = 0; i < words.length; i += 150)
        chunks.push(new Set(words.slice(i, i + 150).map(bare)));
    const N = Math.max(1, chunks.length);
    return (w) => { let df = 0; for (const c of chunks)
        if (c.has(w))
            df++; return Math.log(1 + N / (1 + df)); };
}
function subjectTerms(text, idf) {
    const ws = wordsOf(text).map(bare).filter((w) => w.length >= 3 && !STOP.has(w) && !FILLER_W.has(w) && !PRONOUN.has(w) && !GENERIC.has(w) && !/^\d+$/.test(w));
    const tf = new Map();
    for (const w of ws)
        tf.set(w, (tf.get(w) || 0) + 1);
    return [...tf].map(([w, n]) => [w, Math.min(n, 4) * (idf ? idf(w) : 1) * (EMO.has(w) ? 1.3 : 1)]).sort((a, b) => b[1] - a[1]).slice(0, 8);
}
// Compress a clause to a ≤5-word phrase that still carries the subject.
function compress(clause, subj, maxW = 5) {
    let ws = dedupeStutter(clause.replace(/[,;:]+/g, ' , ').split(/\s+/).filter(Boolean));
    // Stop at the first clause break: a hook is ONE thought.
    const brk = ws.findIndex((w, i) => i > 1 && (w === ',' || /^(tapi|terus|trus|cuma|cuman|soalnya|karena|kalau|kalo|jadi|and|but|so|because)$/i.test(bare(w))));
    if (brk > 0)
        ws = ws.slice(0, brk);
    ws = ws.filter((w) => w !== ',' && !FILLER_W.has(bare(w)));
    while (ws.length && (STOP.has(bare(ws[0])) || PRONOUN.has(bare(ws[0]))))
        ws.shift();
    ws = ws.slice(0, maxW);
    while (ws.length > 1 && (CONNECTOR_END.has(bare(ws[ws.length - 1])) || STOP.has(bare(ws[ws.length - 1])) || PRONOUN.has(bare(ws[ws.length - 1])) || NEEDS_MORE.has(bare(ws[ws.length - 1]))))
        ws.pop();
    return ws.map((w) => w.replace(/[^\p{L}\p{N}%'-]/gu, '')).filter(Boolean);
}
function viralHookCandidates(text, { lang = 'id', corpus = '', topic = '' } = {}) {
    const en = lang === 'en';
    const idf = corpus ? idfTable(corpus) : null;
    const subjList = subjectTerms(text, idf);
    const subj = new Map(subjList);
    const top5 = new Set(subjList.slice(0, 5).map(([w]) => w));
    const sents = sentencesOf(text);
    const out = [];
    const add = (type, words, punct, sIdx, bonus = 0) => {
        const ws = words.filter(Boolean);
        if (ws.length < 2)
            return;
        const hook = normalizeHookText(ws.join(' ') + punct, { maxWords: 6 });
        if (!hook)
            return;
        const hw = hook.replace(/[?!]$/, '').split(' ').map(bare);
        if (new Set(hw).size < hw.length)
            return; // "TAMAN TAMAN"
        const subjHit = hw.reduce((a, w) => a + (subj.get(w) || 0), 0);
        // The clip's OWN subject (top-5 distinctive words) must be in the hook.
        if (!hw.some((w) => top5.has(w)))
            return;
        const emo = hw.reduce((a, w) => a + (EMO.get(w) || 0), 0);
        const stopShare = hw.filter((w) => STOP.has(w) || PRONOUN.has(w)).length / hw.length;
        const lenFit = hw.length >= 3 && hw.length <= 5 ? 1 : 0.4;
        const early = sIdx == null ? 0.3 : Math.max(0, 1 - sIdx / Math.max(4, sents.length)) * 0.8;
        const score = 1.6 * Math.min(3, emo) + 1.2 * Math.min(4, subjHit) + lenFit + early + bonus - 2.5 * stopShare;
        out.push({ hook, type, score: +score.toFixed(3) });
    };
    sents.forEach((s, i) => {
        const low = s.toLowerCase();
        // FLIP — "padahal / ternyata / justru …": the twist is the hook.
        const fm = low.match(FLIP_RE);
        if (fm) {
            const after = s.slice(fm.index + fm[0].length);
            const lead = /^(padahal|justru|malah)$/i.test(fm[1]) ? (en ? 'actually' : 'padahal') : (en ? 'turns out' : 'ternyata');
            add('FLIP', [lead, ...compress(after, subj, 5)], '!', i, 1.2);
        }
        // BUKAN X TAPI Y — the correction.
        const bm = s.match(BUT_RE);
        if (bm)
            add('FLIP', [...compress(bm[1], subj, 2), 'bukan', ...compress(s.slice(bm.index + bm[0].length), subj, 3)].slice(0, 6), '!', i, 1.3);
        // STAKES — "jangan / awas / gak boleh …".
        const sm = low.match(STAKES_RE);
        if (sm) {
            const obj = compress(s.slice(sm.index + sm[0].length), subj, 4);
            if (obj.length >= 2)
                add('STAKES', [en ? 'never' : 'jangan', ...obj], '!', i, 1.1);
        }
        // QUESTION — a spoken question, only if it names the subject.
        if (/\?$/.test(s)) {
            const q = spokenQuestion(s);
            const qw = q ? q.replace(/\?$/, '').split(' ').filter((w) => !FILLER_W.has(bare(w))) : [];
            while (qw.length > 2 && NEEDS_MORE.has(bare(qw[qw.length - 1])))
                qw.pop();
            // A real question word up front, or "X ATAU Y" — "SYUTING PAGI TU?" is not a hook.
            if (qw.length && (Q_WORD.test(bare(qw[0])) || qw.some((w) => /^(atau|or|vs)$/i.test(bare(w)))))
                add('GAP', qw, '?', i, 0.9);
        }
        // REACTION — the speaker's own disbelief ("serius?", "masa sih").
        const rm = low.match(/\b(serius|beneran|masa sih|demi apa|hah|seriously|wait what|no way)\b/i);
        if (rm) {
            const near = compress(s.slice(rm.index + rm[0].length), subj, 4);
            const prev = i > 0 ? compress(sents[i - 1], subj, 4) : [];
            const body = near.some((w) => top5.has(bare(w))) ? near : prev;
            add('REACTION', [en ? 'seriously' : 'serius', ...body], '?', i, 1.0);
        }
        // STORY — a first-time / before story.
        const stm = low.match(/\b(pertama kali|first time|waktu (aku|gue|saya) kecil|dulu (aku|gue|saya))\b/i);
        if (stm)
            add('STORY', [en ? 'first time' : 'pertama kali', ...compress(s.slice(stm.index + stm[0].length), subj, 4)], '!', i, 0.9);
        // NUMBER — a number with its unit, anchored to the subject.
        const nm = s.match(/\b(\d+(?:[.,]\d+)?)\s*(%|persen|menit|detik|jam|hari|minggu|bulan|tahun|kilo|kg|km|juta|ribu|miliar|kali|langkah|kalori|minutes?|hours?|days?|years?|million|billion|times|steps|calories)\b/i);
        if (nm) {
            const rest = compress(s.slice(nm.index + nm[0].length), subj, 3);
            const before = compress(s.slice(0, nm.index).split(/\s+/).slice(-3).join(' '), subj, 3);
            const hasTop = (ws) => ws.some((w) => top5.has(bare(w)));
            // Only the side that carries the clip's subject: "MENDAKI 19 HARI", never "2 KILO YOYOGI".
            const side = hasTop(rest) ? rest.slice(0, 3) : hasTop(before) ? before.filter((w) => top5.has(bare(w)) || EMO.has(bare(w))) : null;
            if (side && side.length)
                add('NUMBER', [nm[1], nm[2], ...side].slice(0, 5), '!', i, 1.0);
        }
        // EMOTION — the emotional word with its subject, as said.
        const ews = s.split(/\s+/);
        const ei = ews.findIndex((w) => (EMO.get(bare(w)) || 0) >= 2 && !/^(gila|parah|crazy|insane)$/i.test(bare(w)));
        if (ei >= 0)
            add('EMOTION', compress(ews.slice(Math.max(0, ei - 2), ei + 3).join(' '), subj, 5), '!', i, 0.8);
    });
    // QUOTE — the clip's punchiest sentence, compressed: subject + emotion/number.
    sents.forEach((s, i) => {
        const ws = s.split(/\s+/);
        for (let k = 0; k < ws.length; k++) {
            if (!top5.has(bare(ws[k])))
                continue;
            const span = compress(ws.slice(Math.max(0, k - 2), k + 4).join(' '), subj, 5);
            const hasPunch = span.some((w) => (EMO.get(bare(w)) || 0) >= 2);
            if (span.length >= 3 && hasPunch)
                add('QUOTE', span, '!', i, 0.3);
        }
    });
    // GAP fallback — "KENAPA <phrase>?" with a phrase the clip actually says,
    // only when the clip explains a cause.
    // Only noun-like phrases: no pronouns, generic words or verb forms ("siapkan", "kirimnya").
    const nounish = (w) => { const b = bare(w); return b.length >= 3 && !STOP.has(b) && !PRONOUN.has(b) && !GENERIC.has(b) && !/(kan|nya|in)$/.test(b) && !/^(di|me|ng|ny|ber|ter)\p{L}{4,}/u.test(b); };
    const kps = keyphrases(text, { max: 10 }).map((k) => k.phrase.split(/\s+/)).filter((ws) => ws.length >= 1 && ws.length <= 3 && ws.every(nounish) && ws.some((w) => top5.has(bare(w))));
    const kp = kps.find((ws) => ws.length >= 2); // one loose word ("KENAPA OPSI?") is not a hook
    if (kp && /\b(karena|soalnya|makanya|gara-gara|because)\b/i.test(text))
        add('GAP', [en ? 'why' : 'kenapa', ...kp], '?', null, 0.2);
    const seen = new Set();
    return out.sort((a, b) => b.score - a.score).filter((c) => !seen.has(c.hook) && seen.add(c.hook));
}
function viralHook(text, opts = {}) {
    const t = clean(text);
    // [VARIETY] Across a session's clips: a lead word or archetype already
    // used costs points, so five clips do not all open with "KENAPA".
    const used = opts.used || { leads: new Set(), types: new Map() };
    const cands = viralHookCandidates(t, opts).map((c) => Object.assign({}, c, {
        score: c.score - (used.leads.has(c.hook.split(' ')[0]) ? 2.5 : 0) - 1.0 * (used.types.get(c.type) || 0)
    }))
        .sort((a, b) => b.score - a.score);
    for (const c of cands) {
        const why = hookQuality({ hook: c.hook, title: t.split(' ').slice(0, 12).join(' ') }, t, opts.topic || '');
        if (!why || /^title_/.test(why)) {
            used.leads.add(c.hook.split(' ')[0]);
            used.types.set(c.type, (used.types.get(c.type) || 0) + 1);
            return c;
        }
    }
    return null;
}
module.exports = { viralHook, viralHookCandidates, hookQuality, keyphrases, normalizeHookText, localHookText, spokenQuestion, __test: { STOP, CONNECTOR_END } };
