# [CUTOUT-FX] Person cut-out for a title's video effect.
# Run by the app with the tracker bundle's own python (`python -c <this file>`),
# which already ships mediapipe + opencv for face tracking — no new download.
# Reads frames [start, end) of argv[1], writes composited JPEG frames to argv[2];
# argv[5] = background tint as 'r,g,b' in 0..1 (default pink #FF3FA4):
#   person  -> black & white, contrast lifted
#   others  -> pink duotone (luma * pink), same coefficients as the burn's
#              colorchannelmixer duotone
# Prints one JSON line {"ok":true,"frames":N,"fps":F} (or {"ok":false,...}).
import sys, json, os

def main():
    src, outdir, start, end = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
    import cv2
    import numpy as np
    import mediapipe as mp
    os.makedirs(outdir, exist_ok=True)
    cap = cv2.VideoCapture(src)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000.0)
    seg = mp.solutions.selfie_segmentation.SelfieSegmentation(model_selection=0)
    rgb_t = [float(v) for v in (sys.argv[5] if len(sys.argv) > 5 else '1,0.247,0.643').split(',')]
    tint = np.array([rgb_t[2], rgb_t[1], rgb_t[0]], dtype=np.float32)   # BGR
    gain = 1.45
    prev = None
    n = 0
    while True:
        t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
        if t >= end:
            break
        ok, frame = cap.read()
        if not ok:
            break
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        m = seg.process(rgb).segmentation_mask
        if m is None:
            m = np.zeros(frame.shape[:2], dtype=np.float32)
        m = m.astype(np.float32)
        # Temporal smoothing kills edge flicker; a small blur feathers the edge.
        if prev is not None:
            m = 0.6 * m + 0.4 * prev
        prev = m
        m = cv2.GaussianBlur(np.clip((m - 0.35) / 0.3, 0, 1), (0, 0), 2.0)[..., None]
        luma = (0.299 * frame[..., 2] + 0.587 * frame[..., 1] + 0.114 * frame[..., 0]).astype(np.float32) / 255.0
        bw = np.clip((luma - 0.5) * 1.35 + 0.52, 0, 1)[..., None] * 255.0
        bw = np.repeat(bw, 3, axis=2)
        duo = np.clip(luma[..., None] * gain * tint[None, None, :] * 255.0, 0, 255)
        out = (bw * m + duo * (1.0 - m)).astype(np.uint8)
        cv2.imwrite(os.path.join(outdir, 'f%05d.jpg' % n), out, [cv2.IMWRITE_JPEG_QUALITY, 94])
        n += 1
    print(json.dumps({'ok': n > 0, 'frames': n, 'fps': fps}))
    sys.stdout.flush()

if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # report, never hang the render
        print(json.dumps({'ok': False, 'error': str(e)[:300]}))
        sys.stdout.flush()
