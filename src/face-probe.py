# [HOOK-FACE] Where are the faces during the hook window?
# Run by the app with the tracker bundle's python (`python -c <this file>`).
# argv: video, start, end. Samples ~8 frames in [start, end), runs mediapipe
# face detection, and prints one JSON line:
#   {"ok":true,"faces":[{"x0":..,"y0":..,"x1":..,"y1":..}, ...]}   (0..1 of the frame)
# Each box is widened to the whole head (hair above, chin below) because a
# hook on the forehead is as bad as one on the eyes.
import sys, json

def main():
    src, start, end = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    import cv2
    import mediapipe as mp
    cap = cv2.VideoCapture(src)
    det = mp.solutions.face_detection.FaceDetection(model_selection=1, min_detection_confidence=0.5)
    boxes = []
    n = 8
    for i in range(n):
        t = start + (end - start) * (i + 0.5) / n
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
        ok, frame = cap.read()
        if not ok:
            continue
        res = det.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        for d in (res.detections or []):
            b = d.location_data.relative_bounding_box
            w, h = b.width, b.height
            boxes.append({
                'x0': max(0.0, b.xmin - 0.15 * w), 'x1': min(1.0, b.xmin + 1.15 * w),
                'y0': max(0.0, b.ymin - 0.45 * h), 'y1': min(1.0, b.ymin + 1.25 * h),
            })
    print(json.dumps({'ok': True, 'faces': boxes}))
    sys.stdout.flush()

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)[:300]}))
        sys.stdout.flush()
