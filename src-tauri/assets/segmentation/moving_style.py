"""Render local moving highlight styles to a silent video; source audio stays on the editor timeline."""
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True
FLAGS = subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0


def emit(**value):
    print(json.dumps(value), flush=True)


def field_maps(w, h, settings):
    import numpy as np
    yy, xx = np.ogrid[:h, :w]
    yy, xx = yy.astype(np.float32), xx.astype(np.float32)
    cell = min(40, max(2, settings['spacing']*w/1080))
    angle = math.radians(20)
    u = math.cos(angle)*xx+math.sin(angle)*yy
    v = -math.sin(angle)*xx+math.cos(angle)*yy
    bend = settings['bend']
    if settings['pattern'] == 'wave':
        u += bend*w*0.065*np.sin(2*math.pi*yy/(w*0.75)+0.65*np.sin(2*math.pi*xx/(w*1.3)))
        v += bend*w*0.065*0.8*np.sin(2*math.pi*xx/(w*0.9)+0.6*np.sin(2*math.pi*yy/(w*1.1)))
    elif settings['pattern'] == 'radial':
        dx, dy = xx-w*0.5, yy-h*0.5
        radius, angle = np.hypot(dx, dy), np.arctan2(dy, dx)
        v = radius+bend*w*0.025*np.sin(angle*4+radius/(w*0.2))
        ring = np.maximum(np.floor(v/cell), 0)
        count = np.maximum(np.floor(2*math.pi*(ring+0.5)+0.5), 6)
        u = angle/(2*math.pi)*count*cell
    distance = np.hypot(np.remainder(u, cell)-cell/2, np.remainder(v, cell)-cell/2).astype(np.float32)
    return cell, distance, None


def paper_grain(w, h):
    import numpy as np
    yy, xx = np.ogrid[:h, :w]
    key = xx.astype(np.uint32)*np.uint32(374761393)+yy.astype(np.uint32)*np.uint32(668265263)
    key = (key ^ (key >> 13))*np.uint32(1274126177)
    return (((key & 65535).astype(np.float32)/65535-0.5)*15+np.sin(yy.astype(np.float32)*0.85+np.sin(xx.astype(np.float32)*0.035))*1.5).astype(np.float32)


def colour(hex_colour):
    import numpy as np
    return np.array([int(hex_colour[i:i+2], 16) for i in (1, 3, 5)], np.float32)


def style_frame(rgb, settings, maps):
    import numpy as np
    original = rgb.astype(np.float32)
    luma = (original[..., 0]*0.2126+original[..., 1]*0.7152+original[..., 2]*0.0722)/255
    contrast = np.clip((luma-0.5)*1.12+0.5, 0, 1)
    style = settings['style']
    if style == 'mono':
        effect = np.repeat((contrast*255)[..., None], 3, axis=2)
    elif style == 'paper':
        dark, paper = colour(settings['darkColor']), colour(settings['paperColor'])
        grain = maps
        effect = dark+(paper-dark)*contrast[..., None]+grain[..., None]*settings['intensity']
    elif style == 'outline':
        effect = np.repeat((luma*255*0.42)[..., None], 3, axis=2)
    elif style == 'paper-outline':
        grain = maps
        effect = np.broadcast_to(colour(settings['paperColor']), original.shape)+grain[..., None]*settings['intensity']
    else:
        cell, distance, _ = maps
        radius = np.sqrt(1-luma)*cell*0.7
        paper = np.clip(distance-radius+0.5, 0, 1)
        tone = luma*(1-settings['intensity'])+paper*settings['intensity']
        dark, light = colour(settings['darkColor']), colour(settings['color'])
        effect = dark+(light-dark)*tone[..., None]
    opacity = settings['opacity']
    return np.clip(np.rint(original*(1-opacity)+effect*opacity), 0, 255).astype(np.uint8)


def run(job):
    import numpy as np
    width, height = int(job['width']), int(job['height'])
    fps, seconds, speed = float(job['fps']), float(job['seconds']), float(job['speed'])
    if not 2 <= width <= 1920 or not 2 <= height <= 1920 or width % 2 or height % 2:
        raise ValueError('Unsupported moving video dimensions')
    if not 1 <= fps <= 30 or not 0.2-1e-6 <= seconds <= 120+1e-6 or not 0.1 <= speed <= 10:
        raise ValueError('Unsupported moving video range')
    settings = job['settings']
    subject = settings['style'] in ('outline', 'paper-outline')
    if settings['style'] not in ('halftone', 'mono', 'paper', 'outline', 'paper-outline'):
        raise ValueError('Unknown moving style')
    output = Path(job['output'])
    temporary = output.with_name(output.stem+'.part.mp4')
    total = max(1, math.ceil(seconds*fps-1e-8))
    segmenter = None
    layers = job.get('layers')
    subject_output = Path(layers['subject']) if layers else None
    overlay_output = Path(layers['overlay']) if layers else None
    subject_temp = subject_output.with_name(subject_output.stem+'.part.webm') if layers else None
    overlay_temp = overlay_output.with_name(overlay_output.stem+'.part.png') if layers else None
    decode = encode = subject_encode = None
    frames = people = 0
    previous = None
    if subject:
        import mediapipe as mp
        from mediapipe.tasks.python import vision
        from mediapipe.tasks.python.core.base_options import BaseOptions
        from freeze_style import composite
        segmenter = vision.ImageSegmenter.create_from_options(vision.ImageSegmenterOptions(
            base_options=BaseOptions(model_asset_path=str(Path(__file__).with_name('selfie_segmenter.tflite'))),
            running_mode=vision.RunningMode.VIDEO, output_confidence_masks=True, output_category_mask=False))
    settings = dict(settings, _temporal=True, _foreground=bool(layers))
    import cv2
    cv2.setNumThreads(2)
    maps = (field_maps(width, height, settings) if settings['style'] == 'halftone'
            else paper_grain(width, height) if settings['style'] in ('paper', 'paper-outline') else None)
    try:
        with tempfile.TemporaryFile() as errors:
            video_filter = f'setpts=(PTS-STARTPTS)/{speed},fps={fps},scale={width}:{height},tpad=stop_mode=clone:stop_duration=1'
            if job.get('freezeSource'):
                video_filter = f'select=eq(n\\,0),setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration={seconds+1},fps={fps},scale={width}:{height}'
            decode = subprocess.Popen([job['ffmpeg'], '-v', 'error', '-nostdin', '-threads', '2', '-filter_threads', '1', '-ss', str(job['start']),
                '-t', str(job['sourceSeconds']), '-i', job['source'], '-an', '-vf',
                video_filter,
                '-frames:v', str(total), '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
                stdout=subprocess.PIPE, stderr=errors, creationflags=FLAGS)
            encode = subprocess.Popen([job['ffmpeg'], '-v', 'error', '-y', '-filter_threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
                '-s', f'{width}x{height}', '-r', str(fps), '-i', 'pipe:0', '-an', '-c:v', 'libx264',
                '-preset', 'fast', '-threads', '2', '-x264-params', 'rc-lookahead=8:sync-lookahead=0', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(temporary)],
                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=errors, creationflags=FLAGS)
            if layers:
                subject_encode = subprocess.Popen([job['ffmpeg'], '-v', 'error', '-y', '-filter_threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba',
                    '-s', f'{width}x{height}', '-r', str(fps), '-i', 'pipe:0', '-an', '-c:v', 'libvpx-vp9',
                    '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', '24',
                    '-deadline', 'realtime', '-cpu-used', '6', '-row-mt', '1', '-threads', '2', str(subject_temp)],
                    stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=errors, creationflags=FLAGS)
            count = width*height*3
            while frames < total:
                data = decode.stdout.read(count)
                if not data:
                    break
                if len(data) != count:
                    raise RuntimeError('Incomplete moving video frame')
                rgb = np.frombuffer(data, np.uint8).reshape(height, width, 3)
                settings["_progress"] = frames/max(1,total-1)
                if subject:
                    result = segmenter.segment_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)), round(frames*1000/fps))
                    mask = result.confidence_masks[-1].numpy_view().copy()
                    if previous is not None:
                        mask = mask*0.8+previous*0.2
                    previous = mask
                    try:
                        rendered = composite(rgb, mask, settings)
                        people += 1
                    except ValueError:
                        # The person may leave the shot. Do not carry their previous silhouette into an empty frame.
                        previous = None
                        settings.pop('_centre', None)
                        from freeze_style import background
                        fallback = style_frame(rgb, settings, maps).astype(np.float32)
                        base = background(rgb, settings, fallback)
                        rendered = np.zeros((height,width,4),np.uint8) if layers else np.clip(rgb.astype(np.float32)*(1-settings['opacity'])+base*settings['opacity'],0,255).astype(np.uint8)
                else:
                    rendered = style_frame(rgb, settings, maps)
                if layers:
                    import cv2
                    from freeze_style import background
                    if frames == 0:
                        # Recover alpha by compositing the placed image over black and white.
                        image_job = dict(settings, backgroundBase='original', backgroundMotion='none')
                        black = background(np.zeros_like(rgb), image_job, np.zeros_like(rgb))
                        white = background(np.full_like(rgb,255), image_job, np.full_like(rgb,255))
                        alpha = np.clip(1-(white-black).mean(axis=2)/255,0,1)
                        straight = black/np.maximum(alpha[...,None],1e-6)
                        plate = np.clip(np.dstack((straight,alpha*255*settings['opacity'])),0,255).astype(np.uint8)
                        if not cv2.imwrite(str(overlay_temp),cv2.cvtColor(plate,cv2.COLOR_RGBA2BGRA)):
                            raise RuntimeError('Could not save editable image layer')
                    subject_encode.stdin.write(rendered.tobytes())
                    fallback = style_frame(rgb, dict(settings,opacity=1), maps).astype(np.float32)
                    base = background(rgb, dict(settings, backgroundMode=settings.get('backgroundBase','original')), fallback)
                    rendered = np.clip(rgb.astype(np.float32)*(1-settings['opacity'])+base*settings['opacity'],0,255).astype(np.uint8)
                encode.stdin.write(rendered.tobytes())
                frames += 1
                if frames == 1 or frames % 5 == 0:
                    emit(fraction=min(0.99, frames/total))
            decode.stdout.close()
            encode.stdin.close()
            if subject_encode:
                subject_encode.stdin.close()
            decoded, encoded = decode.wait(timeout=30), encode.wait(timeout=120)
            if subject_encode and subject_encode.wait(timeout=120) != 0:
                raise RuntimeError('Could not encode transparent subject layer')
            if decoded != 0 or encoded != 0 or frames != total:
                errors.seek(0)
                raise RuntimeError('Moving style render failed: '+errors.read()[-1200:].decode('utf-8', 'replace'))
            if subject and people == 0:
                raise ValueError('No clear person was found in the selected range. Try another range or a non-subject style.')
        if layers:
            os.replace(subject_temp,subject_output)
            os.replace(overlay_temp,overlay_output)
        os.replace(temporary, output)
        emit(fraction=1, frames=frames, duration=frames/fps)
    finally:
        if segmenter is not None:
            segmenter.close()
        for process in (decode, encode, subject_encode):
            if process is not None and process.poll() is None:
                process.kill()
                process.wait()
        temporary.unlink(missing_ok=True)
        if layers:
            subject_temp.unlink(missing_ok=True)
            overlay_temp.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        run(json.loads(sys.stdin.readline()))
    except Exception as error:
        emit(error=str(error))
        sys.exit(1)
