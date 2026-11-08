// [EMOJI-STICKER] Spec B — auto emoji stickers for noun words (CapCut-style).
// See docs/superpowers/specs/2026-07-29-emoji-sticker-design.md.
//
// Pure module: dictionary, morphology, placement caps, and the sticker
// rectangle. No fs, no ffmpeg, no DOM — so the BURN (pipeline) and the PREVIEW
// (renderer) can compute the identical rect from the identical table. That
// shared-source rule is the whole point: the caption pipeline has been bitten
// repeatedly by a preview and a burn that each did their own arithmetic.
//
// Dual-mode like history-gallery.js: `window.EmojiMap` in the renderer,
// `require()` in main/pipeline and node --test.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.EmojiMap = api;
})(typeof window !== 'undefined' ? window : null, function () {

  // ── Dictionary ──────────────────────────────────────────────────────────
  // Curated Indonesian AND English nouns → emoji. Deliberately a lookup table,
  // not a stemmer: Indonesian derivational morphology (pekerjaan ← kerja) is
  // out of scope for v1 and falls through to the AI fallback (not in this
  // slice). One merged table rather than a table per language — short-form
  // transcripts code-switch mid-sentence ("ini worth it banget"), so a cue can
  // need either language's entry, sometimes both.
  //
  // Every value here MUST have a PNG in assets/emoji/ — guarded by the asset
  // integrity test, which is what catches a word added without its picture.
  // Many words share one emoji on purpose: hit RATE comes from covering
  // synonyms of a concept, not from minting a new picture per word — that is
  // also why the asset count (~225) is smaller than the word count (~520):
  // inventory() dedupes by emoji, so a synonym costs nothing in asset weight.
  const EMOJI_MAP = {
    // ── uang / bisnis · money / business ──────────────────────────────────
    uang: '💰', duit: '💰', money: '💰', cash: '💰', modal: '💰', capital: '💰',
    rupiah: '💵', dolar: '💵', dollar: '💵', gaji: '💵', salary: '💵', wage: '💵',
    income: '💵', pendapatan: '💵',
    untung: '📈', profit: '📈', keuntungan: '📈', growth: '📈', pertumbuhan: '📈',
    rugi: '📉', loss: '📉', turun: '📉', decline: '📉',
    pajak: '🧾', tax: '🧾', tagihan: '🧾', bill: '🧾', receipt: '🧾', struk: '🧾',
    invoice: '🧾',
    bank: '🏦', kartu: '💳', card: '💳', creditcard: '💳',
    investasi: '📈', investment: '📈', saham: '📈', stock: '📈', stocks: '📈',
    emas: '🥇', gold: '🥇',
    bisnis: '💼', business: '💼', usaha: '💼', startup: '💼', perusahaan: '🏢',
    company: '🏢',
    kerja: '💼', job: '💼', work: '💼', career: '💼', karir: '💼', profesi: '💼',
    kantor: '🏢', office: '🏢', pabrik: '🏭', factory: '🏭',
    toko: '🏪', shop: '🏪', store: '🏪', pasar: '🏪', market: '🏪',
    jualan: '🛒', jual: '🛒', sell: '🛒', belanja: '🛒', shopping: '🛒', cart: '🛒',
    beli: '🛍️', buy: '🛍️', purchase: '🛍️',
    harga: '🏷️', price: '🏷️', diskon: '🏷️', discount: '🏷️', sale: '🏷️',
    kontrak: '📄', contract: '📄', document: '📄', dokumen: '📄', file: '📄',
    laporan: '📊', report: '📊', data: '📊', statistik: '📊', statistics: '📊',
    chart: '📊', grafik: '📊',
    target: '🎯', goal: '🎯', tujuan: '🎯', objective: '🎯',
    meeting: '🤝', rapat: '🤝', deal: '🤝', kesepakatan: '🤝', partnership: '🤝',
    kerjasama: '🤝',

    // ── orang / relasi · people / relationships ───────────────────────────
    orang: '🧑', person: '🧑', people: '🧑', anak: '🧒', child: '🧒', kid: '🧒',
    bayi: '👶', baby: '👶',
    ibu: '👩', mother: '👩', mom: '👩', woman: '👩', wanita: '👩', perempuan: '👩',
    ayah: '👨', bapak: '👨', father: '👨', dad: '👨', man: '👨', pria: '👨',
    laki: '👨',
    keluarga: '👨‍👩‍👧', family: '👨‍👩‍👧',
    teman: '🤝', friend: '🤝', sahabat: '🤝', bestfriend: '🤝', pacar: '💑',
    partner: '💑', couple: '💑', pasangan: '💑',
    bos: '👔', boss: '👔', karyawan: '👔', employee: '👔', staff: '👔', pegawai: '👔',
    guru: '👩‍🏫', teacher: '👩‍🏫', murid: '🧑‍🎓', student: '🧑‍🎓', siswa: '🧑‍🎓',
    mahasiswa: '🧑‍🎓',
    dokter: '👨‍⚕️', doctor: '👨‍⚕️', perawat: '👨‍⚕️', nurse: '👨‍⚕️',
    polisi: '👮', police: '👮', tentara: '🎖️', soldier: '🎖️', army: '🎖️',
    pelanggan: '🧑', customer: '🧑', client: '🧑', klien: '🧑',
    tim: '👥', team: '👥', grup: '👥', group: '👥', komunitas: '👥',
    community: '👥',
    musuh: '⚔️', enemy: '⚔️', rival: '⚔️', saingan: '⚔️',
    fans: '📣', penggemar: '📣', follower: '📣',

    // ── tempat · places ────────────────────────────────────────────────────
    rumah: '🏠', house: '🏠', home: '🏠',
    gedung: '🏢', building: '🏢', apartemen: '🏢', apartment: '🏢',
    sekolah: '🏫', school: '🏫', kampus: '🎓', campus: '🎓', university: '🎓',
    universitas: '🎓',
    kota: '🏙️', city: '🏙️', desa: '🏡', village: '🏡',
    negara: '🌍', country: '🌍', dunia: '🌍', world: '🌍',
    jalan: '🛣️', road: '🛣️', street: '🛣️', highway: '🛣️',
    pantai: '🏖️', beach: '🏖️',
    gunung: '⛰️', mountain: '⛰️', laut: '🌊', sea: '🌊', ocean: '🌊',
    sungai: '🏞️', river: '🏞️', hutan: '🌲', forest: '🌲',
    langit: '☁️', sky: '☁️', taman: '🌳', park: '🌳',
    hotel: '🏨', restoran: '🍽️', restaurant: '🍽️', cafe: '☕', kafe: '☕',
    bandara: '🛫', airport: '🛫', stasiun: '🚉', station: '🚉',
    rumahsakit: '🏥', hospital: '🏥', gereja: '⛪', church: '⛪',
    masjid: '🕌', mosque: '🕌',

    // ── kendaraan · vehicles ───────────────────────────────────────────────
    mobil: '🚗', car: '🚗', motor: '🏍️', motorcycle: '🏍️', bike: '🏍️',
    sepeda: '🚲', bicycle: '🚲', bus: '🚌', kereta: '🚆', train: '🚆',
    pesawat: '✈️', plane: '✈️', airplane: '✈️', flight: '✈️', penerbangan: '✈️',
    kapal: '🚢', ship: '🚢', boat: '🚢', truk: '🚚', truck: '🚚',
    taxi: '🚕', taksi: '🚕', ojek: '🛵', scooter: '🛵',

    // ── waktu · time ───────────────────────────────────────────────────────
    waktu: '⏰', time: '⏰', jam: '⏰', hour: '⏰', clock: '⏰',
    menit: '⏱️', minute: '⏱️', detik: '⏱️', second: '⏱️',
    hari: '📅', day: '📅', minggu: '📅', week: '📅',
    bulan: '🗓️', month: '🗓️', tahun: '🗓️', year: '🗓️',
    pagi: '🌅', morning: '🌅', siang: '🌤️', afternoon: '🌤️',
    malam: '🌙', night: '🌙', evening: '🌙',
    besok: '📅', tomorrow: '📅', kemarin: '📅', yesterday: '📅',
    deadline: '⏳', tenggat: '⏳', schedule: '🗓️', jadwal: '🗓️',
    calendar: '🗓️', kalender: '🗓️',

    // ── teknologi · technology ─────────────────────────────────────────────
    hp: '📱', handphone: '📱', phone: '📱', smartphone: '📱', telepon: '📞',
    call: '📞', laptop: '💻', komputer: '💻', computer: '💻', pc: '💻',
    internet: '🌐', wifi: '🌐', website: '🌐', web: '🌐',
    aplikasi: '📱', app: '📱', software: '💻',
    video: '🎬', movie: '🎬', film: '🎬', foto: '📷', photo: '📷',
    picture: '📷', gambar: '📷', kamera: '📷', camera: '📷',
    musik: '🎵', music: '🎵', lagu: '🎵', song: '🎵',
    game: '🎮', permainan: '🎮', gaming: '🎮', console: '🎮',
    robot: '🤖', ai: '🤖', bot: '🤖',
    listrik: '⚡', electricity: '⚡', power: '⚡', energy: '⚡', energi: '⚡',
    battery: '🔋', baterai: '🔋', charger: '🔌', charge: '🔌',
    email: '📧', mail: '📧', surel: '📧',
    social: '📱', sosial: '📱', konten: '📱', content: '📱',
    algorithm: '🤖', algoritma: '🤖',

    // ── makanan / minuman · food / drink ───────────────────────────────────
    makanan: '🍽️', food: '🍽️', makan: '🍽️', eat: '🍽️', meal: '🍽️',
    nasi: '🍚', rice: '🍚', roti: '🍞', bread: '🍞',
    kopi: '☕', coffee: '☕', teh: '🍵', tea: '🍵',
    air: '💧', water: '💧', susu: '🥛', milk: '🥛',
    buah: '🍎', fruit: '🍎', apel: '🍎', apple: '🍎',
    sayur: '🥬', vegetable: '🥬', vegetables: '🥬',
    daging: '🍖', meat: '🍖', ayam: '🍗', chicken: '🍗',
    ikan: '🐟', fish: '🐟', telur: '🥚', egg: '🥚',
    gula: '🍬', sugar: '🍬', candy: '🍬', permen: '🍬',
    garam: '🧂', salt: '🧂',
    pizza: '🍕', burger: '🍔', mie: '🍜', noodle: '🍜', noodles: '🍜',
    cake: '🎂', kue: '🎂', birthday: '🎂',
    snack: '🍿', camilan: '🍿', popcorn: '🍿',
    alcohol: '🍺', bir: '🍺', beer: '🍺', wine: '🍷', anggur: '🍇', grape: '🍇',
    grapes: '🍇',
    pisang: '🍌', banana: '🍌', jeruk: '🍊', orange: '🍊',

    // ── tubuh / kesehatan · body / health ──────────────────────────────────
    otak: '🧠', brain: '🧠', hati: '❤️', jantung: '🫀', heart: '🫀',
    mata: '👀', eye: '👀', eyes: '👀', tangan: '✋', hand: '✋',
    kaki: '🦵', leg: '🦵', foot: '🦵',
    darah: '🩸', blood: '🩸', obat: '💊', medicine: '💊', pill: '💊',
    sakit: '🤒', sick: '🤒', pain: '🤒', ill: '🤒',
    olahraga: '🏋️', exercise: '🏋️', gym: '🏋️', workout: '🏋️',
    tidur: '😴', sleep: '😴', badan: '💪', body: '💪',
    otot: '💪', muscle: '💪', strength: '💪', kekuatan: '💪',
    diet: '🥗', salad: '🥗',
    running: '🏃', lari: '🏃', jogging: '🏃',
    yoga: '🧘', meditasi: '🧘', meditation: '🧘',
    virus: '🦠', bacteria: '🦠', penyakit: '🦠', disease: '🦠',
    vaccine: '💉', vaksin: '💉', injection: '💉', suntik: '💉',

    // ── abstrak yang punya ikon jelas · abstract with a clear icon ─────────
    ide: '💡', idea: '💡', pikiran: '💡', thought: '💡',
    masalah: '⚠️', problem: '⚠️', issue: '⚠️',
    solusi: '✅', solution: '✅', jawaban: '✅', answer: '✅',
    rahasia: '🤫', secret: '🤫',
    kunci: '🔑', key: '🔑', password: '🔑', sandi: '🔑',
    buku: '📚', book: '📚', ilmu: '📚', knowledge: '📚', education: '📚',
    pendidikan: '📚',
    berita: '📰', news: '📰',
    surat: '✉️', letter: '✉️',
    pesan: '💬', message: '💬', chat: '💬', comment: '💬', komentar: '💬',
    suara: '🔊', voice: '🔊', sound: '🔊',
    api: '🔥', fire: '🔥', trending: '🔥', viral: '🔥',
    bintang: '⭐', star: '⭐',
    hadiah: '🎁', gift: '🎁', present: '🎁',
    piala: '🏆', trophy: '🏆', juara: '🏆', champion: '🏆', winner: '🏆',
    medali: '🏅', medal: '🏅',
    mimpi: '💭', dream: '💭',
    doa: '🙏', pray: '🙏', prayer: '🙏', please: '🙏', tolong: '🙏',
    thanks: '🙏', terimakasih: '🙏',
    cinta: '❤️', love: '❤️', sayang: '❤️',
    marah: '😡', angry: '😡', mad: '😡',
    takut: '😱', scared: '😱', afraid: '😱', fear: '😱', shock: '😱',
    kaget: '😱',
    tawa: '😂', laugh: '😂', funny: '😂', lucu: '😂',
    tangis: '😢', cry: '😢', sad: '😢', sedih: '😢',
    perang: '⚔️', war: '⚔️', fight: '⚔️', berkelahi: '⚔️',
    bom: '💣', bomb: '💣', senjata: '🔫', weapon: '🔫', gun: '🔫',
    penjara: '⛓️', jail: '⛓️', prison: '⛓️',
    hukum: '⚖️', law: '⚖️', legal: '⚖️',
    sampah: '🗑️', trash: '🗑️', garbage: '🗑️',
    bersih: '🧼', clean: '🧼',
    hujan: '🌧️', rain: '🌧️', matahari: '☀️', sun: '☀️', sunny: '☀️',
    salju: '❄️', snow: '❄️', cold: '❄️', dingin: '❄️',
    panas: '🔥', hot: '🔥',
    angin: '💨', wind: '💨',

    // ── hewan · animals ────────────────────────────────────────────────────
    kucing: '🐱', cat: '🐱', anjing: '🐶', dog: '🐶',
    burung: '🐦', bird: '🐦', kuda: '🐴', horse: '🐴',
    sapi: '🐄', cow: '🐄', kambing: '🐐', goat: '🐐',
    monyet: '🐒', monkey: '🐒', gajah: '🐘', elephant: '🐘',
    singa: '🦁', lion: '🦁', harimau: '🐯', tiger: '🐯',
    ular: '🐍', snake: '🐍', naga: '🐉', dragon: '🐉',
    // "kupu-kupu" collapses to "kupu" via collapseReduplication before lookup.
    kupu: '🦋', butterfly: '🦋', lebah: '🐝', bee: '🐝',
    nyamuk: '🦟', mosquito: '🦟',

    // ── pakaian / gaya · clothing / style ──────────────────────────────────
    baju: '👕', shirt: '👕', clothes: '👕', pakaian: '👕',
    sepatu: '👟', shoes: '👟', shoe: '👟',
    tas: '👜', bag: '👜', watch: '⌚', arloji: '⌚',
    kacamata: '👓', glasses: '👓',
    cincin: '💍', ring: '💍', wedding: '💍', nikah: '💍', menikah: '💍',

    // ── olahraga / hiburan · sports / entertainment ────────────────────────
    bola: '⚽', ball: '⚽', football: '⚽', sepakbola: '⚽', soccer: '⚽',
    basket: '🏀', basketball: '🏀',
    badminton: '🏸', tenis: '🎾', tennis: '🎾',
    renang: '🏊', swimming: '🏊', swim: '🏊',
    dance: '💃', dansa: '💃', menari: '💃', joget: '💃',
    party: '🎉', pesta: '🎉', celebration: '🎉', perayaan: '🎉',
    festival: '🎪', konser: '🎤', concert: '🎤', microphone: '🎤',
  };

  // ── Morphology ──────────────────────────────────────────────────────────
  // Clitics and particles that attach to a bare noun. Stripping is NEVER done
  // blind: a candidate is only accepted when the result is itself in the
  // dictionary. Blind stripping turns "hanya" into "ha" and "kupu" into "ku" —
  // this ordering makes such a word simply miss instead of resolving wrongly.
  const SUFFIXES = ['nya', 'ku', 'mu', 'lah', 'kah', 'pun'];

  function caseFold(word) {
    return String(word == null ? '' : word).toLowerCase().trim();
  }

  // "anak-anak" → "anak". Only true reduplication collapses; "rumah-sakit" is
  // two different halves and is left for the dictionary to judge as a whole.
  function collapseReduplication(word) {
    const parts = word.split('-');
    if (parts.length === 2 && parts[0] && parts[0] === parts[1]) return parts[0];
    return word;
  }

  // English plural → singular, same candidate-based discipline as the
  // Indonesian clitics above: a stripped form is only ever tried against the
  // dictionary, never trusted outright, so "companies" safely reaching
  // "company" and "glass" wrongly reaching from "glass" (it doesn't end in an
  // extra "es" plural marker) both resolve correctly without special-casing
  // either. Words already stored in their own plural form ("glasses",
  // "shoes", "clothes") match at the base candidate before this ever runs.
  function stripEnglishPlural(word) {
    if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';       // companies → company
    if (word.length > 4 && /(?:ch|sh|x|s|z)es$/.test(word)) return word.slice(0, -2);  // watches/boxes/glasses → watch/box/glass
    if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1); // cats → cat
    return null;
  }

  // Every form worth testing against the dictionary, cheapest first.
  function candidates(word) {
    const base = collapseReduplication(caseFold(word).replace(/[^\p{L}\p{N}-]/gu, ''));
    const out = [base];
    if (base.includes('-')) out.push(base.replace(/-/g, ''));
    for (const suf of SUFFIXES) {
      if (base.length > suf.length + 2 && base.endsWith(suf)) out.push(base.slice(0, -suf.length));
    }
    const plural = stripEnglishPlural(base);
    if (plural) out.push(plural);
    return out.filter(Boolean);
  }

  // → emoji string, or null when nothing in the table matches.
  function lookupWord(word) {
    for (const c of candidates(word)) {
      if (Object.prototype.hasOwnProperty.call(EMOJI_MAP, c)) return EMOJI_MAP[c];
    }
    return null;
  }

  // ── Assets ──────────────────────────────────────────────────────────────
  // Twemoji filenames are the codepoints in lowercase hex joined by '-', with
  // VARIATION SELECTOR-16 (fe0f) dropped: a red heart is 2764.png, never
  // 2764-fe0f.png. ZWJ sequences keep their 200d joiner (1f468-200d-1f4bb).
  function assetFileFor(emoji) {
    const cps = [...String(emoji || '')]
      .map(ch => ch.codePointAt(0))
      .filter(cp => cp !== 0xfe0f)
      .map(cp => cp.toString(16));
    return cps.length ? `${cps.join('-')}.png` : null;
  }

  // Every distinct emoji the dictionary can ever produce — this is both the
  // asset manifest and the closed vocabulary the AI fallback is allowed to
  // answer from.
  function inventory() {
    return [...new Set(Object.values(EMOJI_MAP))];
  }

  // ── Placement ───────────────────────────────────────────────────────────
  // Restraint rules from the spec, so the result reads as an accent rather
  // than a decorated mess: at most one sticker per cue, at least MIN_GAP_SEC
  // apart, at most MAX_PER_CLIP in a clip.
  // [STICKER-ROW] MAX_PER_CLIP now caps the number of distinct STICKER
  // MOMENTS (cue slots) in a clip, not the raw emoji count — a moment can
  // show up to MAX_EMOJI_PER_CUE related emoji together as a row, which
  // reads as one richer accent rather than "more decoration" the way
  // scattering that many singles across the clip would. Raised 8 → 16
  // (moments), MIN_GAP_SEC held at 2.5s: pacing between distinct moments is
  // what keeps this from looking cheap, not the per-moment emoji count.
  const MAX_PER_CLIP = 16;
  const MIN_GAP_SEC = 2.5;
  const MAX_EMOJI_PER_CUE = 3;
  // A sticker's natural window is its cue's window — but per-word caption
  // chunks are SHORT. Measured on a real session: cue durations of 0.25–0.75s
  // were common, so a sticker flashed for a quarter of a second and read as a
  // glitch rather than an accent. Held for at least this long instead.
  // Comfortably under MIN_GAP_SEC, so extending one can never reach the next.
  const MIN_STICKER_SEC = 1.2;

  // First dictionary hit inside one cue's text. `tokens` is preferred when
  // present so per-word text edits are respected.
  // [STICKER-ROW] Up to `max` DISTINCT-emoji matches in a cue, in reading
  // order — the row-of-emoji this cue's moment shows. Deduped by emoji, not
  // by word: "uang, bukan cuma uang" should not show 💰 twice. Single source
  // of truth for word-matching within a cue; firstNounIn is just its head.
  function nounsInCue(cue, max) {
    const cap = Number.isFinite(max) ? max : MAX_EMOJI_PER_CUE;
    const source = Array.isArray(cue && cue.tokens) && cue.tokens.length
      ? cue.tokens.map(t => (t && t.text) || '').join(' ')
      : String((cue && cue.text) || '');
    const out = [];
    const seen = new Set();
    for (const raw of source.split(/\s+/)) {
      if (!raw || out.length >= cap) continue;
      const emoji = lookupWord(raw);
      if (!emoji || seen.has(emoji)) continue;
      seen.add(emoji);
      out.push({ word: caseFold(raw), emoji });
    }
    return out;
  }

  // [EMOJI-INLINE] Same matching/dedup rules as nounsInCue, but walks the
  // TOKENS ARRAY DIRECTLY rather than join+splitting their text back into one
  // string — needed so the caller (the renderer's DOM bake) can find the
  // exact token INDEX to measure a span for, which join+split would not
  // reliably preserve if any token's own text ever contained whitespace.
  // Requires real tokens; a plain-text cue has no per-token span to anchor an
  // emoji to, so it returns [] rather than falling back to cue.text.
  function nounTokenIndices(cue, max) {
    const cap = Number.isFinite(max) ? max : MAX_EMOJI_PER_CUE;
    const tokens = Array.isArray(cue && cue.tokens) ? cue.tokens : [];
    const out = [];
    const seen = new Set();
    tokens.forEach((t, index) => {
      if (out.length >= cap) return;
      const raw = (t && t.text) || '';
      if (!raw) return;
      const emoji = lookupWord(raw);
      if (!emoji || seen.has(emoji)) return;
      seen.add(emoji);
      out.push({ index, word: caseFold(raw), emoji });
    });
    return out;
  }

  // First dictionary hit inside one cue's text. `tokens` is preferred when
  // present so per-word text edits are respected.
  function firstNounIn(cue) {
    return nounsInCue(cue, 1)[0] || null;
  }

  // cues → [{ emoji, word, file, start, end, groupIndex, groupSize }]
  // honouring the caps. groupIndex/groupSize let the caller lay 2-3 entries
  // from the SAME cue out side by side (stickerRowRect) instead of stacking
  // them on the same centred point — every entry from one cue-moment shares
  // groupSize (how many emoji that moment has) and carries its own
  // groupIndex (0-based position in the row), even when groupSize is 1.
  //
  // `opts.aiHits` — an OPTIONAL { cueIndex: emoji } map — fills a cue's slot
  // when the dictionary found nothing there. It is consulted per cue, in the
  // SAME pass as the dictionary lookup, so an AI-resolved cue competes for
  // caps/gap slots exactly like a dictionary one rather than being bolted on
  // afterward (which would let the AI silently exceed MAX_PER_CLIP). Keyed by
  // INDEX into the exact `cues` array passed here — see uncoveredCues() below
  // for why that alignment is safe within one render pass. The AI still fills
  // at most ONE emoji per cue (never a row) — it only ever answers a cue the
  // dictionary found NOTHING in, so there is nothing for it to join.
  function planStickers(cues, opts) {
    const o = opts || {};
    const maxPerClip = Number.isFinite(o.maxPerClip) ? o.maxPerClip : MAX_PER_CLIP;
    const minGapSec = Number.isFinite(o.minGapSec) ? o.minGapSec : MIN_GAP_SEC;
    const maxPerCue = Number.isFinite(o.maxPerCue) ? o.maxPerCue : MAX_EMOJI_PER_CUE;
    const aiHits = (o.aiHits && typeof o.aiHits === 'object') ? o.aiHits : null;
    // Pass 1: select SLOTS (cue-moments) under the caps/gap rules — one slot
    // per qualifying cue, each carrying 1..maxPerCue emoji entries.
    const slots = [];
    let lastStart = -Infinity;
    const list = cues || [];
    for (let index = 0; index < list.length; index++) {
      if (slots.length >= maxPerClip) break;
      const cue = list[index];
      const start = Number(cue && cue.start);
      const end = Number(cue && cue.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      if (start < lastStart + minGapSec) continue;
      let hits = nounsInCue(cue, maxPerCue);
      if (!hits.length && aiHits && Object.prototype.hasOwnProperty.call(aiHits, index)) {
        hits = [{ word: null, emoji: aiHits[index] }];
      }
      if (!hits.length) continue;
      slots.push({ start, end, hits, cueIndex: index });
      lastStart = start;
    }

    // Pass 2: hold each SLOT for at least MIN_STICKER_SEC. Grouped emoji in
    // one slot share start/end and must extend TOGETHER — clamped against
    // THREE ceilings: the NEXT SLOT's start (two different stickers must
    // never visually collide), the very NEXT CAPTION CUE's start (so an
    // extended sticker never lingers into a caption that has already moved
    // on to different words it has nothing to do with — most transcripts
    // have zero gap between consecutive cues, so this is usually the
    // TIGHTEST of the three and the real limit in practice), and the caption
    // timeline's own end (a sticker over a silent tail looks like a stuck
    // frame). Done after selection so a clamp can see what actually follows,
    // not guess at something not yet chosen.
    const minHold = Number.isFinite(o.minStickerSec) ? o.minStickerSec : MIN_STICKER_SEC;
    let timelineEnd = -Infinity;
    for (const c of list) {
      const e = Number(c && c.end);
      if (Number.isFinite(e) && e > timelineEnd) timelineEnd = e;
    }
    for (let i = 0; i < slots.length; i++) {
      const nextSlotStart = (i + 1 < slots.length) ? slots[i + 1].start : Infinity;
      const nextCue = list[slots[i].cueIndex + 1];
      const nextCueStart = nextCue && Number.isFinite(Number(nextCue.start)) ? Number(nextCue.start) : Infinity;
      const ceiling = Math.min(nextSlotStart, nextCueStart, Number.isFinite(timelineEnd) ? timelineEnd : Infinity);
      const wanted = slots[i].start + minHold;
      // Only ever EXTENDS: a cue already longer than the minimum keeps its own
      // window, and the ceiling can never pull an end back before its start.
      slots[i].end = Math.max(slots[i].end, Math.min(wanted, Math.max(ceiling, slots[i].end)));
    }

    // Flatten: one output entry per emoji, tagged with its row position.
    const out = [];
    for (const slot of slots) {
      slot.hits.forEach((hit, i) => {
        out.push({
          emoji: hit.emoji, word: hit.word, file: assetFileFor(hit.emoji),
          start: slot.start, end: slot.end,
          groupIndex: i, groupSize: slot.hits.length, cueIndex: slot.cueIndex,
        });
      });
    }
    return out;
  }

  // ── AI fallback ─────────────────────────────────────────────────────────
  // Still a PURE module — no network, no aiComplete(). The actual HTTP call
  // is made by pipeline-inverse-v1.js's resolveAiStickers(), which is the
  // only piece of this feature allowed to touch the network; everything here
  // is string-in/data-out so it is testable without one, same as the burn
  // arithmetic above.

  // Bounded independently of MAX_PER_CLIP (8): the FINAL sticker count is
  // capped there regardless, but capping the AI CANDIDATE list too keeps the
  // prompt small and the cost flat even for a long transcript with hundreds
  // of dictionary-missed cues — most of which would lose the caps/gap
  // scheduling race anyway.
  const MAX_AI_CANDIDATES = 24;

  // Cues the dictionary found nothing in — what gets asked of the AI. Applies
  // the SAME start/end validity check planStickers does, so a cue that could
  // never become a sticker (bad timing) isn't wasted prompt budget.
  function uncoveredCues(cues, opts) {
    const o = opts || {};
    // NOT Number.isFinite: hitsFromCache passes Infinity to mean "no cap"
    // (reading a cache is free — only the PROMPT needs bounding), and
    // Number.isFinite(Infinity) is false, so that guard silently applied the
    // 24-candidate cap and dropped cached stickers past the 24th uncovered
    // cue. Accept any real number, Infinity included; reject only NaN and a
    // missing option.
    const cap = (typeof o.maxCandidates === 'number' && !Number.isNaN(o.maxCandidates))
      ? o.maxCandidates : MAX_AI_CANDIDATES;
    const out = [];
    const list = cues || [];
    for (let index = 0; index < list.length && out.length < cap; index++) {
      const cue = list[index];
      const start = Number(cue && cue.start);
      const end = Number(cue && cue.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      if (firstNounIn(cue)) continue;   // dictionary already covers it
      const text = (Array.isArray(cue.tokens) && cue.tokens.length
        ? cue.tokens.map(t => (t && t.text) || '').join(' ')
        : String(cue.text || '')).trim();
      if (!text) continue;
      out.push({ index, text });
    }
    return out;
  }

  // Constrains the model to the emoji we actually ship (spec: "the prompt
  // constrains the model to choose only from the emoji inventory we ship" —
  // this is what makes an out-of-inventory answer impossible to act on, not
  // just unlikely). "Omit the line" rather than forcing a pick keeps a cue
  // with no good match un-stickered instead of getting a wrong one.
  function buildAiPrompt(items, inventory) {
    const list = (inventory || []).join(' ');
    const lines = (items || []).map(it => `${it.index}: "${String(it.text || '').replace(/"/g, "'")}"`).join('\n');
    return `You are picking ONE emoji sticker per numbered caption line, for a short-form video.

ALLOWED EMOJI (copy the character EXACTLY — do not invent or substitute one that isn't in this list):
${list}

For each line, if a word in it clearly matches the meaning of one of the allowed emoji, pick that emoji. If nothing in the line fits well, OMIT that line's number from your answer — do not guess or force a pick.

LINES:
${lines}

Return JSON ONLY, no markdown fences, exactly this shape:
{"picks": [{"index": <line number>, "emoji": "<one allowed emoji>"}, ...]}`;
  }

  // Strips a ```json fence if present and extracts the first {...} blob —
  // aiComplete() responses vary by provider in how strictly they honour
  // "JSON only". Never throws; a response that isn't parseable JSON at all is
  // the same as an empty answer, not a crash.
  function looseJsonParse(raw) {
    if (raw == null) return null;
    let s = String(raw).trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return null;
    try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  }

  // A persisted { cueText: emoji } cache → the { cueIndex: emoji } shape
  // planStickers wants. Shared because BOTH sides need it and must agree: the
  // burn (resolveAiStickers, before deciding what to ask the AI) and the live
  // preview (which may only ever READ the cache — a video-tick handler must
  // never make a network call). Two copies of this mapping would be a
  // preview/burn divergence waiting to happen, which is the exact bug class
  // this feature's own audit found twice in the caption pipeline.
  function hitsFromCache(cues, cache) {
    const out = {};
    if (!cache || typeof cache !== 'object') return out;
    for (const it of uncoveredCues(cues, { maxCandidates: Infinity })) {
      if (Object.prototype.hasOwnProperty.call(cache, it.text)) out[it.index] = cache[it.text];
    }
    return out;
  }

  // raw model text → { cueIndex: emoji }, validated two ways (spec test 5):
  // an index the model answers that was never ASKED is dropped (it cannot
  // have judged a cue it wasn't shown), and an emoji outside the shipped
  // inventory is dropped (we have no PNG for it — the closed vocabulary is
  // enforced here, not just requested in the prompt above).
  function parseAiResponse(raw, items, inventory) {
    const allowed = new Set(inventory || []);
    const asked = new Set((items || []).map(it => it.index));
    const parsed = looseJsonParse(raw);
    const picks = parsed && Array.isArray(parsed.picks) ? parsed.picks : [];
    const out = {};
    for (const p of picks) {
      if (!p || typeof p !== 'object') continue;
      const idx = Number(p.index);
      const emoji = String(p.emoji == null ? '' : p.emoji).trim();
      if (!Number.isInteger(idx) || !asked.has(idx)) continue;
      if (!emoji || !allowed.has(emoji)) continue;
      out[idx] = emoji;
    }
    return out;
  }

  // ── Geometry ────────────────────────────────────────────────────────────
  // Captions are authored against a canonical 1080×1920 space: buildAss scales
  // that into the ASS PlayRes with SY = PR.h/1920, and libass then maps PlayRes
  // onto the output frame. Both scalings cancel, so a caption's position and
  // size as a FRACTION of the frame are just (value / 1920) — independent of
  // format and resolution. That is why this needs only the output pixel size.
  //
  // Sizing off the caption font (not the frame) keeps stickers proportional to
  // the captions across face / square / landscape.
  // Was 1.6 — measured on the user's own footage (85px caption font at 720p
  // → 91px sticker) as towering over the caption it sits above. Shrunk to
  // read as an accent near the caption's own scale, not a second headline.
  const SIZE_RATIO = 0.85;
  // Both ratios are fractions of the CAPTION FONT SIZE, so shrinking
  // SIZE_RATIO (1.6 → 0.85) left the gap unchanged in absolute terms while
  // the sticker beside it halved — measured on a real 720p render, the
  // result was a 25px gap under a 48px emoji, 52% of its own height, which
  // read as the sticker floating away from the word rather than labelling
  // it. Retuned so the gap is ~15% of the sticker instead of ~50%.
  const GAP_RATIO = 0.12;
  const REF_H = 1920;
  const REF_W = 1080;

  // [EMOJI-SUBTITLEX] The caption's own horizontal centre in OUTPUT pixels.
  // buildAss maps subtitleX (canonical 1080-wide space) to base X by scaling
  // with frame width (SX = PR.w/1080), and libass then scales PlayResX → the
  // real output width, so the output-pixel centre is subtitleX·(outputW/1080).
  // null/undefined (and the legacy 540 sentinel) mean canonical centre, which
  // this same formula already yields — so no special-casing is needed.
  function cueCenterX(subtitleX, outputW) {
    const sx = (Number(outputW) || 0) / REF_W;
    const sub = (subtitleX == null) ? REF_W / 2 : Number(subtitleX);
    return sub * sx;
  }

  // captionY is top-origin, same axis buildAss uses for yPos.
  function stickerRect(geom) {
    const g = geom || {};
    const outputW = Number(g.outputW) || 0;
    const outputH = Number(g.outputH) || 0;
    const sy = outputH / REF_H;
    const fontPx = (Number(g.fontSize) || 64) * sy;
    const size = Math.round(SIZE_RATIO * fontPx);
    const gap = Math.round(GAP_RATIO * fontPx);
    // Clamped so a caption parked near the top of the frame pushes the sticker
    // to the edge instead of off it (a negative overlay y is silently dropped
    // by ffmpeg, which would look like the feature failing at random).
    const y = Math.max(0, Math.round((Number(g.captionY) || 540) * sy) - size - gap);
    // [EMOJI-SUBTITLEX] Centre on the caption, not the frame — a caption moved
    // off-centre carries its sticker with it.
    const x = Math.max(0, Math.round(cueCenterX(g.subtitleX, outputW) - size / 2));
    return { size, x, y };
  }

  // [STICKER-ROW] size/y for n=1 is BYTE IDENTICAL to stickerRect — a single-
  // emoji cue-moment renders exactly as it always has. n>1 fans x out around
  // that same centred point so the ROW is centred, not the first sticker.
  // Horizontal gap is a fraction of sticker size (not GAP_RATIO, which is the
  // VERTICAL gap to the caption) so it scales with the same font-driven size.
  const ROW_GAP_RATIO = 0.28;
  function stickerRowRect(n, geom) {
    const single = stickerRect(geom);
    const count = Math.max(1, Number(n) || 1);
    if (count === 1) return [single];
    const gap = Math.round(ROW_GAP_RATIO * single.size);
    const totalW = count * single.size + (count - 1) * gap;
    const outputW = Number((geom || {}).outputW) || 0;
    // [EMOJI-SUBTITLEX] Centre the ROW on the caption's own X, not the frame.
    const startX = Math.max(0, Math.round(cueCenterX((geom || {}).subtitleX, outputW) - totalW / 2));
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push({ size: single.size, y: single.y, x: startX + i * (single.size + gap) });
    }
    return out;
  }

  // [EMOJI-INLINE] The pure half of per-word placement: given a token's own
  // measured position (already reduced to the SAME canonical, cue-box-centre-
  // relative frame ax/ay use — see bakeCueWordOffsets), where should its
  // emoji sit? Directly above the word, sized off the caption font like every
  // other sticker. The DOM measurement that produces tokenTop/tokenCenterX is
  // the one half of this feature that cannot run headlessly — this function
  // is what CAN be unit-tested without a browser.
  function inlineAnchor({ tokenTop, tokenCenterX, fontSize }) {
    const size = Math.round(SIZE_RATIO * (Number(fontSize) || 64));
    const gap = Math.round(GAP_RATIO * (Number(fontSize) || 64));
    return { size, ax: Math.round(Number(tokenCenterX) || 0), ay: Math.round((Number(tokenTop) || 0) - size - gap) };
  }

  // [EMOJI-INLINE] Converts one token's BAKED anchor (eax/eay/esize, in the
  // same canonical 1080×1920 frame ax/ay already use) into the absolute
  // OUTPUT-PIXEL rect the ffmpeg overlay= filter needs. Mirrors stickerRect's
  // own conventions exactly (same `sy` scale, same "centre point → left/top
  // edge" conversion) so the two placement modes share one set of rules.
  //
  // [EMOJI-SUBTITLEX] The cue's horizontal centre follows subtitleX (see
  // cueCenterX): base X scales with frame width, the per-word offset (eax) with
  // frame height (sy) — exactly how buildAss maps the caption word's own X, so
  // a moved caption carries its inline sticker with it instead of leaving it
  // pinned to frame centre. A default/omitted subtitleX still centres.
  function inlineJobRect({ eax, eay, esize, captionY, outputW, outputH, subtitleX }) {
    const sy = (Number(outputH) || 0) / REF_H;
    const cueBaseY = Math.round((Number(captionY) || 540) * sy);
    const size = Math.round((Number(esize) || 0) * sy);
    const x = Math.round(cueCenterX(subtitleX, outputW) + (Number(eax) || 0) * sy - size / 2);
    const y = Math.round(cueBaseY + (Number(eay) || 0) * sy);
    return { size: Math.max(1, size), x: Math.max(0, x), y: Math.max(0, y) };
  }

  return {
    EMOJI_MAP, SUFFIXES, MAX_PER_CLIP, MIN_GAP_SEC, MIN_STICKER_SEC, SIZE_RATIO, GAP_RATIO,
    MAX_AI_CANDIDATES, MAX_EMOJI_PER_CUE, ROW_GAP_RATIO,
    caseFold, collapseReduplication, candidates, lookupWord, stripEnglishPlural,
    assetFileFor, inventory, firstNounIn, nounsInCue, nounTokenIndices,
    planStickers, stickerRect, stickerRowRect, inlineAnchor, inlineJobRect,
    uncoveredCues, buildAiPrompt, parseAiResponse, hitsFromCache,
  };
});
