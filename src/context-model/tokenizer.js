// Generated from backend/src/context-model/tokenizer.ts by scripts/backend.cjs. Edit the TypeScript source.
// ─── [CTX-MODEL] XLM-R Unigram tokenizer (pure JS) ─────────────────────────
// multilingual-e5-small uses the XLM-RoBERTa SentencePiece vocabulary: NFKC-ish
// normalisation, Metaspace pre-tokenisation ("\u2581" marks a word start) and a
// Unigram model decoded with Viterbi. This reads the model's own
// tokenizer.json, so there is no native tokenizer to ship per platform.
// Verified against the Rust `tokenizers` library on the sentences of five real
// sessions (see test/context-model.test.js for the logic checks).
const fs = require('fs');
const SPACE = '\u2581';
class XlmrTokenizer {
    constructor(json) {
        const m = json.model;
        if (!m || m.type !== 'Unigram')
            throw new Error('tokenizer: expected a Unigram model');
        this.unkId = m.unk_id ?? 3;
        this.pieces = new Map();
        let minScore = 0, maxLen = 1;
        m.vocab.forEach(([piece, score], id) => {
            this.pieces.set(piece, id);
            this.scores = this.scores || new Float32Array(m.vocab.length);
            this.scores[id] = score;
            if (score < minScore)
                minScore = score;
            if (piece.length > maxLen)
                maxLen = piece.length;
        });
        this.unkScore = minScore - 10; // HF tokenizers' kUnkPenalty
        this.maxLen = Math.min(maxLen, 48);
        this.bos = 0;
        this.eos = 2;
        this.pad = 1;
        for (const t of json.added_tokens || []) {
            if (t.content === '<s>')
                this.bos = t.id;
            else if (t.content === '</s>')
                this.eos = t.id;
            else if (t.content === '<pad>')
                this.pad = t.id;
        }
    }
    static fromFile(file) {
        return new XlmrTokenizer(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
    normalize(text) {
        // nmt_nfkc: NFKC plus control characters removed and all whitespace as ' '.
        return String(text || '')
            .normalize('NFKC')
            .replace(/[\u0000-\u0008\u000B\u000E-\u001F\u007F\u200B-\u200D\uFEFF]/g, '')
            .replace(/\s/g, ' ')
            .replace(/ {2,}/g, ' '); // SentencePiece collapses runs of whitespace
    }
    // Viterbi over one "\u2581word" (code points, not UTF-16 units).
    _encodeWord(word) {
        const chars = Array.from(word);
        const n = chars.length;
        const best = new Float64Array(n + 1).fill(-Infinity);
        const from = new Int32Array(n + 1).fill(-1);
        const tok = new Int32Array(n + 1).fill(-1);
        best[0] = 0;
        for (let i = 0; i < n; i++) {
            if (best[i] === -Infinity)
                continue;
            let piece = '';
            let matched = false;
            for (let j = i; j < Math.min(n, i + this.maxLen); j++) {
                piece += chars[j];
                const id = this.pieces.get(piece);
                if (id === undefined)
                    continue;
                matched = matched || j === i;
                const s = best[i] + this.scores[id];
                if (s > best[j + 1]) {
                    best[j + 1] = s;
                    from[j + 1] = i;
                    tok[j + 1] = id;
                }
            }
            if (!matched) { // a single character missing from the vocabulary → <unk>
                const s = best[i] + this.unkScore;
                if (s > best[i + 1]) {
                    best[i + 1] = s;
                    from[i + 1] = i;
                    tok[i + 1] = this.unkId;
                }
            }
        }
        const ids = [];
        for (let k = n; k > 0; k = from[k]) {
            if (from[k] < 0)
                return [this.unkId];
            ids.push(tok[k]);
        }
        ids.reverse();
        // consecutive unknowns are fused into one, as the Rust Unigram model does
        return ids.filter((id, k) => !(id === this.unkId && ids[k - 1] === this.unkId));
    }
    encode(text, maxTokens = 128) {
        const norm = this.normalize(text);
        // Metaspace (add_prefix_space): every space becomes \u2581 and starts a new word.
        const meta = SPACE + norm.replace(/ /g, SPACE);
        const words = meta.split(new RegExp(`(?=${SPACE})`)).filter((w) => w.length);
        const out = [this.bos];
        for (const w of words) {
            for (const id of this._encodeWord(w)) {
                if (out.length >= maxTokens - 1)
                    break;
                out.push(id);
            }
            if (out.length >= maxTokens - 1)
                break;
        }
        out.push(this.eos);
        return out;
    }
}
module.exports = { XlmrTokenizer };
