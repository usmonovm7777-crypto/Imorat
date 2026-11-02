"""Used by api.test.mjs: the white-background file the server stores must be exactly what the photo-studio code makes from the
original photo (same pixels, lossless), and the product's pixels in it must equal the original photo's."""
import io, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import cutout  # noqa: E402
from worker_live import corner_mask  # noqa: E402

orig = np.asarray(Image.open(sys.argv[1]).convert("RGB"))
got = np.asarray(Image.open(sys.argv[2]).convert("RGB"))
mask = np.asarray(corner_mask(Image.fromarray(orig)))
want, info = cutout.compose(orig, mask)
outer = info.pop("_outer")
assert got.shape == want.shape, (got.shape, want.shape)
assert (got == want).all(), "the stored file differs from the studio's output"
dy, dx = info["offset"]
inner = ndimage.binary_erosion(mask >= 128, iterations=cutout.BAND, border_value=1)
ys, xs = np.nonzero(inner)
assert (got[ys + dy, xs + dx] == orig[ys, xs]).all(), "product pixels changed"
print("ok", len(ys), "product pixels identical")
