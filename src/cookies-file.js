// Generated from backend/src/cookies-file.ts by scripts/backend.cjs. Edit the TypeScript source.
'use strict';
// [COOKIES-VALIDATE] Memeriksa (dan menambal seperlunya) berkas cookies SEBELUM
// disimpan, supaya kegagalannya muncul saat user menekan Upload — menunjuk
// berkas yang DIA pilih — bukan di tengah Fetch lewat kalimat yt-dlp yang
// menunjuk path di dalam AppData.
//
// Aturannya diukur langsung dari binari yt-dlp bawaan (2026.08.19), bukan
// dibaca dari dokumentasi:
//
//   baris 1 "# Netscape HTTP Cookie File" / "# HTTP Cookie File" -> diterima
//   tanpa baris header                     -> ditolak
//   header benar TAPI didahului BOM UTF-8  -> ditolak, pesannya SAMA PERSIS
//   isi JSON                               -> ditolak, pesannya menyebut JSON
//   header benar, kolom bukan TAB          -> DITERIMA tanpa error, lalu semua
//                                             barisnya dibuang diam-diam
//
// Yang terakhir itu yang paling berbahaya dan karenanya di sini DITOLAK keras:
// tanpa penolakan, user melihat "berhasil", tidak pernah melihat pesan apa pun,
// dan cuma bingung kenapa tetap kena bot-check.
const NETSCAPE_HEADER = '# Netscape HTTP Cookie File';
const HEADER_RE = /^#\s*(?:Netscape\s+)?HTTP Cookie File/i;
const COOKIE_FIELDS = 7;
function inspectCookiesFile(input) {
    let buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ''), 'utf8');
    const fixed = [];
    // UTF-16 (Notepad "Unicode"/"UTF-16 LE") tidak akan pernah terbaca sebagai
    // teks Netscape. Ditolak dengan menyebut cara menyimpannya, karena itu satu-
    // satunya hal yang bisa user lakukan.
    if ((buf[0] === 0xFF && buf[1] === 0xFE) || (buf[0] === 0xFE && buf[1] === 0xFF)) {
        return fail('utf16', 'File ini tersimpan sebagai UTF-16. Simpan ulang sebagai UTF-8 (tanpa BOM), '
            + 'atau export ulang lewat ekstensi SCL VSL Cookies Exporter.');
    }
    // BOM UTF-8: header-nya bisa saja sudah benar, tapi yt-dlp membaca BOM itu
    // sebagai bagian baris pertama sehingga header-nya tidak dikenali lagi.
    // Notepad Windows menambahkannya begitu file dibuka lalu disimpan.
    if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
        buf = buf.subarray(3);
        fixed.push('bom');
    }
    let text = buf.toString('utf8');
    if (!text.trim())
        return fail('empty', 'File cookies-nya kosong.');
    const head = text.trimStart();
    if (head.startsWith('[') || head.startsWith('{')) {
        return fail('json', 'File ini format JSON, bukan Netscape. Pakai ekstensi yang mengekspor '
            + 'cookies.txt Netscape — misalnya SCL VSL Cookies Exporter.');
    }
    const lines = text.split('\n');
    // [COOKIES-HTTPONLY] `#HttpOnly_<domain>` is NOT a comment: it is how the
    // Netscape format marks an HttpOnly cookie, and yt-dlp strips the prefix and
    // loads the row. YouTube's login cookies (SID, HSID, SSID, __Secure-3PSID,
    // LOGIN_INFO) are exactly those, so treating them as comments under-counted
    // every real export and rejected one holding only HttpOnly rows outright.
    const HTTPONLY = '#HttpOnly_';
    const data = lines
        .map((l) => (l.trimStart().startsWith(HTTPONLY) ? l.trimStart().slice(HTTPONLY.length) : l))
        .filter((l) => l.trim() && !l.trimStart().startsWith('#'));
    const isCookieRow = (l) => l.replace(/\r$/, '').split('\t').length === COOKIE_FIELDS;
    const cookieRows = data.filter(isCookieRow).length;
    const skippedRows = data.length - cookieRows;
    if (!cookieRows) {
        return fail('no-cookies', 'Tidak ada satu pun baris cookie yang sah — kolomnya harus dipisah '
            + 'TAB, bukan koma atau spasi. File seperti ini diterima yt-dlp tanpa error tapi semua '
            + 'cookie-nya dibuang, jadi tetap tidak berguna. Export ulang lewat ekstensi.');
    }
    // Header dipasang BELAKANGAN, setelah isinya terbukti berisi cookie sah —
    // supaya kita tidak pernah "menyulap" file sampah jadi terlihat sah.
    if (!HEADER_RE.test(text)) {
        text = NETSCAPE_HEADER + '\n' + text;
        fixed.push('header');
    }
    return {
        ok: true, code: 'ok', message: '',
        content: Buffer.from(text, 'utf8'),
        fixed, cookieRows, skippedRows,
    };
    function fail(code, message) {
        return { ok: false, code, message, content: null, fixed, cookieRows: 0, skippedRows: 0 };
    }
}
module.exports = { inspectCookiesFile, NETSCAPE_HEADER, HEADER_RE };
