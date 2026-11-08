function normalized(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function baseLanguage(value) {
  return normalized(value).split(/[-_]/, 1)[0];
}

function usableTrackKey(key) {
  if (typeof key !== 'string' || key.trim() !== key || key.length === 0) return false;
  const value = normalized(key);
  if (value === 'live_chat' || value === 'all') return false;
  return /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i.test(key);
}

function usableFormatDescriptor(format) {
  if (!format || typeof format !== 'object' || Array.isArray(format)) return false;
  return typeof format.url === 'string' && format.url.trim().length > 0;
}

function tracksFrom(metadata) {
  if (!metadata || typeof metadata !== 'object') return [];

  const tracks = [];
  for (const [field, manual] of [['subtitles', true], ['automatic_captions', false]]) {
    const collection = metadata[field];
    if (!collection || typeof collection !== 'object' || Array.isArray(collection)) continue;

    for (const [key, formats] of Object.entries(collection)) {
      if (!usableTrackKey(key)) continue;
      if (!Array.isArray(formats) || !formats.some(usableFormatDescriptor)) continue;
      tracks.push({
        key,
        normalized: normalized(key),
        base: baseLanguage(key),
        manual,
      });
    }
  }
  return tracks;
}

function lexicalTrackOrder(left, right) {
  if (left.normalized !== right.normalized) return left.normalized < right.normalized ? -1 : 1;
  if (left.manual !== right.manual) return left.manual ? -1 : 1;
  if (left.key === right.key) return 0;
  return left.key < right.key ? -1 : 1;
}

function bestExact(tracks, requested) {
  const target = normalized(requested);
  return tracks
    .filter((track) => track.normalized === target)
    .sort(lexicalTrackOrder)[0] || null;
}

function bestForBase(tracks, requestedBase, excludedExact = '') {
  const targetBase = baseLanguage(requestedBase);
  const excluded = normalized(excludedExact);
  if (!targetBase) return null;

  return tracks
    .filter((track) => track.base === targetBase && track.normalized !== excluded)
    .sort((left, right) => {
      if (left.manual !== right.manual) return left.manual ? -1 : 1;
      const leftExactBase = left.normalized === targetBase;
      const rightExactBase = right.normalized === targetBase;
      if (leftExactBase !== rightExactBase) return leftExactBase ? -1 : 1;
      return lexicalTrackOrder(left, right);
    })[0] || null;
}

function deterministicFirst(tracks) {
  return [...tracks].sort(lexicalTrackOrder)[0] || null;
}

function selectAutoTrack(metadata, tracks) {
  // [AUTO-LANG-FIX] The original hardcoded preference order ['id','ms','en']
  // always picked Indonesian for any video that had an 'id' track — including
  // English-language videos whose YouTube auto-translation has an 'id' ASR
  // track. The video's own metadata.language / metadata.original_language is
  // the authoritative source of what language the video actually is. Put it
  // FIRST so an English video selects 'en', not 'id'.
  //
  // 'id' and 'ms' are kept as secondary fallbacks (after the video's real
  // language) for backward-compatibility with Indonesian-language content
  // where metadata is absent or ambiguous. 'en' stays as a final catch-all.
  const preferences = [metadata.original_language, metadata.language, 'id', 'ms', 'en'];
  const visited = new Set();

  for (const preference of preferences) {
    const base = baseLanguage(preference);
    if (!base || visited.has(base)) continue;
    visited.add(base);
    const track = bestForBase(tracks, base);
    if (track) return track.key;
  }

  const fallback = deterministicFirst(tracks);
  return fallback ? fallback.key : null;
}

function selectExplicitTrack(metadata, tracks, preference) {
  const requested = normalized(preference);
  const exact = bestExact(tracks, requested);
  if (exact) return exact.key;

  const requestedBase = baseLanguage(requested);
  const variant = bestForBase(tracks, requestedBase, requested);
  if (variant) return variant.key;

  const sister = requestedBase === 'id' ? 'ms' : requestedBase === 'ms' ? 'id' : null;
  if (sister) {
    const sisterTrack = bestForBase(tracks, sister);
    if (sisterTrack) return sisterTrack.key;
  }

  const english = bestForBase(tracks, 'en');
  if (english) return english.key;

  for (const originalLanguage of [metadata.original_language, metadata.language]) {
    const original = bestForBase(tracks, originalLanguage);
    if (original) return original.key;
  }

  const fallback = deterministicFirst(tracks);
  return fallback ? fallback.key : null;
}

function selectSubtitleTrack(metadata = {}, preference = 'auto') {
  const safeMetadata = metadata && typeof metadata === 'object' ? metadata : {};
  const tracks = tracksFrom(safeMetadata);
  if (tracks.length === 0) return null;

  return normalized(preference) === 'auto' || !normalized(preference)
    ? selectAutoTrack(safeMetadata, tracks)
    : selectExplicitTrack(safeMetadata, tracks, preference);
}

module.exports = { selectSubtitleTrack };
