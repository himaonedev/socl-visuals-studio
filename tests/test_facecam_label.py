import importlib.util
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('facecam_style', Path(__file__).parents[1] / 'src-tauri/assets/segmentation/facecam_style.py')
facecam = importlib.util.module_from_spec(spec)
spec.loader.exec_module(facecam)


class CinemaSlideTests(unittest.TestCase):
    def settings(self, direction='left'):
        return dict(style='cinema-label', entry='slide', entryDirection=direction,
                    entryDuration=.65, entryDelay=0, strength=.8, accent='#E50914',
                    textColor='#FFFFFF', background='#000000', x=.1, y=.1)

    def test_direction_settling_and_final_anchor(self):
        for direction in ['left', 'right', 'top', 'bottom']:
            s = self.settings(direction)
            start = facecam.entry_transform(s, 0)
            end = facecam.entry_transform(s, .65)
            self.assertEqual(end, (0., 0., 1., 1.))
            self.assertEqual(start[3], 0)
            self.assertTrue(abs(start[0]) + abs(start[1]) > .9)
            settle = facecam.entry_transform(s, .5)
            axis = 0 if direction in ['left', 'right'] else 1
            self.assertLess(start[axis] * settle[axis], 0)

    def test_render_moves_label_without_moving_video(self):
        import numpy as np
        rgb = np.full((640, 360, 3), 60, dtype=np.uint8)
        plate = np.full((14, 80, 4), 255, dtype=np.uint8)
        for direction in ['left', 'right', 'top', 'bottom']:
            s = self.settings(direction)
            initial = facecam.render_frame(rgb, None, s, [plate, plate], 0, 3)
            np.testing.assert_array_equal(initial, rgb)
            final = facecam.render_frame(rgb, None, s, [plate, plate], .65, 3)
            self.assertTrue(np.any(final[64:100, 36:130] != rgb[64:100, 36:130]))
            np.testing.assert_array_equal(final[200:], rgb[200:])

    def test_exit_follows_each_direction_and_zoom(self):
        for style in ['cinema-label','text-behind','backdrop-word','spotlight','name-tag','glass-card','freeze-sticker']:
            for direction,axis,sign in [('left',0,-1),('right',0,1),('top',1,-1),('bottom',1,1)]:
                s = dict(self.settings(direction), style=style, exit='follow', exitDuration=.45)
                resting = facecam.text_transform(s, 2, 3)
                self.assertEqual(resting, (0.,0.,1.,1.))
                end = facecam.text_transform(s, 3, 3)
                self.assertAlmostEqual(end[axis], sign)
                self.assertEqual(end[3], 0)
            s = dict(self.settings(), style=style, entry='pop', exit='follow')
            self.assertAlmostEqual(facecam.text_transform(s, 3, 3)[2], .1)
            s.update(exit='slide', exitDirection='right')
            self.assertAlmostEqual(facecam.text_transform(s, 3, 3)[0], 1)

    def test_exited_labels_leave_video_unchanged(self):
        import numpy as np
        rgb = np.full((640,360,3),60,dtype=np.uint8)
        plate = np.full((14,80,4),255,dtype=np.uint8)
        for style in ['cinema-label','name-tag','glass-card']:
            s = dict(self.settings(), style=style, exit='slide', exitDirection='right', exitDuration=.45)
            np.testing.assert_array_equal(facecam.render_frame(rgb,None,s,[plate],3,3),rgb)


if __name__ == '__main__':
    unittest.main()
