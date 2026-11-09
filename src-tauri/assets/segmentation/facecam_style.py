"""Bounded-memory 2D facecam styles. Existing NumPy/OpenCV/MediaPipe + FFmpeg only.

Text is drawn by CutVii's native font renderer into small cropped RGBA plates.
Frames stream through pipes; no whole-clip buffers or browser renderer.
"""
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
FLAGS = subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0
STYLES = ('lean-in', 'slow-push', 'text-behind', 'backdrop-word', 'spotlight',
          'name-tag', 'silhouette-intro', 'bottom-fade', 'glass-card', 'freeze-sticker', 'cinema-label')
SUBJECT_STYLES = ('text-behind', 'backdrop-word', 'spotlight', 'silhouette-intro', 'freeze-sticker')


def emit(**value):
    print(json.dumps(value), flush=True)


def ease(p):
    p = max(0., min(1., p))
    return 1 - (1-p)**3


def envelope(t, seconds):
    ramp = min(.3, seconds/3)
    return ease(t/ramp) * ease((seconds-t)/ramp)


def colour(value):
    import numpy as np
    return np.array([int(value[i:i+2], 16) for i in (1, 3, 5)], np.float32)


def zoom_frame(frame, zoom, centre=None):
    import cv2
    h, w = frame.shape[:2]
    transform = cv2.getRotationMatrix2D(centre or (w/2, h/2), 0, zoom)
    return cv2.warpAffine(frame, transform, (w, h), borderMode=cv2.BORDER_REFLECT_101)


def place_frame(frame, x=.5, y=.5, zoom=1., mask=False):
    """Static framing, independent of the text/card anchors used by each style."""
    import cv2
    if not all(math.isfinite(v) for v in (x,y,zoom)) or not (0<=x<=1 and 0<=y<=1 and .5<=zoom<=2.5):
        raise ValueError('Invalid facecam framing')
    if x == .5 and y == .5 and zoom == 1:
        return frame
    h,w = frame.shape[:2]
    transform = cv2.getRotationMatrix2D((w/2,h/2),0,zoom)
    transform[0,2] += (x-.5)*w
    transform[1,2] += (y-.5)*h
    return cv2.warpAffine(frame,transform,(w,h),borderMode=cv2.BORDER_CONSTANT if mask else cv2.BORDER_REPLICATE,borderValue=0)


def read_plate(path):
    import cv2
    import numpy as np
    image = cv2.imdecode(np.fromfile(path, np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None or image.ndim != 3 or image.shape[2] != 4:
        raise ValueError('A native text plate is unavailable')
    box = cv2.boundingRect(image[..., 3])
    x, y, w, h = box
    if not w or not h:
        raise ValueError('Text contains no visible glyphs')
    return cv2.cvtColor(image[y:y+h, x:x+w], cv2.COLOR_BGRA2RGBA)


def stamp(frame, plate, cx, cy, opacity=1, scale=1):
    import cv2
    import numpy as np
    if opacity <= 0:
        return
    h, w = frame.shape[:2]
    if abs(scale-1) > .001:
        plate = cv2.resize(plate, (max(1, round(plate.shape[1]*scale)), max(1, round(plate.shape[0]*scale))))
    ph, pw = plate.shape[:2]
    x, y = round(cx-pw/2), round(cy-ph/2)
    x0, y0, x1, y1 = max(0,x), max(0,y), min(w,x+pw), min(h,y+ph)
    if x0 >= x1 or y0 >= y1:
        return
    patch = plate[y0-y:y1-y,x0-x:x1-x]
    alpha = patch[...,3:4].astype(np.float32)*(opacity/255)
    frame[y0:y1,x0:x1] = frame[y0:y1,x0:x1]*(1-alpha)+patch[...,:3]*alpha


def rounded_mask(w, h, radius):
    import cv2
    import numpy as np
    mask = np.zeros((h,w),np.float32)
    r = max(1,min(radius,w//2,h//2))
    cv2.rectangle(mask,(r,0),(w-r,h-1),1,-1)
    cv2.rectangle(mask,(0,r),(w-1,h-r),1,-1)
    for x,y in ((r,r),(w-r-1,r),(r,h-r-1),(w-r-1,h-r-1)):
        cv2.circle(mask,(x,y),r,1,-1)
    return mask[...,None]


def entry_transform(settings, t):
    mode = settings.get('entry','none')
    direction = settings.get('entryDirection','left')
    duration,delay = settings.get('entryDuration',.45),settings.get('entryDelay',0.)
    if mode not in ('none','slide','pop','slide-pop') or direction not in ('left','right','top','bottom') or not all(math.isfinite(v) for v in (duration,delay,t)) or not (.1<=duration<=3 and 0<=delay<=5):
        raise ValueError('Invalid facecam entrance')
    if mode == 'none' or t >= delay+duration:
        return 0.,0.,1.,1.
    p = max(0.,min(1.,(t-delay)/duration))
    k = ease(p)
    if settings.get('style') == 'cinema-label':
        # Subtle ease-out-back: fast travel followed by a small settling motion.
        k = 1+2.05*(p-1)**3+1.05*(p-1)**2
    dx = dy = 0.
    scale = 1.
    if mode in ('slide','slide-pop'):
        if direction == 'left': dx = -(1-k)
        if direction == 'right': dx = 1-k
        if direction == 'top': dy = -(1-k)
        if direction == 'bottom': dy = 1-k
    if mode in ('pop','slide-pop'):
        back = 1+2.70158*(p-1)**3+1.70158*(p-1)**2
        scale = .1+.9*back
    return dx,dy,scale,min(1.,p*5)


def text_transform(settings, t, seconds):
    incoming = entry_transform(settings, t)
    mode = settings.get('exit', 'follow')
    if mode == 'follow': mode = settings.get('entry', 'none')
    direction = settings.get('exitDirection', 'follow')
    if direction == 'follow': direction = settings.get('entryDirection', 'left')
    duration = settings.get('exitDuration', .45)
    if mode == 'none' or t < seconds-duration:
        return incoming
    outgoing = entry_transform(dict(settings, entry=mode, entryDirection=direction,
                                    entryDuration=duration, entryDelay=0), max(0, seconds-t))
    return (incoming[0]+outgoing[0], incoming[1]+outgoing[1],
            incoming[2]*outgoing[2], min(incoming[3],outgoing[3]))


def render_frame(rgb, mask, settings, plates, t, seconds):
    return _render_style_frame(rgb,mask,settings,plates,t,seconds)


def _render_style_frame(rgb, mask, settings, plates, t, seconds):
    import cv2
    import numpy as np
    position = (settings.get('frameX',.5),settings.get('frameY',.5),settings.get('frameZoom',1.))
    rgb = place_frame(rgb,*position)
    if mask is not None:
        mask = place_frame(mask,*position,mask=True)
    h,w = rgb.shape[:2]
    style = settings['style']
    k = envelope(t,seconds)
    if settings.get('entry','none') != 'none' and style in ('text-behind','backdrop-word','name-tag','glass-card','freeze-sticker','cinema-label'):
        k = ease((seconds-t)/min(.3,seconds/3))
    strength = settings['strength']
    accent = colour(settings['accent'])
    ink = colour(settings['textColor'])
    background = colour(settings['background'])
    x,y = settings['x']*w, settings['y']*h
    dx,dy,entry_scale,entry_alpha = text_transform(settings,t,seconds)
    if style in ('text-behind','backdrop-word','spotlight','name-tag','glass-card','freeze-sticker','cinema-label'):
        exit_mode = settings.get('exit','follow')
        if exit_mode == 'follow': exit_mode = settings.get('entry','none')
        if exit_mode != 'none':
            k = 1. if settings.get('entry','none') != 'none' else ease(t/min(.3,seconds/3))
    if style == 'cinema-label':
        result = rgb.copy()
        rows = [p for p in plates[:2] if p is not None]
        if not rows:
            return result
        # Plates are tightly cropped by read_plate. Both rows share a font
        # scale, remain left-aligned and sit beside a thin vertical accent.
        line_h = max(p.shape[0] for p in rows)
        scale = min(1., w*.7/max(p.shape[1] for p in rows))*entry_scale
        gap = max(2, round(line_h*.18))
        total_h = sum(p.shape[0]*scale for p in rows)+gap*(len(rows)-1)
        label_w = max(p.shape[1]*scale for p in rows)
        left = min(max(0,x),max(0,w-label_w-gap*2))+dx*(w*.28+label_w)
        top = min(max(0,y),max(0,h-total_h))+dy*(h*.18+total_h)
        alpha = max(0,min(1,k*entry_alpha))
        bar_w = max(1,round(w*.004))
        x0,y0 = max(0,round(left)),max(0,round(top))
        x1,y1 = min(w,round(left)+bar_w),min(h,round(top+total_h))
        if x1>x0 and y1>y0:
            result[y0:y1,x0:x1] = result[y0:y1,x0:x1]*(1-alpha)+accent*alpha
        cursor = top
        for plate in rows:
            ph,pw = plate.shape[:2]
            stamp(result,plate,left+bar_w+gap+pw*scale/2,cursor+ph*scale/2,opacity=alpha,scale=scale)
            cursor += ph*scale+gap
        return result
    if style == 'lean-in':
        ramp = min(5/30,seconds/4)
        punch = ease(t/ramp)*ease((seconds-t)/min(6/30,seconds/4))
        return zoom_frame(rgb,1+(settings['zoom']-1+.02*t/seconds)*punch)
    if style == 'slow-push':
        p = t/seconds
        z = 1+(settings['zoom']-1)*(p*p*(3-2*p))
        if not settings['parallax'] or mask is None:
            return zoom_frame(rgb,z)
        # Fill the room at low resolution before enlarging it: no duplicate person behind the cut-out.
        small_w = min(256,w)
        small_h = max(2,round(h*small_w/w))
        small = cv2.resize(rgb,(small_w,small_h))
        hole = (cv2.resize(mask,(small_w,small_h))>.2).astype(np.uint8)*255
        room = cv2.resize(cv2.inpaint(small,hole,3,cv2.INPAINT_TELEA),(w,h))
        room = cv2.GaussianBlur(room,(0,0),max(.1,4*strength*p*w/1080))
        room = zoom_frame(room,1+(z-1)*.35)
        alpha = zoom_frame(mask,z)[...,None]
        foreground = zoom_frame(rgb.astype(np.float32)*mask[...,None],z)
        return np.clip(room*(1-alpha)+foreground,0,255).astype(np.uint8)
    if style == 'bottom-fade':
        fade = np.clip((np.arange(h,dtype=np.float32)/h-.5)/.5,0,1)[:,None,None]
        return np.clip(rgb*(1-fade*strength*.95),0,255).astype(np.uint8)
    if style == 'silhouette-intro':
        alpha = mask[...,None] if mask is not None else np.zeros((h,w,1),np.float32)
        silhouette = background*(1-alpha)+accent*alpha
        reveal = ease((t-min(.35,seconds*.25))/min(.5,seconds*.5))
        return np.clip(silhouette*(1-reveal)+rgb*reveal,0,255).astype(np.uint8)
    result = rgb.copy()
    if style in ('text-behind','backdrop-word'):
        if entry_alpha <= 0:
            return result
        if style == 'text-behind':
            plate = plates[0]
            scale = min(1,w*.88/plate.shape[1])
            stamp(result,plate,x+dx*w,y+dy*h+(1-k)*h*.12,scale=scale*entry_scale,opacity=k*entry_alpha)
        else:
            gap = max(1,w*.008)
            widths = [p.shape[1] if p is not None else w*.035 for p in plates]
            total = sum(widths)+gap*max(0,len(widths)-1)
            fit = min(1,w*.88/max(1,total))*entry_scale
            cursor = x+dx*w-total*fit/2
            stagger = min(.055,seconds*.3/max(1,len(plates)))
            for i,(plate,width) in enumerate(zip(plates,widths)):
                arrival = 1 if settings.get('entry','none') != 'none' else ease((t-i*stagger)/min(.45,seconds*.35))
                leave = ease((seconds-t)/min(.24,seconds/4))
                if plate is not None:
                    stamp(result,plate,cursor+width*fit/2,y+dy*h-(1-arrival)*h*.45+(1-leave)*h*.12,
                          opacity=min(1,arrival*3)*leave*entry_alpha,scale=fit)
                cursor += (width+gap)*fit
        if mask is not None:
            result = np.clip(result*(1-mask[...,None])+rgb*mask[...,None],0,255).astype(np.uint8)
        return result
    if style == 'spotlight':
        alpha = mask if mask is not None else np.zeros((h,w),np.float32)
        rim = np.maximum(0,cv2.GaussianBlur(alpha,(0,0),max(1,w*.012))-alpha)
        dim = 1-.8*strength*k
        result = rgb.astype(np.float32)*dim
        result += rgb.astype(np.float32)*alpha[...,None]*(1-dim)
        result += accent*rim[...,None]*k*strength*.9
        if plates and entry_alpha > 0:
            stamp(result,plates[0],x+dx*w,y+dy*h+(1-k)*h*.05,opacity=k*entry_alpha,scale=min(1,w*.88/plates[0].shape[1])*entry_scale)
            result = result*(1-alpha[...,None])+rgb*alpha[...,None]
        return np.clip(result,0,255).astype(np.uint8)
    if style == 'freeze-sticker':
        from freeze_style import composite
        if mask is not None:
            result = composite(rgb,mask,dict(style='outline',subjectZoom=1+.04*ease(t/seconds),
                outlineWidth=4+10*strength,outlineColor=settings['accent'],backgroundMode='styled',opacity=1))
        # Text tag shares the held frame; sound continues through the unchanged source audio.
    if style in ('name-tag','freeze-sticker','glass-card'):
        if entry_alpha <= 0:
            return result
        plate = plates[0] if plates else None
        base_card_w = min(round(w*.84),max(round(w*.45),(plate.shape[1] if plate is not None else 0)+round(w*.08)))
        base_card_h = max(24,round(h*(.23 if style=='glass-card' else .075)))
        card_w = max(2,round(base_card_w*entry_scale))
        card_h = max(2,round(base_card_h*entry_scale))
        cx = x+dx*w-(1-k)*w*.65
        cy = y+dy*h+(1-k)*h*.04
        k *= entry_alpha
        left,top = round(cx-card_w/2),round(cy-card_h/2)
        x0,y0,x1,y1 = max(0,left),max(0,top),min(w,left+card_w),min(h,top+card_h)
        if x1>x0 and y1>y0:
            roi = result[y0:y1,x0:x1].astype(np.float32)
            if style=='glass-card':
                frosted = cv2.GaussianBlur(roi,(0,0),max(1,w*.009))
                tint = frosted*.55+background*.45
            else:
                tint = np.broadcast_to(background,roi.shape)
            alpha = rounded_mask(card_w,card_h,max(2,round(w*.025*entry_scale)))[y0-top:y1-top,x0-left:x1-left]*k*(.5+.45*strength)
            result[y0:y1,x0:x1] = roi*(1-alpha)+tint*alpha
            if k > .001:
                cv2.line(result,(max(0,left+round(w*.025)),max(0,top+round(card_h*.18))),
                     (max(0,left+round(w*.025)),min(h-1,top+round(card_h*.82))),tuple(int(v) for v in accent),max(1,round(w*.005)))
        if plate is not None:
            stamp(result,plate,cx,cy-card_h*.3 if style=='glass-card' else cy,
                  opacity=k,scale=min(1,(base_card_w-w*.1)/plate.shape[1],base_card_h*(.23 if style=='glass-card' else .65)/plate.shape[0])*entry_scale)
        if style=='glass-card':
            progress = ease(t/min(seconds*.65,1.1))
            value = settings['fromValue']+(settings['toValue']-settings['fromValue'])*progress
            text = f'{value:,.0f}'
            font = cv2.FONT_HERSHEY_DUPLEX
            size = max(.3,w/1080*4)*entry_scale
            tw = cv2.getTextSize(text,font,size,max(1,round(w*.004)))[0][0]
            size *= min(1,card_w*.8/max(1,tw))
            tw = cv2.getTextSize(text,font,size,max(1,round(w*.004)))[0][0]
            cv2.putText(result,text,(round(cx-tw/2),round(cy+card_h*.12)),font,size,
                        tuple(int(v) for v in ink),max(1,round(w*.004)),cv2.LINE_AA)
            if settings['graph']:
                points = np.array([(round(cx-card_w*.35+card_w*.7*i/20),round(cy+card_h*.39-card_h*.17*(i/20)**1.5)) for i in range(max(2,round(21*progress)))],np.int32)
                cv2.polylines(result,[points],False,tuple(int(v) for v in accent),max(1,round(w*.004)),cv2.LINE_AA)
        if style=='glass-card':
            return np.clip(rgb*(1-k)+result*k,0,255).astype(np.uint8)
        return result
    raise ValueError('Unknown facecam style')


def run(job):
    import cv2
    import numpy as np
    cv2.setNumThreads(2)
    w,h = int(job['width']),int(job['height'])
    fps,seconds,speed = float(job['fps']),float(job['seconds']),float(job['speed'])
    s = job['settings']
    if s['style'] not in STYLES or not (2<=w<=1920 and 2<=h<=1920 and w%2==0 and h%2==0 and 1<=fps<=30 and .2-1e-6<=seconds<=30.05 and .1<=speed<=10):
        raise ValueError('Unsupported facecam render settings')
    plates = [None if not path else read_plate(path) for path in job.get('plates',[])]
    if s['style'] in ('text-behind','backdrop-word','name-tag','freeze-sticker','glass-card') and not any(p is not None for p in plates):
        raise ValueError('Enter visible text for this style')
    subject = s['style'] in SUBJECT_STYLES or (s['style']=='slow-push' and s['parallax'])
    segmenter = None
    decode = encode = None
    output = Path(job['output']); temporary = output.with_name(output.stem+'.part.mp4')
    frames = people = 0
    previous = held_rgb = held_mask = None
    total = max(1,math.ceil(seconds*fps-1e-8))
    try:
        if subject:
            import mediapipe as mp
            from mediapipe.tasks.python import vision
            from mediapipe.tasks.python.core.base_options import BaseOptions
            segmenter = vision.ImageSegmenter.create_from_options(vision.ImageSegmenterOptions(
                base_options=BaseOptions(model_asset_path=str(Path(__file__).with_name('selfie_segmenter.tflite'))),
                running_mode=vision.RunningMode.VIDEO,output_confidence_masks=True,output_category_mask=False))
        with tempfile.TemporaryFile() as errors:
            vf = f'setpts=(PTS-STARTPTS)/{speed},fps={fps},scale={w}:{h},tpad=stop_mode=clone:stop_duration=1'
            if s['style']=='freeze-sticker':
                vf = f'select=eq(n\\,0),setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration={seconds+1},fps={fps},scale={w}:{h}'
            decode = subprocess.Popen([job['ffmpeg'],'-v','error','-nostdin','-threads','2','-filter_threads','1',
                '-ss',str(job['start']),'-t',str(job['sourceSeconds']),'-i',job['source'],'-an','-vf',vf,
                '-frames:v',str(total),'-pix_fmt','rgb24','-f','rawvideo','pipe:1'],stdout=subprocess.PIPE,stderr=errors,creationflags=FLAGS)
            encode = subprocess.Popen([job['ffmpeg'],'-v','error','-y','-filter_threads','1','-f','rawvideo','-pix_fmt','rgb24',
                '-s',f'{w}x{h}','-r',str(fps),'-i','pipe:0','-an','-c:v','libx264','-threads','2','-preset','fast',
                '-x264-params','rc-lookahead=8:sync-lookahead=0','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',str(temporary)],
                stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=errors,creationflags=FLAGS)
            count = w*h*3
            while frames<total:
                data = decode.stdout.read(count)
                if len(data)!=count:
                    raise RuntimeError('Incomplete decoded facecam frame')
                rgb = np.frombuffer(data,np.uint8).reshape(h,w,3)
                mask = None
                if subject:
                    if held_rgb is not None:
                        rgb,mask = held_rgb,held_mask
                    else:
                        result = segmenter.segment_for_video(mp.Image(image_format=mp.ImageFormat.SRGB,data=np.ascontiguousarray(rgb)),round(frames*1000/fps))
                        confidence = result.confidence_masks[-1].numpy_view().copy()
                        if previous is not None: confidence = confidence*.8+previous*.2
                        previous = confidence
                        candidate = cv2.resize(confidence,(w,h))
                        if np.count_nonzero(candidate>.55)>w*h*.005 and np.count_nonzero(candidate>.5)<w*h*.98:
                            mask = cv2.GaussianBlur(np.clip((candidate-.25)/.5,0,1),(0,0),.75)
                            people += 1
                        else:
                            previous = None
                        if s['style']=='freeze-sticker':
                            held_rgb,held_mask = rgb.copy(),mask
                # Sample at the last frame's exact endpoint so counters/entrances reach their target.
                t = frames*seconds/max(1,total-1)
                rendered = render_frame(rgb,mask,s,plates,t,seconds)
                encode.stdin.write(rendered.tobytes())
                frames += 1
                if frames==1 or frames%5==0: emit(fraction=min(.99,frames/total))
            decode.stdout.close();encode.stdin.close()
            decoded,encoded = decode.wait(timeout=30),encode.wait(timeout=120)
            if decoded!=0 or encoded!=0:
                errors.seek(0)
                raise RuntimeError('Facecam encoding failed: '+errors.read()[-1200:].decode('utf-8','replace'))
            if subject and people==0:
                raise ValueError('No clear person found. Try another range or a style without subject separation.')
        os.replace(temporary,output)
        emit(fraction=1,frames=frames,duration=frames/fps)
    finally:
        if segmenter is not None: segmenter.close()
        for process in (decode,encode):
            if process is not None and process.poll() is None:
                process.kill();process.wait()
        temporary.unlink(missing_ok=True)


if __name__=='__main__':
    try: run(json.loads(sys.stdin.readline()))
    except Exception as error:
        emit(error=str(error));sys.exit(1)
