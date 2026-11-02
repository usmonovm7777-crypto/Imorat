"""Runs the REAL worker loop (worker.Api + worker.run: queue, photo download, temp folder, upload, error reports) against
a running Quriliş Go API, with a TEST-ONLY engine in place of TripoSR, so the queue part is checked where torch and the
model weights are not available (CI, this repo's server tests). It is never used by worker.py itself.

    python3 worker_live.py http://127.0.0.1:8787 <MODEL3D_WORKER_TOKEN> [ok|noobject|crash|transient|cutout|cutout-hand]

The 3D test engine makes a plain coloured block the size of the photo's proportions — NOT a reconstruction of the product.
"cutout" runs the REAL photo-studio code (cutout.Cutout: compose, centring, lossless file) with a test mask instead of the
rembg model: pixels that differ from the photo's corner colour."""
import io, os, sys
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import cutout, meshkit, worker  # noqa: E402


def corner_mask(img):
    """TEST-ONLY segmentation: everything that differs from the top-left corner colour is the product."""
    a = np.asarray(img.convert("RGB")).astype(int)
    return Image.fromarray(((np.abs(a - a[0, 0]).sum(-1) > 30) * 255).astype(np.uint8))


class BlockTestEngine:
    device = "test"

    def __init__(self, mode):
        self.mode = mode

    def make(self, photo):
        img = Image.open(io.BytesIO(photo)).convert("RGB")
        if self.mode == "noobject":
            raise worker.NoObject("no_object: test engine")
        if self.mode == "crash":
            raise RuntimeError("test engine crashed")
        if self.mode == "transient":
            raise worker.Transient("test: server answered 502")
        w, h = img.size
        r = 48; x = np.linspace(0, 1, r); X, Y, Z = np.meshgrid(x, x, x, indexing="ij")
        hz = 0.38; hx = hz * min(1.0, w / h); hy = 0.12
        level = np.minimum(np.minimum(hx - abs(X - .5), hy - abs(Y - .5)), hz - abs(Z - .5)).astype(np.float32)
        v, f = meshkit.marching_cubes(level, 0.0); v = v[:, [2, 1, 0]] / (r - 1.0)
        px = np.asarray(img.resize((32, 32)), np.float64) / 255.0  # the photo projected on the front, as vertex colours
        u = np.clip(((v[:, 0] - .5) / (2 * hx) + .5) * 31, 0, 31).astype(int); t = np.clip((.5 - (v[:, 2] - .5) / (2 * hz)) * 31, 0, 31).astype(int)
        return meshkit.build_glb(v, f, px[t, u], extras={"test_engine": True})


if __name__ == "__main__":
    base, token = sys.argv[1], sys.argv[2]
    mode = sys.argv[3] if len(sys.argv) > 3 else "ok"
    api = worker.Api(base, token, name="test-worker")
    import logging; logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if mode.startswith("cutout"):
        hands = (lambda rgb: [(rgb.shape[1] * 0.4, rgb.shape[0] * 0.4, rgb.shape[1] * 0.6, rgb.shape[0] * 0.6)]) if mode == "cutout-hand" else None
        sys.exit(worker.run(api, {"cutout": cutout.Cutout(corner_mask, hands)}, poll=0.2, once=True))
    sys.exit(worker.run(api, BlockTestEngine(mode), poll=0.2, once=True))
