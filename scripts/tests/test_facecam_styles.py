"""Run: python -B scripts/tests/test_facecam_styles.py (existing NumPy/OpenCV only)."""
import importlib.util
from pathlib import Path
import unittest
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'src-tauri' / 'assets' / 'segmentation'
import sys
sys.path.insert(0,str(SCRIPTS))
import facecam_style as effects

class FacecamFrames(unittest.TestCase):
    def setUp(self):
        self.rgb = np.full((320,180,3),140,np.uint8)
        self.mask = np.zeros((320,180),np.float32)
        self.mask[90:280,65:115] = 1
        self.plate = np.full((20,60,4),255,np.uint8)
        self.settings = dict(style='lean-in',strength=.8,zoom=1.25,x=.5,y=.2,accent='#E5733A',textColor='#FFFFFF',background='#14141C',parallax=False,fromValue=0,toValue=100,graph=True)
    def test_all_styles_return_rgb_frames_at_boundaries_and_midpoint(self):
        for style in effects.STYLES:
            for t in (0,.5,1):
                with self.subTest(style=style,t=t):
                    frame=effects.render_frame(self.rgb,self.mask,dict(self.settings,style=style),[self.plate],t,1)
                    self.assertEqual(frame.shape,self.rgb.shape)
                    self.assertEqual(frame.dtype,np.uint8)
    def test_behind_text_never_covers_the_person(self):
        frame=effects.render_frame(self.rgb,self.mask,dict(self.settings,style='text-behind',y=.4),[self.plate],.5,1)
        np.testing.assert_array_equal(frame[self.mask==1],self.rgb[self.mask==1])
        self.assertTrue(np.any(frame[self.mask==0]!=self.rgb[self.mask==0]))
    def test_camera_and_card_exit_cleanly_and_counter_can_count_down(self):
        for style in ('lean-in','name-tag','glass-card'):
            for t in (0,1):
                frame=effects.render_frame(self.rgb,self.mask,dict(self.settings,style=style,fromValue=100,toValue=-20),[self.plate],t,1)
                np.testing.assert_array_equal(frame,self.rgb)
    def test_backdrop_spaces_and_parallax_are_supported(self):
        for style in ('backdrop-word','slow-push'):
            frame=effects.render_frame(self.rgb,self.mask,dict(self.settings,style=style,parallax=True),[self.plate,None,self.plate],.5,1)
            self.assertEqual(frame.shape,self.rgb.shape)
    def test_silhouette_reveals_original_and_fade_only_darkens_bottom(self):
        frame=effects.render_frame(self.rgb,self.mask,dict(self.settings,style='silhouette-intro'),[],1,1)
        np.testing.assert_array_equal(frame,self.rgb)
        frame=effects.render_frame(self.rgb,None,dict(self.settings,style='bottom-fade'),[],.5,1)
        np.testing.assert_array_equal(frame[:100],self.rgb[:100])
        self.assertLess(float(frame[-1].mean()),float(self.rgb[-1].mean()))

    def test_placement_moves_pixels_and_mask_together(self):
        rgb = np.zeros_like(self.rgb)
        rgb[140:180,80:100] = 255
        mask = (rgb[...,0]>0).astype(np.float32)
        shifted = effects.place_frame(rgb,.7,.6,1.2)
        moved_mask = effects.place_frame(mask,.7,.6,1.2,mask=True)
        self.assertGreater(np.where(shifted[...,0]>240)[1].mean(),100)
        np.testing.assert_array_equal(shifted[...,0]>240,moved_mask>.95)
        np.testing.assert_array_equal(effects.place_frame(rgb),rgb)

    def test_all_styles_support_framing_without_moving_the_card_anchor(self):
        gradient=np.indices(self.rgb.shape[:2])[1].astype(np.uint8)
        rgb=np.repeat(gradient[...,None],3,axis=2)
        for style in effects.STYLES:
            changed=effects.render_frame(rgb,self.mask,dict(self.settings,style=style,frameX=.8,frameY=.2,frameZoom=1.4),[self.plate],.5,1)
            original=effects.render_frame(rgb,self.mask,dict(self.settings,style=style),[self.plate],.5,1)
            self.assertEqual(changed.shape,rgb.shape)
            self.assertTrue(np.any(changed!=original),style)
        left=effects.render_frame(self.rgb,self.mask,dict(self.settings,style='name-tag',frameX=.2),[self.plate],.5,1)
        right=effects.render_frame(self.rgb,self.mask,dict(self.settings,style='name-tag',frameX=.8),[self.plate],.5,1)
        np.testing.assert_array_equal(left,right)

    def test_entrance_directions_delay_pop_and_final_pose(self):
        for direction,axis,sign in [('left',0,-1),('right',0,1),('top',1,-1),('bottom',1,1)]:
            s=dict(self.settings,entry='slide',entryDirection=direction,entryDuration=.4,entryDelay=.2)
            before=effects.entry_transform(s,.1)
            middle=effects.entry_transform(s,.4)
            self.assertEqual(before[axis],sign)
            self.assertEqual(before[3],0)
            self.assertTrue(0<abs(middle[axis])<1)
            self.assertEqual(effects.entry_transform(s,.7),(0.,0.,1.,1.))
        for mode in ('pop','slide-pop'):
            s=dict(self.settings,entry=mode,entryDuration=.5)
            self.assertLess(effects.entry_transform(s,0)[2],.2)
            self.assertGreater(effects.entry_transform(s,.3)[2],1)
            self.assertEqual(effects.entry_transform(s,.6),(0.,0.,1.,1.))

    def test_all_styles_finish_entrance_at_the_original_final_framing(self):
        for style in effects.STYLES:
            base=dict(self.settings,style=style,frameX=.7,frameY=.4,frameZoom=1.3)
            for mode in ('slide','pop','slide-pop'):
                s=dict(base,entry=mode,entryDirection='right',entryDelay=.1,entryDuration=.4)
                finished=effects.render_frame(self.rgb,self.mask,s,[self.plate],.7,1)
                expected=effects.render_frame(self.rgb,self.mask,base,[self.plate],.7,1)
                np.testing.assert_array_equal(finished,expected)

    def test_name_tag_entrance_leaves_the_video_stationary_and_visible_during_delay(self):
        grid=np.indices(self.rgb.shape[:2])
        rgb=np.stack((grid[1]%255,grid[0]%255,(grid[0]+grid[1])%255),axis=2).astype(np.uint8)
        base=dict(self.settings,style='name-tag',x=.5,y=.75,entryDelay=.2,entryDuration=.4)
        for mode in ('slide','pop','slide-pop'):
            for direction in ('left','right','top','bottom'):
                s=dict(base,entry=mode,entryDirection=direction)
                delayed=effects.render_frame(rgb,self.mask,s,[self.plate],.1,1)
                np.testing.assert_array_equal(delayed,rgb)
                during=effects.render_frame(rgb,self.mask,s,[self.plate],.4,1)
                # The moving tag cannot move or repaint the footage outside its band.
                changed=np.any(during!=rgb,axis=2)
                self.assertGreater(np.count_nonzero(changed),0)
                self.assertLess(np.count_nonzero(changed),rgb.shape[0]*rgb.shape[1]*.25)
                np.testing.assert_array_equal(during[:100],rgb[:100])
                finished=effects.render_frame(rgb,self.mask,s,[self.plate],.7,1)
                expected=effects.render_frame(rgb,self.mask,dict(base,entry='none'),[self.plate],.7,1)
                np.testing.assert_array_equal(finished,expected)

if __name__=='__main__': unittest.main()
