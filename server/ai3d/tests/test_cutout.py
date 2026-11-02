"""The photo studio must not touch the product: every pixel inside the outline is the original value, bit for bit;
the background is pure white; only a thin outline band mixes the original with white. No generative step exists."""
import io, os, sys, unittest
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import cutout  # noqa: E402

rng = np.random.default_rng(7)


def scene(H=300, W=400, touch_edge=False, hand=False):
    """A noisy coloured background, a product with a fine texture, a printed 'label', scratches and a soft-edged mask,
    plus a small loose object that does not touch it. Returns (rgb, mask, product_area)."""
    yy, xx = np.mgrid[0:H, 0:W]
    bg = np.stack([60 + xx * 0.2, 110 + yy * 0.15, 150 + 0 * xx], -1) + rng.normal(0, 6, (H, W, 3))
    rgb = np.clip(bg, 0, 255).astype(np.uint8)
    cy, cx = (H // 2, W - 90) if touch_edge else (H // 2, W // 2)
    d = np.hypot((yy - cy) / 95.0, (xx - cx) / 120.0)  # an elliptic product
    prod = d < 1.0
    tex = np.stack([200 + 30 * np.sin(xx / 3.0), 120 + 25 * np.cos(yy / 2.0), 40 + 20 * np.sin((xx + yy) / 5.0)], -1) + rng.normal(0, 9, (H, W, 3))
    tex[(abs(yy - cy) < 12) & (abs(xx - cx) < 70)] = [20, 20, 230]  # the label
    tex[(abs(yy - cy - 40 - (xx - cx) * 0.1) < 1.0) & prod] = [250, 250, 250]  # a scratch
    rgb[prod] = np.clip(tex, 0, 255).astype(np.uint8)[prod]
    mask = np.clip((1.0 - d) * 255 / 0.03, 0, 255)  # soft ~3 px edge like a segmentation model gives
    loose = np.hypot(yy - 30, xx - 30) < 8  # a separate small object (a coin on the table)
    rgb[loose] = [10, 200, 10]
    mask = np.maximum(mask, loose * 255.0)
    if hand:
        rgb[(abs(yy - cy) < 20) & (xx > cx + 100) & (xx < cx + 150)] = [224, 172, 140]
    return rgb, mask.astype(np.uint8), prod


def prod_of(mask):
    """the biggest part of the mask (the product, without the loose coin)"""
    from scipy import ndimage
    lab, n = ndimage.label(mask >= 128)
    sizes = ndimage.sum(mask >= 128, lab, index=np.arange(1, n + 1))
    return lab == 1 + int(np.argmax(sizes))


class Studio(unittest.TestCase):
    def test_product_pixels_are_copied_bit_for_bit(self):
        rgb, mask, prod = scene()
        out, info = cutout.compose(rgb, mask)
        outer = info.pop("_outer")
        dy, dx = info["offset"]
        from scipy import ndimage
        inner = ndimage.binary_erosion((mask >= 128) & prod_of(mask), iterations=cutout.BAND, border_value=1)
        ys, xs = np.nonzero(inner)
        self.assertGreater(len(ys), 20000)
        np.testing.assert_array_equal(out[ys + dy, xs + dx], rgb[ys, xs])  # colour, label, scratch, texture: unchanged
        self.assertFalse(info["scaled"])

    def test_background_is_pure_white_and_the_edge_only_mixes_with_white(self):
        rgb, mask, prod = scene()
        out, info = cutout.compose(rgb, mask)
        outer = info.pop("_outer"); dy, dx = info["offset"]
        from scipy import ndimage
        inner = ndimage.binary_erosion((mask >= 128) & prod_of(mask), iterations=cutout.BAND, border_value=1)
        canvas_src = np.zeros(out.shape[:2], bool)
        ys, xs = np.nonzero(outer); canvas_src[ys + dy, xs + dx] = True
        self.assertTrue((out[~canvas_src] == 255).all(), "everything outside the product and its band is #FFFFFF")
        band = outer & ~inner
        by, bx = np.nonzero(band)
        o, r = out[by + dy, bx + dx].astype(int), rgb[by, bx].astype(int)
        self.assertTrue(((o >= np.minimum(r, 255)) & (o <= 255)).all(), "an edge pixel lies between the original and white")
        self.assertLessEqual(len(by), 2 * (2 * cutout.BAND + 1) * 2 * np.pi * 120, "the mixed band is only a thin outline")

    def test_loose_objects_go_the_product_stays_centred(self):
        rgb, mask, prod = scene()
        out, info = cutout.compose(rgb, mask)
        info.pop("_outer")
        self.assertEqual(info["parts_removed"], 1)
        self.assertFalse(((out[..., 0] == 10) & (out[..., 1] == 200)).any(), "the coin is gone")
        nz = np.argwhere((out != 255).any(-1))
        c = (nz.min(0) + nz.max(0)) / 2
        self.assertLessEqual(abs(c[0] - out.shape[0] / 2), 1.5); self.assertLessEqual(abs(c[1] - out.shape[1] / 2), 1.5)
        self.assertEqual(out.shape[0], out.shape[1])

    def test_lossless_files_keep_every_pixel(self):
        rgb, mask, _ = scene()
        out, info = cutout.compose(rgb, mask)
        data, ctype = cutout.encode_lossless(out)
        back = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"))
        np.testing.assert_array_equal(back, out)
        im = Image.fromarray(out); b = io.BytesIO(); im.save(b, "PNG")
        np.testing.assert_array_equal(np.asarray(Image.open(io.BytesIO(b.getvalue())).convert("RGB")), out)
        if ctype == "image/webp":
            self.assertIn(b"VP8L", data[:64])  # lossless WebP, never the lossy VP8

    def test_hand_touching_the_product_is_reported(self):
        rgb, mask, prod = scene(hand=True)
        H, W = mask.shape
        hand_box = [(W // 2 + 95, H // 2 - 20, W // 2 + 150, H // 2 + 20)]
        st = cutout.Cutout(lambda img: Image.fromarray(mask), hands_fn=lambda a: hand_box)
        b = io.BytesIO(); Image.fromarray(rgb).save(b, "PNG")
        data, ctype, warns, info = st.make(b.getvalue())
        self.assertIn("hand", warns); self.assertTrue(info["hand_check"])
        far = cutout.Cutout(lambda img: Image.fromarray(mask), hands_fn=lambda a: [(2, 2, 12, 12)])
        self.assertNotIn("hand", far.make(b.getvalue())[2])

    def test_product_cut_by_the_frame_is_reported_and_kept(self):
        rgb, mask, prod = scene(touch_edge=True)
        out, info = cutout.compose(rgb, mask)
        info.pop("_outer")
        self.assertTrue(info["edge"])
        dy, dx = info["offset"]
        from scipy import ndimage
        inner = ndimage.binary_erosion((mask >= 128) & prod_of(mask), iterations=cutout.BAND, border_value=1)
        ys, xs = np.nonzero(inner & (np.arange(rgb.shape[1])[None, :] == rgb.shape[1] - 1))
        self.assertGreater(len(ys), 50)
        np.testing.assert_array_equal(out[ys + dy, xs + dx], rgb[ys, xs])  # pixels at the frame edge are not eroded away

    def test_empty_mask_means_no_product(self):
        rgb, mask, _ = scene()
        with self.assertRaises(cutout.NoProduct):
            cutout.compose(rgb, np.zeros_like(mask))

    def test_the_only_ai_step_receives_the_photo_and_returns_a_mask(self):
        rgb, mask, _ = scene()
        calls = []

        def mask_fn(img):
            calls.append(img.size); self.assertEqual(img.mode, "RGB")
            return Image.fromarray(mask)
        st = cutout.Cutout(mask_fn)
        b = io.BytesIO(); Image.fromarray(rgb).save(b, "PNG")
        data, ctype, warns, info = st.make(b.getvalue())
        self.assertEqual(calls, [(rgb.shape[1], rgb.shape[0])])
        self.assertFalse(info["hand_check"])
        back = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"))
        dy, dx = info["offset"]
        from scipy import ndimage
        inner = ndimage.binary_erosion((mask >= 128) & prod_of(mask), iterations=cutout.BAND, border_value=1)
        ys, xs = np.nonzero(inner)
        np.testing.assert_array_equal(back[ys + dy, xs + dx], rgb[ys, xs])

    def test_a_photo_that_is_already_cut_out_uses_its_own_transparency(self):
        rgb, mask, _ = scene()
        rgba = np.dstack([rgb, mask]); b = io.BytesIO(); Image.fromarray(rgba, "RGBA").save(b, "PNG")
        st = cutout.Cutout(lambda img: (_ for _ in ()).throw(AssertionError("no AI needed")))
        data, ctype, warns, info = st.make(b.getvalue())
        self.assertGreater(info["coverage"], 0.2)


if __name__ == "__main__":
    unittest.main()
