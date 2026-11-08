// Shared caption additions: preserve SOCL's glyphs, colours and boxes.
(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CaptionExtras = api;
})(typeof window !== 'undefined' ? window : globalThis, function() {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function sample(settings, elapsed) {
    const s = settings || {}, duration = clamp(+s.duration || 0.5, 0.1, 5);
    const progress = clamp(elapsed / duration, 0, 1), ease = 1 - Math.pow(1 - progress, 3);
    const distance = clamp(s.distance == null ? 80 : +s.distance, 0, 500) * (1 - ease);
    let x = 0, y = 0, scale = 1, opacity = 1;
    if (s.motion === 'rise' || s.motion === 'bottom') y = distance;
    if (s.motion === 'top') y = -distance;
    if (s.motion === 'left') x = -distance;
    if (s.motion === 'right') x = distance;
    if (s.motion === 'scale') scale = 0.8 + 0.2 * ease;
    if (s.motion && s.motion !== 'none') opacity = ease;
    const speed = clamp(+s.speed || 2, 0.5, 4), depth = clamp(s.depth == null ? 1 : +s.depth, 0, 1);
    const phase = Math.max(0, elapsed) * speed;
    if (elapsed < clamp(+s.flickerDuration || 1, 0.2, 3)) {
      let level = 1;
      if (s.flicker === 'blink') level = phase % 1 < 0.5 ? 1 : 0;
      if (s.flicker === 'neon') level = [1,.12,.85,0,.35,1,.18,1,1,.6,0,1][Math.floor(phase * 6) % 12];
      if (s.flicker === 'pulse') level = (1 + Math.cos(phase * Math.PI * 2)) / 2;
      opacity *= 1 - depth + depth * level;
    }
    return { x, y, scale, opacity };
  }
  const seconds = t => { const p = t.split(':').map(Number); return p[0] * 3600 + p[1] * 60 + p[2]; };
  const tc = t => { const cs = Math.max(0, Math.round(t * 100)); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2,'0')}:${String(Math.floor(cs / 100) % 60).padStart(2,'0')}.${String(cs % 100).padStart(2,'0')}`; };
  const color = c => /^#[0-9a-f]{6}$/i.test(c || '') ? `&H${c.slice(5,7)}${c.slice(3,5)}${c.slice(1,3)}&` : '&H00FFFF&';
  const alpha = value => `&H${Math.round(255 * (1 - clamp(value, 0, 1))).toString(16).padStart(2,'0')}&`;
  const enabled = s => s && ((s.motion && s.motion !== 'none') || (s.flicker && s.flicker !== 'none'));

  function decorate(text, value, sx, sy) {
    // Position overrides are sampled in the existing ASS canvas; font, spacing,
    // per-word colours and box drawings stay in their original SOCL events.
    let out = text.replace(/\\pos\(([-\d.]+),([-\d.]+)\)/g, (_, x, y) => `\\pos(${(+x + value.x * sx).toFixed(2)},${(+y + value.y * sy).toFixed(2)})`);
    const tags = `\\alpha${alpha(value.opacity)}${value.scale !== 1 ? `\\fscx${(value.scale*100).toFixed(2)}\\fscy${(value.scale*100).toFixed(2)}` : ''}`;
    // Append to the existing leading override, rather than replacing its style.
    return out.replace(/^\{([^}]*)\}/, (_, original) => `{${original}${tags}}`);
  }
  function applyAss(body, cues, resolution) {
    if (!cues.some(c => c.textMotion)) return body;
    const sx = resolution.w / 1080, sy = resolution.h / 1920;
    const lines = body.split('\n').flatMap(line => {
      if (!line.startsWith('Dialogue:')) return [line];
      const parts = line.split(',');
      if (parts.length < 10) return [line];
      const start = seconds(parts[1]), end = seconds(parts[2]);
      const cue = cues.find(c => start >= c.start - .011 && end <= c.end + .011 && enabled(c.textMotion));
      if (!cue) return [line];
      const out = [], text = parts.slice(9).join(',');
      // Match preview sampling, with a bounded 25fps ASS stream. Original
      // event end times remain intact, including active-word boundaries.
      for (let t = start; t < end - .001; t += .04) {
        const stop = Math.min(end, t + .04), p = parts.slice(0,9);
        p[1] = tc(t); p[2] = tc(stop);
        if (p[1] === p[2]) continue;
        out.push(p.join(',') + ',' + decorate(text, sample(cue.textMotion, t - cue.start), sx, sy));
      }
      return out;
    });
    // Marks are separate vector drawings behind the original styled text.
    for (const cue of cues) {
      const s = cue.textMotion, m = s?.mark;
      if (!m || m.kind === 'none' || !Array.isArray(m.rects)) continue;
      const begin = cue.start + clamp(+m.delay || 0, 0, 5), end = cue.end;
      for (let t = begin; t < end - .001; t += .04) {
        const elapsed = t - cue.start, value = sample(s, elapsed);
        const reveal = clamp((t - begin) / clamp(+m.duration || .4, .1, 5), 0, 1);
        for (const rect of m.rects.slice(0,100)) {
          if (![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite)) continue;
          const thickness = clamp(+m.thickness || 10, 1, 80);
          const height = m.kind === 'highlight' ? rect.height * clamp(thickness/20,.05,2) : thickness;
          const y = rect.y + (m.kind === 'highlight' ? (rect.height-height)/2 : m.kind === 'underline' ? rect.height : rect.height * .5);
          const x = (rect.x + value.x) * sx, top = (y + value.y) * sy;
          const w = rect.width * sx * reveal, h = height * sy;
          if (w <= 0) continue;
          const drawing = m.kind === 'scribble' ? `m 0 ${h/2} l ${w*.2} 0 ${w*.4} ${h} ${w*.6} 0 ${w*.8} ${h} ${w} ${h/2}` : `m 0 0 l ${w} 0 ${w} ${h} 0 ${h}`;
          lines.push(`Dialogue: -1,${tc(t)},${tc(Math.min(end,t+.04))},Default,,0,0,0,,{\\an7\\pos(${x},${top})\\p1\\bord${m.kind === 'scribble' ? h/3 : 0}\\shad0\\blur0\\1c${color(m.color)}\\3c${color(m.color)}\\alpha${alpha(value.opacity * clamp(m.opacity == null ? .65 : +m.opacity,0,1))}\\frz${-clamp(+m.rotation||0,-180,180)}}${drawing}`);
        }
      }
    }
    return lines.join('\n');
  }
  return { sample, applyAss };
});
