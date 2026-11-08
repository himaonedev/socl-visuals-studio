'use strict';
// [UPDATE-BETA] Which published release counts as "newer" for Settings →
// Cek update. GitHub's /releases/latest never returns a prerelease, so a beta
// install was always compared with the last stable (2.4.12 vs 2.4.15-beta →
// "Sudah versi terbaru") and beta users were never told about the next beta.
// A beta install now considers every published release, prereleases
// included; a stable install keeps to stable releases only.
//
// Pure (no Electron, no network) so it can be tested; main.js fetches.

function parse(v) {
  const s = String(v || '').trim().replace(/^v/i, '');
  const dash = s.indexOf('-');
  const core = dash === -1 ? s : s.slice(0, dash);
  const pre = dash === -1 ? '' : s.slice(dash + 1);
  const nums = core.split('.').map(n => parseInt(n, 10) || 0);
  return { nums: [nums[0] || 0, nums[1] || 0, nums[2] || 0], pre: pre ? pre.split('.') : [] };
}

function isPrerelease(v) {
  return parse(v).pre.length > 0;
}

// Semver precedence: the three numbers first; then a release outranks its own
// prereleases (2.4.16 > 2.4.16-beta); then prerelease identifiers, numeric
// ones compared as numbers (beta.10 > beta.9) and below any text identifier.
function compareVersions(a, b) {
  const A = parse(a), B = parse(b);
  for (let i = 0; i < 3; i++) if (A.nums[i] !== B.nums[i]) return A.nums[i] - B.nums[i];
  if (!A.pre.length || !B.pre.length) return (B.pre.length ? 1 : 0) - (A.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i], y = B.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d; continue; }
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// The highest app version among GitHub releases (as returned by
// GET /repos/:repo/releases). Drafts never count; prereleases count only for a
// beta install; tags that are not app versions — the releases repo also holds
// e.g. cookies-exporter-v1.1.0 — are skipped. '' when nothing qualifies.
// [UPDATE-BETA-OPTIN] `includePrerelease`: a stable install whose owner turned
// on "Tawarkan versi beta juga" in Settings → About sees betas too — whichever
// of beta and stable is newest wins. A beta install always does.
function pickLatestTag(releases, current, opts = {}) {
  const wantPre = isPrerelease(current) || !!(opts && opts.includePrerelease);
  let best = '';
  for (const r of Array.isArray(releases) ? releases : []) {
    if (!r || r.draft || typeof r.tag_name !== 'string') continue;
    if (r.prerelease && !wantPre) continue;
    if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(r.tag_name)) continue;
    if (!best || compareVersions(r.tag_name, best) > 0) best = r.tag_name;
  }
  return best;
}

module.exports = { compareVersions, isPrerelease, pickLatestTag };
