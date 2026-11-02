"""Quriliş Go AI photo studio: a white (#FFFFFF) background around the product. The product itself stays 100 % original.

The AI is used ONLY to build a mask of the product (segmentation: rembg with the IS-Net / U²-Net models). Everything else is
plain array work with numpy and Pillow:

    • every product pixel inside the outline is the photo's own RGB value, bit for bit (no colour, shape, texture or label change);
    • the background becomes exactly 255, 255, 255;
    • only a thin band on the outline (BAND px on each side) mixes the photo's pixel with white by the mask's softness, so the
      edge is clean — such a pixel always lies between the original value and white, channel by channel;
    • loose objects that do not touch the product are dropped with the background; anything touching it stays (nothing is
      painted over or reconstructed);
    • the product is centred on a square white canvas; the picture is scaled (proportionally) only if it is bigger than MAX_SIDE;
    • the result is saved lossless (WebP lossless or PNG), so no compression changes the pixels either.

A hand on or next to the product is reported (warning "hand"); hidden parts are never filled in.
Nothing here can generate or redraw image content.
"""
import io

import numpy as np
from PIL import Image, ImageOps, features

BAND = 2          # px on each side of the outline where the mask's soft edge is used
KEEP_RATIO = 0.15  # separate parts smaller than this share of the biggest part are loose objects, not the product
MARGIN = 0.08     # white margin around the product, share of its longer side
MAX_SIDE = 2048


class NoProduct(Exception):
    """The mask found no product in the photo."""


def compose(rgb, alpha, band=BAND, keep_ratio=KEEP_RATIO, margin=MARGIN, max_side=MAX_SIDE):
    """rgb: uint8 H×W×3, the original photo. alpha: uint8 H×W, the segmentation mask (255 = product).
    Returns (uint8 S×S×3 picture on white, info). Raises NoProduct if there is nothing to keep."""
    from scipy import ndimage
    rgb = np.asarray(rgb, np.uint8)
    a = np.asarray(alpha, np.float32) / 255.0
    if a.shape != rgb.shape[:2]:
        raise ValueError("mask and photo sizes differ")
    obj = a >= 0.5
    lab, n = ndimage.label(obj)
    if n == 0:
        raise NoProduct("no_object: no product found in the photo")
    sizes = ndimage.sum(obj, lab, index=np.arange(1, n + 1))
    kept_ids = 1 + np.flatnonzero(sizes >= keep_ratio * sizes.max())
    keep = np.isin(lab, kept_ids)
    if keep.mean() < 0.003:
        raise NoProduct("no_object: the product is too small in the photo")
    inner = ndimage.binary_erosion(keep, iterations=band, border_value=1) if band else keep
    outer = ndimage.binary_dilation(keep, iterations=band) if band else keep
    edge_band = outer & ~inner

    out = np.full_like(rgb, 255)
    out[inner] = rgb[inner]  # the product: the photo's own pixels, unchanged
    if edge_band.any():
        k = a[edge_band][:, None]
        out[edge_band] = np.clip(np.round(rgb[edge_band].astype(np.float32) * k + 255.0 * (1.0 - k)), 0, 255).astype(np.uint8)

    ys, xs = np.nonzero(outer)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    h, w = y1 - y0, x1 - x0
    pad = max(16, int(round(margin * max(h, w))))
    side = max(h, w) + 2 * pad
    canvas = np.full((side, side, 3), 255, np.uint8)
    oy, ox = (side - h) // 2, (side - w) // 2
    canvas[oy:oy + h, ox:ox + w] = out[y0:y1, x0:x1]
    scaled = side > max_side
    if scaled:  # proportional, the only resampling ever done (photos from the site are ≤ 1280 px, so normally never)
        canvas = np.asarray(Image.fromarray(canvas).resize((max_side, max_side), Image.LANCZOS))
    H, W = keep.shape
    info = {
        "coverage": round(float(keep.mean()), 4),
        "edge": bool(keep[0].any() or keep[-1].any() or keep[:, 0].any() or keep[:, -1].any()),
        "parts_removed": int(n - len(kept_ids)),
        "band_px": int(edge_band.sum()),
        "offset": (int(oy - y0), int(ox - x0)),  # where an original pixel (y, x) lands: (y + dy, x + dx), when not scaled
        "scaled": bool(scaled),
        "size": int(canvas.shape[0]),
        "source": (int(H), int(W)),
    }
    info["_outer"] = outer
    return canvas, info


def hand_touches(boxes, outer, grow=0.04):
    """True if any hand box (x0, y0, x1, y1 in pixels) overlaps the product or its edge band (grown a little)."""
    H, W = outer.shape
    g = int(round(grow * max(H, W)))
    for x0, y0, x1, y1 in boxes or []:
        xa, ya = max(0, int(x0) - g), max(0, int(y0) - g)
        xb, yb = min(W, int(x1) + g + 1), min(H, int(y1) + g + 1)
        if xb > xa and yb > ya and outer[ya:yb, xa:xb].any():
            return True
    return False


def encode_lossless(arr):
    """(bytes, content type): lossless WebP when Pillow has it, otherwise PNG. Both keep every pixel exactly."""
    im = Image.fromarray(np.asarray(arr, np.uint8), "RGB")
    buf = io.BytesIO()
    if features.check("webp"):
        im.save(buf, "WEBP", lossless=True, quality=90, method=4, exact=True)
        return buf.getvalue(), "image/webp"
    im.save(buf, "PNG", compress_level=6)
    return buf.getvalue(), "image/png"


def load_photo(photo_bytes):
    """The seller's photo as RGB (EXIF rotation applied) plus its own alpha if it already has a transparent background."""
    img = Image.open(io.BytesIO(photo_bytes))
    img.load()
    img = ImageOps.exif_transpose(img)
    own_alpha = None
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        al = np.asarray(rgba)[..., 3]
        if (al < 128).mean() > 0.05:  # a real cut-out already: its own alpha is the mask
            own_alpha = al.copy()
        white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        img = Image.alpha_composite(white, rgba)
    return np.asarray(img.convert("RGB")).copy(), own_alpha


class Cutout:
    """mask_fn(PIL RGB image) → mask (PIL L or uint8 H×W), the only AI step. hands_fn(rgb uint8) → [(x0, y0, x1, y1)] or None."""

    def __init__(self, mask_fn, hands_fn=None):
        self.mask_fn, self.hands_fn = mask_fn, hands_fn

    def make(self, photo_bytes):
        rgb, own_alpha = load_photo(photo_bytes)
        m = own_alpha if own_alpha is not None else self.mask_fn(Image.fromarray(rgb))  # the only AI step: a mask
        mask = np.asarray(m.convert("L") if hasattr(m, "convert") else m, np.uint8)
        if mask.shape != rgb.shape[:2]:
            mask = np.asarray(Image.fromarray(mask).resize((rgb.shape[1], rgb.shape[0]), Image.BILINEAR))
        out, info = compose(rgb, mask)
        outer = info.pop("_outer")
        warns = []
        if info["edge"]:
            warns.append("edge")
        info["hand_check"] = self.hands_fn is not None
        if self.hands_fn is not None and hand_touches(self.hands_fn(rgb), outer):
            warns.append("hand")
        data, ctype = encode_lossless(out)
        return data, ctype, warns, info


def rembg_mask(model="isnet-general-use"):
    """The production mask: rembg (MIT) with an open segmentation model (IS-Net / U²-Net, Apache-2.0), mask only."""
    import rembg
    session = rembg.new_session(model)

    def fn(img):
        return rembg.remove(img, session=session, only_mask=True)
    return fn


def mediapipe_hands():
    """Hand boxes from MediaPipe Hands (Apache-2.0), or None if mediapipe is not installed."""
    try:
        import mediapipe as mp
        H = mp.solutions.hands
    except Exception:
        return None
    det = H.Hands(static_image_mode=True, max_num_hands=4, min_detection_confidence=0.5)

    def fn(rgb):
        res = det.process(np.ascontiguousarray(rgb))
        h, w = rgb.shape[:2]
        boxes = []
        for lm in res.multi_hand_landmarks or []:
            xs = [p.x for p in lm.landmark]; ys = [p.y for p in lm.landmark]
            boxes.append((min(xs) * w, min(ys) * h, max(xs) * w, max(ys) * h))
        return boxes
    return fn
