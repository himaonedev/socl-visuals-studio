# [COLLAGE-BROLL] Halftone paper-collage B-roll, drawn entirely in code — no
# image model, no stock art: every paper, tape, star and scribble below is
# generated here, so the look is SOCL's own and carries no licence. Run by the
# app with the tracker bundle's python (`python -c <this file>`), which already
# ships mediapipe + opencv + Pillow.
# argv: portrait_src  t_sec  out_dir  "LINE ONE|line two"  bg_hex  accent_hex  fonts_dir  dur_sec
# Writes 1080x1920 frames f%05d.jpg at 24 fps and prints one JSON line
# {"ok":true,"frames":N,"fps":24} (or {"ok":false,"error":...}).
import sys, os, math, random, json
import numpy as np, cv2
import mediapipe as mp
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageChops

src, t, out, text, bg_hex, acc_hex = sys.argv[1], float(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]
FONTS = sys.argv[7]
W, H, FPS, STEP = 1080, 1920, 24, 3
DUR = float(sys.argv[8]) if len(sys.argv) > 8 else 4.0
STYLE = sys.argv[9] if len(sys.argv) > 9 else 'kolase'
OV_Y = float(sys.argv[10]) if len(sys.argv) > 10 and sys.argv[10] else None   # overlay centre y chosen off faces
OV_X = float(sys.argv[11]) if len(sys.argv) > 11 and sys.argv[11] else None   # overlay centre x   # kolase | poster | partikel      # stop-motion: a new pose every 3 frames (8 fps)
os.makedirs(out, exist_ok=True)
rnd = random.Random(7)
def fail(msg):
    print(json.dumps({'ok': False, 'error': msg})); sys.exit(0)
hexrgb = lambda h: tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))
BG, ACC, CREAM, INK = hexrgb(bg_hex), hexrgb(acc_hex), (243, 234, 214), (22, 20, 18)

# ── 1. grab the frame + person mask ────────────────────────────────────────
cap = cv2.VideoCapture(src); cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
ok, frame = cap.read()
if not ok: fail('frame unreadable')
seg = mp.solutions.selfie_segmentation.SelfieSegmentation(model_selection=0)
m = seg.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)).segmentation_mask
m = (cv2.GaussianBlur(m, (0, 0), 1.2) > 0.5).astype(np.uint8)
n, lab, stats, _ = cv2.connectedComponentsWithStats(m)               # keep the biggest blob
if n > 1: m = (lab == 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])).astype(np.uint8)
ys, xs = np.where(m > 0)
if len(xs) < m.size * 0.04: fail('no person in frame')
x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)[y0:y1 + 1, x0:x1 + 1]
mk = m[y0:y1 + 1, x0:x1 + 1]
# torn straight bottom: chest-up portrait, ragged paper edge instead of a cut-off mask
hh = mk.shape[0]; cutY = int(hh * 0.72); rr = random.Random(11)
for x in range(mk.shape[1]):
    yy = cutY + int(6 * math.sin(x / 23.0) + rr.uniform(-5, 5)); mk[yy:, x] = 0
mk = mk[:cutY + 14]; gray = gray[:cutY + 14]

# ── 2. halftone the cut-out (rotated dot screen, newsprint look) ───────────
def halftone(g, cell=9, ang=45):
    g = cv2.equalizeHist(g).astype(np.float32) / 255.0
    g = np.clip((g - 0.5) * 1.35 + 0.52, 0, 1)
    h, w = g.shape
    big = Image.new('L', (w * 2, h * 2), 255); d = ImageDraw.Draw(big)
    ca, sa = math.cos(math.radians(ang)), math.sin(math.radians(ang))
    R = int(math.hypot(w, h)) + cell
    for i in range(-R, R, cell):
        for j in range(-R, R, cell):
            x = i * ca - j * sa + w / 2; y = i * sa + j * ca + h / 2
            if 0 <= x < w and 0 <= y < h:
                r = (1 - g[int(y), int(x)]) * cell * 0.72
                if r > 0.4: d.ellipse([2 * (x - r), 2 * (y - r), 2 * (x + r), 2 * (y + r)], fill=0)
    return big.resize((w, h), Image.LANCZOS)

ht = halftone(gray)
alpha = Image.fromarray(mk * 255)
piece = Image.merge('RGBA', [ht, ht, ht, alpha])
# cream keyline: grow the mask, fill cream, put the halftone on top
key = Image.fromarray(cv2.dilate(mk * 255, np.ones((19, 19), np.uint8)))
pad = 24
cut = Image.new('RGBA', (piece.width + 2 * pad, piece.height + 2 * pad), (0, 0, 0, 0))
kl = Image.new('RGBA', piece.size, CREAM + (255,)); kl.putalpha(key)
cut.alpha_composite(kl, (pad, pad)); cut.alpha_composite(piece, (pad, pad))
sc = 1000 / cut.height; cut = cut.resize((int(cut.width * sc), int(cut.height * sc)), Image.LANCZOS)

# ── 3. paper pieces ───────────────────────────────────────────────────────
grain = Image.fromarray((np.random.RandomState(3).normal(0, 9, (H, W))).clip(-30, 30).astype(np.int16) + 128).convert('L')
def paper(rgb, size, shape='rect', torn=True, seed=0):
    w, h = size; r = random.Random(seed)
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    if shape == 'circle':
        pts = [(w / 2 + (w / 2 - 6 - r.uniform(0, 5)) * math.cos(a), h / 2 + (h / 2 - 6 - r.uniform(0, 5)) * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 90)]
    else:
        e = lambda: r.uniform(0, 9) if torn else 0
        pts = [(x, e()) for x in np.linspace(0, w, 24)] + [(w - e(), y) for y in np.linspace(0, h, 12)] + \
              [(x, h - e()) for x in np.linspace(w, 0, 24)] + [(e(), y) for y in np.linspace(h, 0, 12)]
    d.polygon(pts, fill=rgb + (255,))
    g = grain.crop((0, 0, w, h)); tex = Image.merge('RGBA', [g, g, g, Image.new('L', (w, h), 255)])
    im = ImageChops.multiply(im, Image.blend(Image.new('RGBA', (w, h), (255, 255, 255, 255)), tex, 0.35)); im.putalpha(Image.fromarray(np.array(im)[:, :, 3]))
    return im

# ── SCL VSL paper kit: every asset drawn in code (no stock, no copyright) ──
YEL, RED, WHITE = (247, 205, 49), (226, 54, 44), (250, 248, 242)
def torn(rgb, size, seed, fiber=True):
    """paper with a ragged edge and a thin white torn-fibre rim"""
    w, h = size
    base = paper(rgb, (w, h), seed=seed)
    if not fiber: return base
    rim = paper(WHITE, (w + 14, h + 14), seed=seed + 50)
    rim.alpha_composite(base, (7, 7)); return rim
def tape(w, seed):
    r = random.Random(seed); h = 62
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    zig = lambda x0, s: [(x0 + s * r.uniform(0, 8), y) for y in np.linspace(0, h, 9)]
    pts = [(p[0], p[1]) for p in zig(0, 1)][::-1] + [(w - p[0], p[1]) for p in zig(0, 1)]
    d.polygon(pts, fill=(236, 226, 196, 175)); return im
def scribble(w, rgb, seed):
    r = random.Random(seed); im = Image.new('RGBA', (w, 70), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    pts = [(x, 35 + 14 * math.sin(x / 38.0) + r.uniform(-3, 3)) for x in np.linspace(8, w - 8, 40)]
    d.line(pts, fill=rgb + (255,), width=11, joint='curve'); return im
def star(R, rgb, seed):
    r = random.Random(seed); im = Image.new('RGBA', (2 * R, 2 * R), (0, 0, 0, 0))
    pts = [(R + (R - 4 if i % 2 == 0 else R * 0.62) * math.cos(i * math.pi / 12), R + (R - 4 if i % 2 == 0 else R * 0.62) * math.sin(i * math.pi / 12)) for i in range(24)]
    ImageDraw.Draw(im).polygon(pts, fill=rgb + (255,)); return im
def arrow(seed):
    im = Image.new('RGBA', (260, 200), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    pts = [(20 + t * 200, 170 - 140 * math.sin(t * 1.4)) for t in np.linspace(0, 1, 30)]
    d.line(pts, fill=INK + (255,), width=9, joint='curve')
    ex, ey = pts[-1]; d.line([(ex - 34, ey + 8), (ex, ey), (ex - 18, ey + 34)], fill=INK + (255,), width=9, joint='curve'); return im
def dots(R, rgb, cell=22):
    im = Image.new('RGBA', (2 * R, 2 * R), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    for x in range(0, 2 * R, cell):
        for y in range(0, 2 * R, cell):
            if math.hypot(x - R, y - R) < R - cell: d.ellipse([x, y, x + cell * 0.55, y + cell * 0.55], fill=rgb + (255,))
    return im
def label(word, font, size, fg, bg, seed, padx=44, pady=28):
    if not word.strip(): return None
    f = ImageFont.truetype(font, size)
    l, tp, rr, bt = f.getbbox(word)
    p = torn(bg, (rr - l + 2 * padx, bt - tp + 2 * pady), seed)
    ImageDraw.Draw(p).text((padx + 7 - l, pady + 7 - tp), word, font=f, fill=fg)
    return p

line1, line2 = (text.split('|') + [''])[:2]

# ── [BROLL-POSTER] Swiss kinetic-type poster: ink field, a lime bar wipes in,
# grid lines draw, the keyword SLAMS in letter by letter (overshoot), the
# halftone portrait sits in a circle, a small mono label + frame counter.
def render_poster():
    ink = (12, 12, 12); lime = (215, 255, 26)
    F_BIG = f'{FONTS}/OpenSauceTwo-ExtraBold.ttf'
    word = (line2 or ' ').upper()
    size = 230
    while size > 90 and ImageFont.truetype(F_BIG, size).getlength(word) > 900: size -= 10
    fb = ImageFont.truetype(F_BIG, size); fs = ImageFont.truetype(F_BIG, 46)
    # portrait in a circle, top right
    R = 300
    port = cut.copy(); port.thumbnail((2 * R + 120, 2 * R + 160))
    disc = Image.new('RGBA', (2 * R, 2 * R), (0, 0, 0, 0))
    disc.paste(port, ((2 * R - port.width) // 2, 2 * R - port.height + 40), port)
    m = Image.new('L', (2 * R, 2 * R), 0); ImageDraw.Draw(m).ellipse([0, 0, 2 * R - 1, 2 * R - 1], fill=255)
    disc.putalpha(ImageChops.multiply(disc.split()[3], m))
    ring = Image.new('RGBA', (2 * R, 2 * R), (0, 0, 0, 0)); ImageDraw.Draw(ring).ellipse([0, 0, 2 * R - 1, 2 * R - 1], fill=lime + (255,))
    letters, x = [], 90
    for ch in word:
        letters.append((ch, x)); x += fb.getlength(ch) - size * 0.02
    ybig = 1180
    for fi in range(int(DUR * FPS)):
        ts = fi / FPS
        fr = Image.new('RGB', (W, H), ink); d = ImageDraw.Draw(fr)
        g = min(1, ts / 0.6)                                   # grid draws in
        for gx in range(90, W, 180): d.line([(gx, 0), (gx, H * g)], fill=(34, 34, 34), width=2)
        for gy in range(240, H, 240): d.line([(0, gy), (W * g, gy)], fill=(34, 34, 34), width=2)
        bw = ease(min(1, max(0, (ts - 0.25) / 0.35)))          # lime bar wipe
        d.rectangle([0, ybig - 40, int(W * bw), ybig - 22], fill=lime)
        u = ease(min(1, max(0, (ts - 0.45) / 0.45)))           # portrait circle grows
        if u > 0:
            rr = int(2 * R * (0.4 + 0.6 * u)); off = (2 * R - rr) // 2
            fr.paste(ring.resize((rr + 16, rr + 16)), (430 + off - 8, 330 + off - 8), ring.resize((rr + 16, rr + 16)))
            dd = disc.resize((rr, rr)); fr.paste(dd, (430 + off, 330 + off), dd)
        if line1 and ts > 0.9:                                  # small label types on
            n = int(min(len(line1), (ts - 0.9) * 40)); d.text((92, ybig - 120), line1[:n], font=fs, fill=lime)
        for i, (ch, lx) in enumerate(letters):                  # keyword slams in
            t0 = 1.15 + i * 0.07; v = (ts - t0) / 0.22
            if v <= 0: continue
            k = 1 + 0.6 * (1 - min(1, v)) ** 2 - (0.08 * math.sin(min(1, v) * math.pi) if v < 1 else 0)
            gl = Image.new('RGBA', (int(size * 1.4), int(size * 1.5)), (0, 0, 0, 0))
            ImageDraw.Draw(gl).text((size * 0.2, size * 0.15), ch, font=fb, fill=(250, 250, 245))
            gl = gl.resize((max(1, int(gl.width * k)), max(1, int(gl.height * k))))
            fr.paste(gl, (int(lx - size * 0.2 * k - (gl.width - size * 1.4) / 2), int(ybig - size * 0.15 * k - (gl.height - size * 1.5) / 2)), gl)
        cnt = f'{min(99, int(ts * 24)):02d}/{int(DUR * 24):02d}'
        d.text((W - 260, 150), cnt, font=fs, fill=(120, 120, 120))
        fr.save(f'{out}/f{fi:05d}.jpg', quality=92)

# ── [BROLL-PARTIKEL] particles converge into the keyword, then the halftone
# portrait fades in behind them; a slow drift keeps it alive.
def render_partikel():
    bg = (10, 10, 14); acc = ACC
    F_BIG = f'{FONTS}/BootzyTM.ttf'
    word = (line2 or ' ').lower()
    size = 240
    while size > 90 and ImageFont.truetype(F_BIG, size).getlength(word) > 880: size -= 10
    fb = ImageFont.truetype(F_BIG, size)
    m = Image.new('L', (W, H), 0); md = ImageDraw.Draw(m)
    tw = fb.getlength(word); md.text(((W - tw) / 2, 1150), word, font=fb, fill=255)
    pts = np.argwhere(np.array(m) > 128)
    rs = np.random.RandomState(5)
    if len(pts) > 2600: pts = pts[rs.choice(len(pts), 2600, replace=False)]
    tgt = pts[:, ::-1].astype(np.float32)
    src = np.stack([rs.uniform(-200, W + 200, len(tgt)), rs.uniform(-300, H + 300, len(tgt))], 1).astype(np.float32)
    delay = rs.uniform(0, 0.5, len(tgt))
    port = cut.copy(); port.thumbnail((900, 900))
    fs = ImageFont.truetype(f'{FONTS}/OpenSauceTwo-ExtraBold.ttf', 50)
    for fi in range(int(DUR * FPS)):
        ts = fi / FPS
        fr = Image.new('RGB', (W, H), bg)
        a = min(1, max(0, (ts - 1.4) / 0.8))                    # portrait fades in
        if a > 0:
            pp = port.copy(); pp.putalpha(pp.split()[3].point(lambda v: int(v * a * 0.55)))
            fr.paste(pp, ((W - pp.width) // 2, 1000 - pp.height), pp)
        u = np.clip((ts - 0.2 - delay) / 1.3, 0, 1); u = 1 - (1 - u) ** 3
        pos = src + (tgt - src) * u[:, None]
        pos[:, 1] += np.sin(ts * 2 + tgt[:, 0] / 40) * 2 * u    # gentle drift once settled
        d = ImageDraw.Draw(fr)
        for (px, py), uu in zip(pos, u):
            c = tuple(int(acc[i] + (250 - acc[i]) * uu) for i in range(3))
            d.ellipse([px - 2.4, py - 2.4, px + 2.4, py + 2.4], fill=c)
        if line1 and ts > 1.6:
            lw = fs.getlength(line1[:22]); d.text(((W - lw) / 2, 1050), line1[:22], font=fs, fill=acc)
        fr.save(f'{out}/f{fi:05d}.jpg', quality=92)

# ── shared punch helpers (Gen Z edit grammar: zoom punch, shake, flash) ──
def back_out(u, k=1.70158):
    u = min(1.0, max(0.0, u)); return 1 + (k + 1) * (u - 1) ** 3 + k * (u - 1) ** 2
def elastic(u):
    u = min(1.0, max(0.0, u))
    return 1.0 if u >= 1 else 1 - math.cos(u * math.pi * 4.5) * math.exp(-6 * u)
def shake(ts, hits, amp=26):
    """camera shake that decays over 0.25 s after each hit time"""
    dx = dy = 0.0
    for h in hits:
        v = ts - h
        if 0 <= v < 0.25:
            a = amp * (1 - v / 0.25); dx += math.sin(v * 90) * a; dy += math.cos(v * 70) * a * 0.7
    return int(dx), int(dy)
def outlined(text, font, fill, stroke, sw):
    l, t, r, b = font.getbbox(text, stroke_width=sw)
    im = Image.new('RGBA', (r - l + 8, b - t + 8), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((4 - l, 4 - t), text, font=font, fill=fill, stroke_width=sw, stroke_fill=stroke)
    return im
def fit_font(path, text, size, maxw, sw=0):
    while size > 70 and ImageFont.truetype(path, size).getlength(text) + 2 * sw > maxw: size -= 8
    return ImageFont.truetype(path, size)
def paste_scaled(fr, im, cx, cy, k, rot=0):
    if k <= 0.01: return
    im2 = im.resize((max(1, int(im.width * k)), max(1, int(im.height * k))), Image.BICUBIC)
    if rot: im2 = im2.rotate(rot, resample=Image.BICUBIC, expand=True)
    fr.paste(im2, (int(cx - im2.width / 2), int(cy - im2.height / 2)), im2)
F_XB = f'{FONTS}/OpenSauceTwo-ExtraBold.ttf'
F_BZ = f'{FONTS}/BootzyTM.ttf'

# ── [BROLL-IMPACT] manga speed lines, zoom-punch portrait, shake + white
# flash on every hit, red hand-drawn circle on the face + arrow, yellow
# keyword with a fat black outline.
def render_impact():
    Y = (255, 222, 0); RED_ = (235, 30, 40); K = (10, 10, 10)
    word = (line2 or ' ').upper()
    fk = fit_font(F_XB, word, 210, 900, 16)
    kw0 = outlined(word, fk, (255, 255, 255), K, 14)
    kw = Image.new('RGBA', (kw0.width + 80, kw0.height + 40), (0, 0, 0, 0))   # red slab behind the word
    ImageDraw.Draw(kw).polygon([(20, 8), (kw.width, 0), (kw.width - 20, kw.height - 6), (0, kw.height)], fill=RED_ + (255,))
    kw.alpha_composite(kw0, (40, 20))
    tag = None
    if line1:
        ft = ImageFont.truetype(F_XB, 62); tw = ft.getlength(line1[:20])
        tag = Image.new('RGBA', (int(tw) + 60, 100), K + (255,)); ImageDraw.Draw(tag).text((30, 12), line1[:20], font=ft, fill=Y)
    port = cut.copy(); port.thumbnail((980, 1000))
    pcx, pcy = W // 2, 300 + port.height // 2 + 140
    # face = centroid of the TOP 28 % of the cut-out's opaque pixels
    al = np.array(port.split()[3]); rows = np.where(al.max(1) > 0)[0]
    top = al[rows[0]: rows[0] + int((rows[-1] - rows[0]) * 0.28)]
    yy, xx = np.nonzero(top > 0)
    fx = int(pcx - port.width / 2 + (xx.mean() if len(xx) else port.width / 2))
    fy = int(pcy - port.height / 2 + rows[0] + (yy.mean() if len(yy) else 0) + 30)
    hits = [0.30, 1.25, 1.75]
    for fi in range(int(DUR * FPS)):
        ts = fi / FPS
        sx, sy = shake(ts, hits)
        fr = Image.new('RGB', (W, H), Y if int(ts * 12) % 2 == 0 or ts > 0.5 else (255, 255, 255))
        d = ImageDraw.Draw(fr)
        rot = ts * 0.35                                        # speed lines slowly rotate
        for i in range(72):
            a = rot + i * math.tau / 72
            w = 0.018 if i % 3 else 0.034
            p1 = (fx + math.cos(a - w) * 2600, fy + math.sin(a - w) * 2600)
            p2 = (fx + math.cos(a + w) * 2600, fy + math.sin(a + w) * 2600)
            d.polygon([(fx + math.cos(a) * 260, fy + math.sin(a) * 260), p1, p2], fill=K)
        u = (ts - 0.30) / 0.22                                 # zoom punch
        if u > 0:
            k = 1.35 - 0.35 * back_out(u)
            paste_scaled(fr, port, pcx + sx, pcy + sy, k)
        c = min(1, max(0, (ts - 1.0) / 0.35))                  # red circle draws itself
        if c > 0:
            bb = [fx - 210 + sx, fy - 230 + sy, fx + 210 + sx, fy + 210 + sy]
            d.arc(bb, start=-100, end=-100 + 360 * c, fill=RED_, width=16)
            if c >= 1:
                d.line([(fx + 330 + sx, fy - 420 + sy), (fx + 210 + sx, fy - 240 + sy)], fill=RED_, width=18)
                d.polygon([(fx + 190 + sx, fy - 205 + sy), (fx + 250 + sx, fy - 260 + sy), (fx + 195 + sx, fy - 280 + sy)], fill=RED_)
        v = (ts - 1.25) / 0.25                                 # keyword slam
        if v > 0:
            paste_scaled(fr, kw, W // 2 + sx, 1300 + sy, 1.8 - 0.8 * back_out(v), -4)
        if tag is not None and ts > 1.75:
            paste_scaled(fr, tag, 90 + tag.width / 2 + sx, 1150 + sy, back_out((ts - 1.75) / 0.2), 3)
        for h in hits:                                         # 2-frame white flash
            if 0 <= ts - h < 2 / FPS: fr = Image.blend(fr, Image.new('RGB', (W, H), (255, 255, 255)), 0.75)
        fr.save(f'{out}/f{fi:05d}.jpg', quality=92)

# ── [BROLL-GLITCH] RGB split + slice displacement on the portrait, scanlines,
# chromatic keyword with jitter frames, "● REC" + timecode like a vlog cam.
def render_glitch():
    rs = np.random.RandomState(9)
    word = (line2 or ' ').lower()
    fk = fit_font(F_XB, word, 200, 900)
    port = cut.copy(); port.thumbnail((1000, 1000))
    pa = np.array(Image.new('RGBA', (W, H), (0, 0, 0, 0)))
    base = Image.new('RGBA', (W, H), (0, 0, 0, 0)); base.paste(port, ((W - port.width) // 2, 1150 - port.height), port)
    pa = np.array(base).astype(np.int16)
    fs = ImageFont.truetype(F_XB, 44)
    lines_ = Image.new('L', (W, H), 0); dl = ImageDraw.Draw(lines_)
    for y in range(0, H, 6): dl.line([(0, y), (W, y)], fill=60)
    for fi in range(int(DUR * FPS)):
        ts = fi / FPS
        burst = (int(ts * 8) % 5 == 0) or ts < 0.35 or 1.2 < ts < 1.45
        fr = np.zeros((H, W, 3), np.int16) + np.array([12, 10, 18])
        if ts > 0.15:
            off = 18 if burst else 6
            img = pa.copy()
            if burst:                                          # slice displacement
                for _ in range(6):
                    y0_ = rs.randint(0, H - 80); hgt = rs.randint(12, 70)
                    img[y0_:y0_ + hgt] = np.roll(img[y0_:y0_ + hgt], rs.randint(-90, 90), axis=1)
            a = img[:, :, 3:4] / 255.0
            for ch, dx in ((0, -off), (1, 0), (2, off)):
                fr[:, :, ch] = (fr[:, :, ch] * (1 - np.roll(a, dx, 1)[:, :, 0]) + np.roll(img[:, :, ch], dx, 1) * np.roll(a, dx, 1)[:, :, 0])
        im = Image.fromarray(np.clip(fr, 0, 255).astype(np.uint8))
        im = Image.composite(Image.new('RGB', (W, H), (0, 0, 0)), im, lines_.point(lambda v: v // 2))
        d = ImageDraw.Draw(im)
        if ts > 0.9:                                           # chromatic keyword
            tw = fk.getlength(word); x = (W - tw) / 2; y = 1230
            j = rs.randint(-14, 14) if burst else 0
            d.text((x - 8 + j, y), word, font=fk, fill=(255, 0, 80))
            d.text((x + 8 + j, y), word, font=fk, fill=(0, 230, 255))
            d.text((x + j, y), word, font=fk, fill=(255, 255, 255))
        if line1 and ts > 1.4:
            n = int(min(len(line1), (ts - 1.4) * 30)); d.text((90, 1160), '> ' + line1[:n] + ('_' if int(ts * 4) % 2 else ''), font=fs, fill=(0, 255, 140))
        if int(ts * 2) % 2 == 0: d.ellipse([90, 330, 122, 362], fill=(255, 40, 40))
        d.text((138, 322), 'REC', font=fs, fill=(255, 255, 255))
        d.text((W - 330, 322), f'00:00:{int(ts):02d}:{fi % 24:02d}', font=fs, fill=(255, 255, 255))
        im.save(f'{out}/f{fi:05d}.jpg', quality=92)

# ── [BROLL-STIKER] sticker bomb: die-cut portrait with a fat white border
# bounces in (elastic), keyword sticker pops, sparkles twinkle, speech bubble.
def render_stiker():
    bgc = (196, 255, 74); dot = (170, 235, 50); K = (10, 10, 10)
    word = (line2 or ' ').lower()
    port = cut.copy(); port.thumbnail((860, 880))
    a = np.array(port.split()[3])
    border = Image.fromarray(cv2.dilate(a, np.ones((41, 41), np.uint8)))
    stk = Image.new('RGBA', port.size, (255, 255, 255, 255)); stk.putalpha(border)
    stk.alpha_composite(port)
    pad_ = 30; st2 = Image.new('RGBA', (stk.width + 2 * pad_, stk.height + 2 * pad_), (0, 0, 0, 0))
    sh = Image.new('RGBA', stk.size, (0, 0, 0, 90)); sh.putalpha(border.point(lambda v: v * 90 // 255))
    st2.alpha_composite(sh, (pad_ + 10, pad_ + 16)); st2.alpha_composite(stk, (pad_, pad_))
    fk = fit_font(F_BZ, word, 190, 820)
    l, t, r, b = fk.getbbox(word)
    lab = Image.new('RGBA', (r - l + 110, b - t + 90), (0, 0, 0, 0)); dd = ImageDraw.Draw(lab)
    dd.rounded_rectangle([0, 0, lab.width - 1, lab.height - 1], 44, fill=(255, 255, 255))
    dd.rounded_rectangle([14, 14, lab.width - 15, lab.height - 15], 34, fill=(255, 64, 160))
    dd.text((55 - l, 45 - t), word, font=fk, fill=(255, 255, 255), stroke_width=6, stroke_fill=K)
    bub = None
    if line1:
        fb_ = ImageFont.truetype(F_XB, 76); tw = fb_.getlength(line1[:20])
        bub = Image.new('RGBA', (int(tw) + 100, 190), (0, 0, 0, 0)); db = ImageDraw.Draw(bub)
        db.rounded_rectangle([0, 0, bub.width - 1, 140], 50, fill=(255, 255, 255), outline=K, width=7)
        db.polygon([(80, 134), (140, 134), (66, 186)], fill=(255, 255, 255), outline=K)
        db.text((50, 24), line1[:20], font=fb_, fill=K)
    sparks = [(150, 430, 0.9), (930, 500, 1.1), (160, 1000, 1.5), (940, 1060, 1.8), (540, 340, 2.1), (860, 1420, 2.4)]
    def spark(d, x, y, r, c):
        d.polygon([(x, y - r), (x + r * .22, y - r * .22), (x + r, y), (x + r * .22, y + r * .22), (x, y + r), (x - r * .22, y + r * .22), (x - r, y), (x - r * .22, y - r * .22)], fill=c)
    for fi in range(int(DUR * FPS)):
        ts = fi / FPS
        fr = Image.new('RGBA', (W, H), bgc + (255,)); d = ImageDraw.Draw(fr)
        for gy in range(0, H, 60):
            for gx in range((gy // 60 % 2) * 30, W, 60): d.ellipse([gx, gy, gx + 12, gy + 12], fill=dot)
        u = (ts - 0.2) / 0.7
        if u > 0:
            k = elastic(u); paste_scaled(fr, st2, W // 2, 760, k, 6 * (1 - min(1, u)) - 3)
        v = (ts - 1.1) / 0.55
        if v > 0: paste_scaled(fr, lab, W // 2, 1290, elastic(v), -5 + 2 * math.sin(ts * 3))
        if bub is not None and ts > 1.6: paste_scaled(fr, bub, 90 + bub.width / 2, 1090, back_out((ts - 1.6) / 0.25))
        for (x, y, t0) in sparks:
            w = ts - t0
            if w > 0:
                r = 78 * back_out(min(1, w / 0.2)) * (0.75 + 0.25 * math.sin(ts * 9 + x))
                spark(d, x, y, r, (255, 255, 255)); spark(d, x, y, r * 0.55, (255, 210, 0))
        fr.convert('RGB').save(f'{out}/f{fi:05d}.jpg', quality=92)

# ── [BROLL-OVERLAY] light cut-out inserts laid OVER the running video
# (transparent PNG frames, video keeps playing underneath). Used for the 2nd+
# B-roll of a clip so it is not always a full-screen takeover. Everything
# sits in the lower safe band (y 1000–1450) away from the speaker's face.
OV_OUT = 0.28   # seconds of exit animation at the end
def ov_k(ts, t_in=0.0, dur_in=0.45):
    """entrance back-out scale, then a quick shrink-out at the end"""
    k = back_out((ts - t_in) / dur_in) if ts > t_in else 0.0
    end = DUR - OV_OUT
    if ts > end: k *= max(0.0, 1 - (ts - end) / OV_OUT) ** 2
    return k
def save_rgba(fr, fi):
    fr.save(f'{out}/f{fi:05d}.png', compress_level=1)

def render_ov_pop():
    """sticker label pops with a scribble underline + sparkles"""
    word = (line2 or ' ').lower()
    fk = fit_font(F_BZ, word, 170, 780)
    l, t, r, b = fk.getbbox(word)
    lab = Image.new('RGBA', (r - l + 100, b - t + 80), (0, 0, 0, 0)); dd = ImageDraw.Draw(lab)
    dd.rounded_rectangle([0, 0, lab.width - 1, lab.height - 1], 40, fill=(255, 255, 255, 255))
    dd.rounded_rectangle([12, 12, lab.width - 13, lab.height - 13], 30, fill=ACC + (255,))
    dd.text((50 - l, 40 - t), word, font=fk, fill=(255, 255, 255), stroke_width=6, stroke_fill=(10, 10, 10))
    sh = Image.new('RGBA', lab.size, (0, 0, 0, 0)); sh.putalpha(lab.split()[3].point(lambda v: v * 110 // 255))
    sh = sh.filter(ImageFilter.GaussianBlur(8))
    tag = None
    if line1:
        ft = ImageFont.truetype(F_XB, 54); tw = ft.getlength(line1[:22])
        tag = Image.new('RGBA', (int(tw) + 50, 84), (255, 214, 0, 255)); ImageDraw.Draw(tag).text((25, 10), line1[:22], font=ft, fill=(10, 10, 10))
    cx, cy = int(OV_X or W // 2), int(OV_Y or 1300)
    for fi in range(int(DUR * FPS)):
        ts = fi / FPS
        fr = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(fr)
        k = ov_k(ts, 0.0)
        if k > 0:
            paste_scaled(fr, sh, cx + 10, cy + 16, k, -4); paste_scaled(fr, lab, cx, cy, k, -4)
        if tag is not None: paste_scaled(fr, tag, max(60 + tag.width / 2, cx - lab.width / 2 + tag.width / 2), cy - lab.height / 2 - 40, ov_k(ts, 0.25, 0.3), 3)
        u = min(1, max(0, (ts - 0.45) / 0.35)) * (1 if ts < DUR - OV_OUT else 0)
        if u > 0:                                              # underline draws itself
            w = lab.width * 0.8; x0 = cx - w / 2; y0 = cy + lab.height / 2 + 26
            pts = [(x0 + w * q, y0 + 9 * math.sin(q * 14)) for q in np.linspace(0, u, 30)]
            if len(pts) > 1: d.line(pts, fill=(235, 40, 50, 255), width=12, joint='curve')
        for (sx_, sy_, t0) in [(cx - lab.width / 2 - 30, cy - 90, 0.35), (cx + lab.width / 2 + 20, cy - 60, 0.5), (cx + lab.width / 2 - 40, cy + 110, 0.65)]:
            v = ts - t0
            if 0 < v and ts < DUR - OV_OUT:
                rr = 44 * back_out(min(1, v / 0.2)) * (0.8 + 0.2 * math.sin(ts * 10 + sx_))
                d.polygon([(sx_, sy_ - rr), (sx_ + rr * .22, sy_ - rr * .22), (sx_ + rr, sy_), (sx_ + rr * .22, sy_ + rr * .22), (sx_, sy_ + rr), (sx_ - rr * .22, sy_ + rr * .22), (sx_ - rr, sy_), (sx_ - rr * .22, sy_ - rr * .22)], fill=(255, 230, 60, 255))
        save_rgba(fr, fi)

def render_ov_polaroid():
    """halftone cut-out of the speaker in a polaroid that slides in from the side"""
    word = (line2 or ' ').lower()
    card = Image.new('RGBA', (360, 460), (250, 248, 242, 255)); dc = ImageDraw.Draw(card)
    port = cut.copy(); port.thumbnail((324, 324))
    win = Image.new('RGBA', (324, 324), BG + (255,)); win.alpha_composite(port, ((324 - port.width) // 2, 324 - port.height))
    card.paste(win, (18, 18))
    fk = fit_font(F_BZ, word, 66, 330)
    tw = fk.getlength(word); dc.text(((360 - tw) / 2, 362), word, font=fk, fill=(20, 20, 20))
    tp = tape(140, 4); card2 = Image.new('RGBA', (card.width, card.height + 30), (0, 0, 0, 0)); card2.alpha_composite(card, (0, 30)); card2.alpha_composite(tp, (110, 0))
    sh = Image.new('RGBA', card2.size, (0, 0, 0, 0)); sh.putalpha(card2.split()[3].point(lambda v: v * 120 // 255)); sh = sh.filter(ImageFilter.GaussianBlur(10))
    tx, ty = int(OV_X or 760), int(OV_Y or 1130)
    for fi in range(int(DUR * FPS)):
        ts = fi / FPS
        fr = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        u = ease(min(1, ts / 0.42)); x = tx + (1 - u) * 700
        end = DUR - OV_OUT
        if ts > end: x = tx + ((ts - end) / OV_OUT) ** 2 * 700
        rot = 7 - 3 * math.sin(min(1, ts / 0.6) * math.pi)
        r1 = card2.rotate(rot, resample=Image.BICUBIC, expand=True); r2 = sh.rotate(rot, resample=Image.BICUBIC, expand=True)
        fr.paste(r2, (int(x - r2.width / 2 + 12), int(ty - r2.height / 2 + 18)), r2)
        fr.paste(r1, (int(x - r1.width / 2), int(ty - r1.height / 2)), r1)
        if line1 and 0.4 < ts < end:
            tg = outlined(line1[:18], ImageFont.truetype(F_XB, 56), (255, 255, 255), (10, 10, 10), 7)
            paste_scaled(fr, tg, x - 40, ty - r1.height / 2 - 40, back_out((ts - 0.4) / 0.25), -3)
        save_rgba(fr, fi)

def render_ov_stamp():
    """round badge stamps in with a starburst behind it"""
    word = (line2 or ' ').upper()
    R = 170
    badge = Image.new('RGBA', (2 * R, 2 * R), (0, 0, 0, 0)); db = ImageDraw.Draw(badge)
    db.ellipse([0, 0, 2 * R - 1, 2 * R - 1], fill=(255, 255, 255, 255))
    lum = 0.299 * ACC[0] + 0.587 * ACC[1] + 0.114 * ACC[2]
    fill_ = ACC if lum < 170 else BG                  # light accent → white text unreadable, use the deep colour
    db.ellipse([12, 12, 2 * R - 13, 2 * R - 13], fill=fill_ + (255,))
    db.ellipse([28, 28, 2 * R - 29, 2 * R - 29], outline=(255, 255, 255, 255), width=4)
    fk = fit_font(F_XB, word, 72, 2 * R - 80)
    tw = fk.getlength(word); db.text((R - tw / 2, R - 40), word, font=fk, fill=(255, 255, 255), stroke_width=4, stroke_fill=(10, 10, 10))
    if line1:
        t1 = line1 if len(line1) <= 12 else line1.split(' ')[-1][:12]
        fs_ = fit_font(F_XB, t1, 34, 2 * R - 120); w1 = fs_.getlength(t1)
        db.text((R - w1 / 2, R - 92), t1, font=fs_, fill=(255, 230, 60))
    burst = Image.new('RGBA', (2 * R + 160, 2 * R + 160), (0, 0, 0, 0)); bb = ImageDraw.Draw(burst); C = R + 80
    pts = [(C + (C - 6 if i % 2 == 0 else C * 0.78) * math.cos(i * math.pi / 14), C + (C - 6 if i % 2 == 0 else C * 0.78) * math.sin(i * math.pi / 14)) for i in range(28)]
    bb.polygon(pts, fill=(255, 214, 0, 255))
    cx, cy = int(OV_X or 790), int(OV_Y or 1200)
    for fi in range(int(DUR * FPS)):
        ts = fi / FPS
        fr = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        k = ov_k(ts, 0.0, 0.4)
        if k > 0:
            paste_scaled(fr, burst, cx, cy, k * 1.02, ts * 25)
            paste_scaled(fr, badge, cx, cy, k, -12 + 6 * math.sin(ts * 4))
        save_rgba(fr, fi)

# ── [BROLL-CARDS] small paper cards that slide in beside the speaker —
# same family as the polaroid (user: "postcard kotak kecil", no flower stamps).
def slide_card(card, tx, ty, rot0=6, frm=1):
    sh = Image.new('RGBA', card.size, (0, 0, 0, 0)); sh.putalpha(card.split()[3].point(lambda v: v * 120 // 255)); sh = sh.filter(ImageFilter.GaussianBlur(10))
    end = DUR - OV_OUT
    for fi in range(int(DUR * FPS)):
        ts = fi / FPS
        fr = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        u = ease(min(1, ts / 0.42)); x = tx + frm * (1 - u) * 700
        if ts > end: x = tx + frm * ((ts - end) / OV_OUT) ** 2 * 700
        rot = rot0 - 3 * math.sin(min(1, ts / 0.6) * math.pi)
        r1 = card.rotate(rot, resample=Image.BICUBIC, expand=True); r2 = sh.rotate(rot, resample=Image.BICUBIC, expand=True)
        fr.paste(r2, (int(x - r2.width / 2 + 12), int(ty - r2.height / 2 + 18)), r2)
        fr.paste(r1, (int(x - r1.width / 2), int(ty - r1.height / 2)), r1)
        save_rgba(fr, fi)

def render_ov_note():
    """square lined note card: feelings / pain points"""
    word = (line2 or ' ').lower()
    cw = 380
    card = Image.new('RGBA', (cw, cw), (252, 246, 226, 255)); dc = ImageDraw.Draw(card)
    for y in range(96, cw - 20, 44): dc.line([(24, y), (cw - 24, y)], fill=(196, 214, 230), width=2)
    dc.line([(58, 0), (58, cw)], fill=(236, 150, 150), width=2)                    # margin line
    g = grain.crop((0, 0, cw, cw)); card = ImageChops.multiply(card, Image.merge('RGBA', [g, g, g, Image.new('L', (cw, cw), 255)]).point(lambda v: 205 + v * 50 // 255)); dc = ImageDraw.Draw(card)
    if line1:
        f1 = ImageFont.truetype(F_XB, 30); t1 = line1[:20]; dc.text((76, 52), t1, font=f1, fill=(120, 110, 100))
    fk = fit_font(F_BZ, word, 96, cw - 100)
    l, t, r, b = fk.getbbox(word); y = (cw - (b - t)) / 2 + 10
    dc.text((76 - l, y - t), word, font=fk, fill=(28, 26, 24))
    uy = y + (b - t) + 14; pts = [(76 + (r - l) * q, uy + 6 * math.sin(q * 12)) for q in np.linspace(0, 1, 30)]
    dc.line(pts, fill=ACC + (255,) if (0.299 * ACC[0] + 0.587 * ACC[1] + 0.114 * ACC[2]) < 200 else (235, 64, 52, 255), width=9, joint='curve')
    card2 = Image.new('RGBA', (cw, cw + 30), (0, 0, 0, 0)); card2.alpha_composite(card, (0, 30)); card2.alpha_composite(tape(150, 7), (cw // 2 - 75, 0))
    slide_card(card2, int(OV_X or 760), int(OV_Y or 1300), rot0=-5, frm=1 if (OV_X or 760) >= 540 else -1)

def render_ov_receipt():
    """little receipt slip: money words"""
    word = (line2 or ' ').upper()
    cw, ch = 330, 460
    card = Image.new('RGBA', (cw, ch), (0, 0, 0, 0)); dc = ImageDraw.Draw(card)
    zig = [(x, ch - 14 + (12 if (x // 15) % 2 else 0)) for x in range(cw, -1, -15)]
    dc.polygon([(0, 0), (cw, 0)] + zig, fill=(250, 250, 247, 255))
    fm = ImageFont.truetype(F_XB, 26); fk = fit_font(F_XB, word, 64, cw - 50)
    dash = lambda y: [dc.line([(x, y), (x + 9, y)], fill=(150, 150, 150), width=2) for x in range(22, cw - 22, 16)]
    dc.text((26, 30), (line1[:18] if line1 else ' '), font=fm, fill=(110, 110, 110))
    dash(78)
    tw = fk.getlength(word); dc.text(((cw - tw) / 2, 110), word, font=fk, fill=(20, 20, 20))
    dash(210)
    for i in range(3): dc.rectangle([26, 236 + i * 30, 26 + [190, 140, 220][i], 248 + i * 30], fill=(205, 205, 205))
    dash(340)
    rs_ = random.Random(len(word)); x = 40                      # decorative barcode
    while x < cw - 40:
        w_ = rs_.choice([2, 3, 5]); dc.rectangle([x, 360, x + w_, 420], fill=(30, 30, 30)); x += w_ + rs_.choice([2, 3, 4])
    slide_card(card, int(OV_X or 760), int(OV_Y or 1280), rot0=4, frm=1 if (OV_X or 760) >= 540 else -1)

# ── [BROLL-LIGHT] no-box inserts (user: "jangan semua kotak"): a strip of
# tape, a marker swipe, a hand-drawn circle + arrow, a tiny halftone cut-out.
def tape_label(w, h, seed):
    """opaque masking-tape strip for text (decorative tape stays see-through)"""
    r = random.Random(seed); im = Image.new('RGBA', (w, h), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    zig = lambda s_: [(s_ * r.uniform(0, 10), y) for y in np.linspace(0, h, 9)]
    pts = [(p[0], p[1]) for p in zig(1)][::-1] + [(w - p[0], p[1]) for p in zig(1)]
    d.polygon(pts, fill=(244, 236, 210, 245))
    g = grain.crop((0, 0, w, h)).point(lambda v: 215 + v * 40 // 255)
    return ImageChops.multiply(im, Image.merge('RGBA', [g, g, g, Image.new('L', (w, h), 255)]))
def _pos():
    return int(OV_X or 760), int(OV_Y or 1320)

def render_ov_tape():
    """keyword on a slanted strip of masking tape"""
    word = (line2 or ' ').lower(); cx, cy = _pos()
    fk = fit_font(F_BZ, word, 104, 700)
    l, t, r, b = fk.getbbox(word)
    lab = tape_label(int(r - l + 120), int(b - t + 70), 21)
    ImageDraw.Draw(lab).text((60 - l, 35 - t), word, font=fk, fill=(26, 24, 22))
    tag = outlined(line1[:18], ImageFont.truetype(F_XB, 46), (255, 255, 255), (10, 10, 10), 6) if line1 else None
    for fi in range(int(DUR * FPS)):
        ts = fi / FPS; fr = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        k = ov_k(ts, 0.0, 0.32)
        if k > 0: paste_scaled(fr, lab, cx, cy, k, -6)
        if tag is not None: paste_scaled(fr, tag, cx - lab.width / 2 + tag.width / 2 + 20, cy - lab.height / 2 - 34, ov_k(ts, 0.2, 0.25), -6)
        save_rgba(fr, fi)

def render_ov_highlight():
    """marker swipe draws across, the keyword sits on it"""
    word = (line2 or ' ').lower(); cx, cy = _pos()
    fk = fit_font(F_XB, word, 96, 760, 6)
    l, t, r, b = fk.getbbox(word); tw, th = r - l, b - t
    rs_ = random.Random(len(word))
    for fi in range(int(DUR * FPS)):
        ts = fi / FPS; fr = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(fr)
        end = DUR - OV_OUT
        u = ease(min(1, ts / 0.35)); a = 1.0 if ts < end else max(0, 1 - (ts - end) / OV_OUT)
        if u > 0 and a > 0:
            x0 = cx - tw / 2 - 30; x1 = x0 + (tw + 60) * u
            pts = [(x0, cy - th * 0.45), (x1, cy - th * 0.55), (x1 + 8, cy + th * 0.5), (x0 - 6, cy + th * 0.6)]
            d.polygon(pts, fill=(255, 226, 40, int(235 * a)))
        if ts > 0.18:
            v = back_out((ts - 0.18) / 0.25) * (a if ts > end else 1)
            if v > 0:
                tl = outlined(word, fk, (16, 16, 16), (255, 255, 255), 0)
                paste_scaled(fr, tl, cx, cy, v, -2)
        if line1 and 0.3 < ts < end:
            f1 = ImageFont.truetype(F_XB, 44); d.text((cx - tw / 2 - 20, cy - th - 40), line1[:20], font=f1, fill=(255, 255, 255), stroke_width=5, stroke_fill=(10, 10, 10))
        save_rgba(fr, fi)

def render_ov_scribble():
    """handwritten keyword, a red circle drawn round it, an arrow pointing in"""
    word = (line2 or ' ').lower(); cx, cy = _pos()
    fk = fit_font(F_BZ, word, 110, 640, 8)
    tl = outlined(word, fk, (255, 255, 255), (10, 10, 10), 8)
    rw, rh = tl.width * 0.62 + 40, tl.height * 0.75 + 30
    for fi in range(int(DUR * FPS)):
        ts = fi / FPS; fr = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(fr)
        k = ov_k(ts, 0.0, 0.3)
        if k > 0: paste_scaled(fr, tl, cx, cy, k, -4)
        c = min(1, max(0, (ts - 0.3) / 0.45)) * (1 if ts < DUR - OV_OUT else 0)
        if c > 0:
            pts = [(cx + rw * math.cos(a) * (1 + 0.04 * math.sin(a * 3)), cy + rh * math.sin(a) * 0.9) for a in np.linspace(-2.6, -2.6 + 6.6 * c, 50)]
            d.line(pts, fill=(235, 40, 50, 255), width=10, joint='curve')
        if ts > 0.8 and ts < DUR - OV_OUT:
            sgn = -1 if cx > 540 else 1
            ax, ay = cx + sgn * (rw + 30), cy - rh - 60
            d.line([(ax + sgn * 120, ay - 90), (ax, ay)], fill=(255, 255, 255, 255), width=9)
            d.polygon([(ax, ay), (ax + sgn * 40, ay - 8), (ax + sgn * 14, ay - 38)], fill=(255, 255, 255, 255))
        save_rgba(fr, fi)

def render_ov_cutout():
    """tiny halftone cut-out of the speaker (no card) + a tape label"""
    word = (line2 or ' ').lower(); cx, cy = _pos()
    port = cut.copy(); port.thumbnail((300, 330))
    fk = fit_font(F_BZ, word, 88, 420)
    l, t, r, b = fk.getbbox(word)
    lab = tape_label(int(r - l + 80), int(b - t + 50), 31)
    ImageDraw.Draw(lab).text((35 - l, 22 - t), word, font=fk, fill=(26, 24, 22))
    for fi in range(int(DUR * FPS)):
        ts = fi / FPS; fr = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        k = ov_k(ts, 0.0, 0.4)
        if k > 0: paste_scaled(fr, port, cx, cy - 40, k, 4 * math.sin(ts * 3))
        v = ov_k(ts, 0.25, 0.3)
        if v > 0: paste_scaled(fr, lab, cx, cy + port.height / 2 - 10, v, -5)
        save_rgba(fr, fi)

OVERLAYS = {'pop': render_ov_pop, 'polaroid': render_ov_polaroid, 'stamp': render_ov_stamp, 'note': render_ov_note, 'receipt': render_ov_receipt, 'tape': render_ov_tape, 'highlight': render_ov_highlight, 'scribble': render_ov_scribble, 'cutout': render_ov_cutout}
if STYLE in OVERLAYS:
    ease = lambda u: 1 - (1 - u) ** 3
    OVERLAYS[STYLE]()
    print(json.dumps({'ok': True, 'frames': int(DUR * FPS), 'fps': FPS, 'alpha': True}))
    sys.exit(0)

RENDERERS = {'poster': lambda: render_poster(), 'partikel': lambda: render_partikel(),
             'impact': lambda: render_impact(), 'glitch': lambda: render_glitch(), 'stiker': lambda: render_stiker()}
if STYLE in RENDERERS:
    ease = lambda u: 1 - (1 - u) ** 3
    RENDERERS[STYLE]()
    print(json.dumps({'ok': True, 'frames': int(DUR * FPS), 'fps': FPS}))
    sys.exit(0)
# Safe zone (Reels/TikTok/Shorts): text stays inside y 300–1450, x 60–900.
bsz = 200   # long words shrink so the label stays inside the safe zone
while bsz > 90 and ImageFont.truetype(f'{FONTS}/BootzyTM.ttf', bsz).getlength(line2) > 760: bsz -= 10
big = label(line2 or ' ', f'{FONTS}/BootzyTM.ttf', bsz, INK, WHITE, 6, 50, 34)
pieces = [  # (image, final x, final y, rot, enter at s, from)
    (paper(ACC, (840, 840), 'circle', seed=1), 120, 250, 0, 0.30, 'left'),
    (dots(170, YEL), 690, 160, 0, 0.55, 'top'),
    (cut, (W - cut.width) // 2 + 30, 1230 - cut.height, 0, 0.85, 'bottom'),
    (star(95, YEL, 3), 780, 820, 12, 1.30, 'right'),
    (label(line1[:22], f'{FONTS}/OpenSauceTwo-ExtraBold.ttf', 84 if len(line1) <= 14 else 64, INK, YEL, 5), 90, 1130, -5, 1.60, 'left'),
    (big, 130, 1240, 3, 1.95, 'right'),
    (tape(170, 8), 60, 1170, -38, 2.30, 'top'),
    (tape(170, 9), 130 + big.width - 90, 1180, 32, 2.40, 'top'),
    (scribble(big.width - 60, RED, 10), 160, 1240 + big.height - 30, 3, 2.70, 'left'),
    (arrow(11), 650, 960, 0, 3.00, 'right'),
]
pieces = [p for p in pieces if p[0] is not None]
pieces = [(im.rotate(rot, resample=Image.BICUBIC, expand=True), x, y, t0, fr) for im, x, y, rot, t0, fr in pieces]
shadow = lambda im: Image.merge('RGBA', [Image.new('L', im.size, 0)] * 3 + [im.split()[3].point(lambda a: a * 0.35).filter(ImageFilter.GaussianBlur(6))])

base = Image.new('RGBA', (W, H), BG + (255,))
bg_tex = Image.merge('RGBA', [grain, grain, grain, Image.new('L', (W, H), 255)])
base = ImageChops.multiply(base, Image.blend(Image.new('RGBA', (W, H), (255, 255, 255, 255)), bg_tex, 0.25))

ease = lambda u: 1 - (1 - u) ** 3
for fi in range(int(DUR * FPS)):
    ts = (fi // STEP) * STEP / FPS          # held pose → stop-motion cadence
    jit = random.Random(fi // STEP)
    fr = base.copy()
    for im, x, y, t0, frm in pieces:
        u = (ts - t0) / 0.42
        if u <= 0: continue
        u = ease(min(1, u))
        dx = {'left': -1300, 'right': 1300}.get(frm, 0) * (1 - u)
        dy = {'top': -1100, 'bottom': 1400}.get(frm, 0) * (1 - u)
        bx = int(x + dx + (jit.uniform(-2, 2) if u >= 1 else 0)); by = int(y + dy + (jit.uniform(-2, 2) if u >= 1 else 0))
        fr.alpha_composite(shadow(im), (bx + 9, by + 12)) if 0 <= bx + 9 < W and 0 <= by + 12 < H else None
        fr.paste(im, (bx, by), im)
    fr.convert('RGB').save(f'{out}/f{fi:05d}.jpg', quality=92)
print(json.dumps({'ok': True, 'frames': int(DUR * FPS), 'fps': FPS}))
