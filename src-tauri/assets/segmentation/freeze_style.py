"""Still portrait cut-out styles. Local MediaPipe model; no network or media uploads."""
import json
import sys
from pathlib import Path


def background(rgb, job, fallback):
    import cv2
    import numpy as np
    mode = job.get('backgroundMode', 'styled')
    h, w = rgb.shape[:2]
    if mode == 'original':
        return rgb.astype(np.float32).copy()
    if mode == 'color':
        value = job['backgroundColor']
        return np.full_like(rgb, [int(value[i:i+2],16) for i in (1,3,5)], dtype=np.float32)
    if mode == 'image':
        base_mode = job.get('backgroundBase', 'original')
        base = background(rgb, dict(job, backgroundMode=base_mode), fallback)
        cached = job.get('_background_image')
        if cached is None:
            image = cv2.imdecode(np.fromfile(job['backgroundImage'], dtype=np.uint8), cv2.IMREAD_UNCHANGED)
            if image is None:
                raise RuntimeError('The background image could not be read. Choose another image.')
            if image.ndim == 2:
                image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGRA)
            elif image.shape[2] == 3:
                image = cv2.cvtColor(image, cv2.COLOR_BGR2BGRA)
            cached = cv2.cvtColor(image, cv2.COLOR_BGRA2RGBA).astype(np.float32)
            job['_background_image'] = cached
        bw, bh = max(1, round(w*job.get('backgroundWidth',1))), max(1, round(h*job.get('backgroundHeight',1)))
        fit = job.get('backgroundFit', 'cover')
        key = (bw,bh,fit)
        if job.get('_placement_key') != key:
            scale = (max if fit == 'cover' else min)(bw/cached.shape[1], bh/cached.shape[0])
            # Premultiplication preserves transparent PNG edges during resampling.
            alpha = cached[...,3:4]/255
            rgba = np.concatenate((cached[...,:3]*alpha, alpha), axis=2)
            resized = cv2.resize(rgba, (max(1,round(cached.shape[1]*scale)), max(1,round(cached.shape[0]*scale))))
            if fit == 'cover':
                y,x = max(0,(resized.shape[0]-bh)//2),max(0,(resized.shape[1]-bw)//2)
                resized = resized[y:y+bh,x:x+bw]
            job['_placed_image'],job['_placement_key'] = resized,key
        image = job['_placed_image']
        ih,iw = image.shape[:2]
        cx,cy = w*job.get('backgroundX',.5),h*job.get('backgroundY',.5)
        p = float(job.get('_progress',1))
        p = max(0,min(1,p))
        eased = p*p*(3-2*p)
        motion = job.get('backgroundMotion','none')
        if motion == 'down': cy = (-ih/2)*(1-eased)+cy*eased
        elif motion == 'up': cy = (h+ih/2)*(1-eased)+cy*eased
        elif motion == 'right': cx = (-iw/2)*(1-eased)+cx*eased
        elif motion == 'left': cx = (w+iw/2)*(1-eased)+cx*eased
        elif motion == 'shake':
            cx += np.sin(p*np.pi*24)*w*.025*np.sin(p*np.pi)
            cy += np.sin(p*np.pi*34)*h*.015*np.sin(p*np.pi)
        left,top = round(cx-iw/2),round(cy-ih/2)
        x0,y0,x1,y1 = max(0,left),max(0,top),min(w,left+iw),min(h,top+ih)
        if x1>x0 and y1>y0:
            patch = image[y0-top:y1-top,x0-left:x1-left]
            base[y0:y1,x0:x1] = base[y0:y1,x0:x1]*(1-patch[...,3:4])+patch[...,:3]
        return base
    return fallback.copy()


def composite(rgb, confidence, job):
    import cv2
    import numpy as np
    h, w = rgb.shape[:2]
    mask = cv2.resize(confidence.astype(np.float32), (w, h))
    hard = (mask > 0.5).astype(np.float32)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(hard.astype(np.uint8), connectivity=8)
    if count <= 1:
        raise ValueError("No clear person could be separated. Try another frame or use Black & White/Paper.")
    largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    hard = (labels == largest).astype(np.float32)
    x, y, bw, bh, area = stats[largest]
    if area < h*w*0.005 or area > h*w*0.98 or mask.max() < 0.55:
        raise ValueError("No clear person could be separated. Try another frame or use Black & White/Paper.")
    mask = cv2.GaussianBlur(np.clip((mask-0.3)/0.4, 0, 1), (0, 0), 0.75)
    support = cv2.dilate(hard, np.ones((5,5), np.uint8))
    mask *= cv2.GaussianBlur(support, (0,0), 0.75)
    centre = (float(x)+(float(bw)-1)/2, float(y)+(float(bh)-1)/2)
    del labels, hard, support
    if job.get('_temporal'):
        old = job.get('_centre')
        if old is not None:
            centre = (old[0]*0.75+centre[0]*0.25, old[1]*0.75+centre[1]*0.25)
        job['_centre'] = centre
    zoom = float(job['subjectZoom'])
    transform = cv2.getRotationMatrix2D(centre, 0, zoom)
    # Premultiplied foreground avoids dark/bright fringes when the cut-out is enlarged.
    fg = cv2.warpAffine(rgb.astype(np.float32)*mask[..., None], transform, (w, h))
    alpha = cv2.warpAffine(mask, transform, (w, h))
    radius = max(1, round(float(job['outlineWidth'])*w/1080))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2*radius+1, 2*radius+1))
    border = cv2.dilate(alpha, kernel)
    paper = job['style'] == 'paper-outline'
    # Plain outline needs neither a paper grain field nor full-size coordinate grids.
    if paper:
        rng = np.random.default_rng(17)
        yy, xx = np.ogrid[:h, :w]
        grain = rng.normal(0, 2.8, (h, w)).astype(np.float32)
        grain += np.sin(yy.astype(np.float32)*0.8+np.sin(xx.astype(np.float32)*0.04))*1.2
    colour = lambda value: np.array([int(value[i:i+2],16) for i in (1,3,5)], dtype=np.float32)
    if paper:
        base = np.broadcast_to(colour(job['paperColor']), (h,w,3)).copy()
        base += grain[..., None]*float(job['intensity'])
        base = background(rgb, job, base)
        # Ragged paper silhouette and a soft offset shadow.
        rough = cv2.GaussianBlur(rng.random((h,w)).astype(np.float32), (0,0), 0.7)
        border = np.clip(border+(rough-0.5)*0.18*float(job['intensity']),0,1)*(border>0.01)
        shadow = cv2.warpAffine(border, np.float32([[1,0,radius*0.7],[0,1,radius*0.9]]), (w,h))
        shadow = cv2.GaussianBlur(shadow, (0,0), max(1.0,radius*0.6))*0.28
        base *= 1-shadow[...,None]
    else:
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
        base = background(rgb, job, np.repeat((gray*0.42)[...,None],3,axis=2))
    outline = colour(job['outlineColor'])
    if job.get('_foreground'):
        coverage = border*(1-alpha)+alpha
        premult = outline*border[...,None]*(1-alpha[...,None])+fg
        if paper:
            premult += grain[...,None]*alpha[...,None]*float(job['intensity'])*0.3
            coverage += shadow*(1-coverage)
        straight = np.divide(premult, np.maximum(coverage[...,None],1e-6))
        return np.clip(np.dstack((straight, coverage*255*float(job['opacity']))),0,255).astype(np.uint8)
    base = base*(1-border[...,None])+outline*border[...,None]
    result = base*(1-alpha[...,None])+fg
    if paper:
        result += grain[...,None]*alpha[...,None]*float(job['intensity'])*0.3
    opacity = float(job['opacity'])
    return np.clip(rgb.astype(np.float32)*(1-opacity)+result*opacity,0,255).astype(np.uint8)


def run(job):
    import cv2
    import mediapipe as mp
    import numpy as np
    from mediapipe.tasks.python import vision
    from mediapipe.tasks.python.core.base_options import BaseOptions
    if job['style'] not in ('outline','paper-outline'):
        raise ValueError('Unknown subject style')
    if not 1 <= float(job['subjectZoom']) <= 1.4 or not 1 <= float(job['outlineWidth']) <= 40:
        raise ValueError('Invalid subject style settings')
    bgr = cv2.imread(job['path'])
    if bgr is None or max(bgr.shape[:2]) > 1920:
        raise ValueError('Unreadable still image')
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    options = vision.ImageSegmenterOptions(
        base_options=BaseOptions(model_asset_path=str(Path(__file__).with_name('selfie_segmenter.tflite'))),
        running_mode=vision.RunningMode.IMAGE, output_confidence_masks=True, output_category_mask=False)
    with vision.ImageSegmenter.create_from_options(options) as segmenter:
        result = segmenter.segment(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)))
        mask = result.confidence_masks[-1].numpy_view().copy()
    output = composite(rgb, mask, job)
    if not cv2.imwrite(job['path'], cv2.cvtColor(output, cv2.COLOR_RGB2BGR)):
        raise RuntimeError('Could not save the styled frame')


if __name__ == '__main__':
    try:
        run(json.loads(sys.stdin.readline()))
        print(json.dumps({'ok':True}), flush=True)
    except Exception as error:
        print(json.dumps({'error':str(error)}), flush=True)
        sys.exit(1)
