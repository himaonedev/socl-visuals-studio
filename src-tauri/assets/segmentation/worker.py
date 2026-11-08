"""Local portrait segmentation. Requires Python, MediaPipe, NumPy and OpenCV.

Uses the bundled Apache-2.0 MediaPipe Selfie Segmenter. No network or API calls.
FFmpeg reads/writes selected source ranges; stdout is JSON progress only.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

FLAGS = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


def emit(**value):
    print(json.dumps(value), flush=True)


def run(job):
    import cv2
    import numpy as np
    import mediapipe as mp
    from mediapipe.tasks.python import vision
    from mediapipe.tasks.python.core.base_options import BaseOptions

    cv2.setNumThreads(2)
    width, height = int(job["width"]), int(job["height"])
    fps, seconds = float(job["fps"]), float(job["seconds"])
    if width < 2 or height < 2 or width > 4096 or height > 4096 or not 0 < fps <= 60 or not 0 < seconds <= 600:
        raise ValueError("Unsupported video size, frame rate or range")
    if job["mode"] not in ("remove", "blur"):
        raise ValueError("Unknown subject effect")
    ffmpeg, source = job["ffmpeg"], job["source"]
    output = Path(job["output"])
    temporary = output.with_name(output.stem + ".part" + output.suffix)
    total = max(1, round(fps * seconds))
    segmenter = vision.ImageSegmenter.create_from_options(vision.ImageSegmenterOptions(
        base_options=BaseOptions(model_asset_path=str(Path(__file__).with_name("selfie_segmenter.tflite"))),
        running_mode=vision.RunningMode.VIDEO, output_confidence_masks=True,
        output_category_mask=False))
    decode = encode = None
    frames = 0
    try:
        with tempfile.TemporaryFile() as errors:
            decode = subprocess.Popen([ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "2", "-filter_threads", "1",
                "-ss", str(job["start"]), "-t", str(seconds), "-i", source,
                "-vf", f"fps={fps},scale={width}:{height}", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
                stdout=subprocess.PIPE, stderr=errors, creationflags=FLAGS)
            remove = job["mode"] == "remove"
            codec = ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0",
                     "-row-mt", "1", "-threads", "2", "-deadline", "realtime", "-cpu-used", "6", "-crf", "24", "-b:v", "0",
                     "-c:a", "libopus", "-b:a", "128k"] if remove else [
                     "-c:v", "libx264", "-preset", "fast", "-threads", "2", "-x264-params", "rc-lookahead=8:sync-lookahead=0", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac"]
            encode = subprocess.Popen([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-filter_threads", "1",
                "-f", "rawvideo", "-pix_fmt", "rgba" if remove else "rgb24", "-s", f"{width}x{height}",
                "-r", str(fps), "-i", "pipe:0", "-ss", str(job["start"]), "-t", str(seconds), "-i", source,
                "-map", "0:v:0", "-map", "1:a:0?", *codec, str(temporary)],
                stdin=subprocess.PIPE, stderr=errors, creationflags=FLAGS)
            previous = None
            count = width * height * 3
            while True:
                data = decode.stdout.read(count)
                if not data:
                    break
                if len(data) != count:
                    raise RuntimeError("Incomplete decoded video frame")
                rgb = np.frombuffer(data, dtype=np.uint8).reshape(height, width, 3)
                image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
                result = segmenter.segment_for_video(image, round(frames * 1000 / fps))
                mask = result.confidence_masks[-1].numpy_view().astype(np.float32)
                mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_LINEAR)
                mask = cv2.GaussianBlur(np.clip(mask, 0, 1), (0, 0), 1.0)
                if previous is not None:
                    mask = mask * 0.8 + previous * 0.2
                previous = mask
                if remove:
                    frame = np.dstack((rgb, np.rint(mask * 255).astype(np.uint8)))
                else:
                    background = cv2.GaussianBlur(rgb, (0, 0), float(job.get("blur", 20)))
                    frame = np.clip(rgb * mask[..., None] + background * (1 - mask[..., None]), 0, 255).astype(np.uint8)
                encode.stdin.write(frame.tobytes())
                frames += 1
                if frames == 1 or frames % 5 == 0:
                    emit(fraction=min(0.99, frames / total))
            decode.stdout.close()
            encode.stdin.close()
            if decode.wait(timeout=30) != 0 or encode.wait(timeout=120) != 0 or frames == 0:
                errors.seek(0)
                raise RuntimeError("Subject effect render failed: " + errors.read()[-1200:].decode("utf-8", "replace"))
        os.replace(temporary, output)
        emit(fraction=1.0, frames=frames, duration=frames / fps)
    finally:
        segmenter.close()
        for process in (decode, encode):
            if process is not None and process.poll() is None:
                process.kill()
                process.wait()
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        run(json.loads(sys.stdin.readline()))
    except Exception as error:
        emit(error=str(error))
        sys.exit(1)
