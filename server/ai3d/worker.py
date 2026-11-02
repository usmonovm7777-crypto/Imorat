#!/usr/bin/env python3
"""Quriliş Go — AI 3D worker.

Makes a real 3D model (binary glTF, .glb) of a product from ONE seller photo with TripoSR
(open source, MIT: https://github.com/VAST-AI-Research/TripoSR) and hands it to the Quriliş Go API.

The worker PULLS jobs over HTTPS with a secret token, so it runs anywhere — the owner's MacBook (Apple Silicon:
MPS or CPU), a GPU box or a separate server — with no open ports and no change to the site. One job at a time.

    python worker.py --server https://api.example.uz --token "$MODEL3D_WORKER_TOKEN"

Steps for every job: download the seller's photo → remove the background (rembg) → centre the object → TripoSR
inference → marching cubes (vertex colours from the model) → drop loose crumbs → optional decimation (colours asked
from the model again) → glTF orientation (Y up), standing on the floor → GLB → upload. Nothing is written to disk except a temporary folder that is always deleted.
"""
import argparse, gc, http.client, io, json, logging, os, platform, signal, socket, sys, tempfile, time, traceback, urllib.error, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import meshkit  # noqa: E402

log = logging.getLogger("ai3d")


class NoObject(Exception):
    """The photo has no object we can separate from the background (nothing to model). Final: not retried."""


class Transient(Exception):
    """The server or the network failed for a moment (5xx, 429, a dropped connection): the job goes back to the queue."""


RETRYABLE = (Transient, TimeoutError, ConnectionError, http.client.HTTPException, urllib.error.URLError)


# ---------------------------------------------------------------------------------------------------------------------
# API client (standard library only, so the queue part runs and is tested without any AI packages)
class Api:
    def __init__(self, server, token, name=None, timeout=60):
        self.base = server.rstrip("/")
        self.token = token
        self.name = (name or socket.gethostname())[:60]
        self.timeout = timeout

    def _req(self, method, path, body=None, ctype=None, timeout=None):
        url = path if path.startswith("http") else self.base + path
        data = None
        headers = {"Authorization": "Bearer " + self.token, "X-Worker": self.name, "User-Agent": "QurilishGo-ai3d/1.0"}
        if body is not None:
            if isinstance(body, (bytes, bytearray)):
                data = bytes(body); headers["Content-Type"] = ctype or "application/octet-stream"
            else:
                data = json.dumps(body).encode(); headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def _json(self, status, raw, what):
        try:
            j = json.loads(raw.decode() or "{}")
        except ValueError:
            j = {}
        if status == 401:
            raise SystemExit(f"{what}: the server refused the worker token (check MODEL3D_WORKER_TOKEN on both sides)")
        if status >= 500 or status == 429:
            raise Transient(f"{what}: HTTP {status}")
        if status >= 400:
            raise RuntimeError(f"{what}: HTTP {status} {j.get('error') or raw[:200]!r}")
        return j

    def next(self):
        return self._json(*self._req("POST", "/api/worker/model3d/next", {}), "next").get("job")

    def photo(self, url):
        st, raw = self._req("GET", url, timeout=120)
        if st >= 500 or st == 429:
            raise Transient(f"photo: HTTP {st}")
        if st != 200:
            raise RuntimeError(f"photo: HTTP {st}")
        return raw

    def result(self, job_id, glb):
        return self._json(*self._req("POST", f"/api/worker/model3d/{job_id}/result", glb, "model/gltf-binary", timeout=300), "result")

    def fail(self, job_id, error, retry=True):
        return self._json(*self._req("POST", f"/api/worker/model3d/{job_id}/fail", {"error": str(error)[:300], "retry": bool(retry)}), "fail")

    def ping(self):
        return self._json(*self._req("GET", "/api/worker/model3d/ping"), "ping")


# ---------------------------------------------------------------------------------------------------------------------
# TripoSR engine
def _install_mcubes_shim():
    """TripoSR imports `torchmcubes` (a C++/CUDA extension that has to be compiled). If it is missing — typical on macOS —
    give it the same function built on PyMCubes or scikit-image (both have Apple Silicon wheels)."""
    try:
        import torchmcubes  # noqa: F401
        return "torchmcubes"
    except Exception:
        pass
    import types, torch
    import meshkit

    def marching_cubes(level, threshold):
        v, f = meshkit.marching_cubes(level.detach().float().cpu().numpy(), float(threshold))
        return torch.from_numpy(v), torch.from_numpy(f)
    mod = types.ModuleType("torchmcubes"); mod.marching_cubes = marching_cubes
    sys.modules["torchmcubes"] = mod
    try:
        import mcubes  # noqa: F401
        return "PyMCubes"
    except ImportError:
        return "scikit-image"


def pick_device(want="auto"):
    import torch
    if want != "auto":
        return want
    if torch.cuda.is_available():
        return "cuda:0"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"  # Apple Silicon (M1–M4); unsupported ops fall back to CPU (PYTORCH_ENABLE_MPS_FALLBACK=1)
    return "cpu"


class TripoSREngine:
    def __init__(self, triposr_path, device="auto", mc_resolution=256, foreground_ratio=0.85, chunk_size=8192, max_faces=80000, model="stabilityai/TripoSR"):
        os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        if not os.path.isdir(os.path.join(triposr_path, "tsr")):
            raise SystemExit(f"TripoSR is not found in {triposr_path} (git clone https://github.com/VAST-AI-Research/TripoSR.git there, or pass --triposr)")
        sys.path.insert(0, os.path.abspath(triposr_path))
        import numpy as np, torch, rembg  # noqa: E401
        self.np, self.torch = np, torch
        self.mc_impl = _install_mcubes_shim()
        from tsr.system import TSR
        from tsr.utils import remove_background, resize_foreground
        import tsr.models.isosurface as iso
        self._remove_bg, self._resize = remove_background, resize_foreground
        # marching cubes always on the CPU: torchmcubes/PyMCubes cannot read MPS tensors; the rest stays on the GPU
        _orig_forward = iso.MarchingCubeHelper.forward

        def forward_cpu(helper, level):
            dev = level.device
            v, f = _orig_forward(helper, level.detach().cpu())
            if v.shape[0] == 0 or f.shape[0] == 0:  # the density never reaches the surface: nothing was reconstructed
                raise NoObject("no_object: TripoSR found no surface in this photo")
            return v.to(dev), f.to(dev)
        iso.MarchingCubeHelper.forward = forward_cpu
        self.device = self.home_device = pick_device(device)
        self.mc_resolution, self.foreground_ratio, self.max_faces = mc_resolution, foreground_ratio, max_faces
        t0 = time.time()
        log.info("loading TripoSR (%s) on %s, marching cubes: %s …", model, self.device, self.mc_impl)
        self.model = TSR.from_pretrained(model, config_name="config.yaml", weight_name="model.ckpt")  # first run downloads ~1.7 GB from Hugging Face
        self.model.renderer.set_chunk_size(chunk_size)
        self.model.to(self.device)
        self.rembg = rembg.new_session()
        log.info("model ready in %.0f s", time.time() - t0)

    def _prepare(self, photo_bytes):
        from PIL import Image
        np = self.np
        from PIL import ImageOps
        img = Image.open(io.BytesIO(photo_bytes))
        img.load()
        img = ImageOps.exif_transpose(img)  # phone photos: honour the rotation flag
        img.thumbnail((1024, 1024))  # TripoSR looks at 512 px anyway; smaller is faster for the background removal
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA")
        if img.mode == "RGBA" and (np.array(img)[..., 3] < 128).mean() > 0.05:
            pass  # already cut out (a PNG with a transparent background)
        else:
            img = self._remove_bg(img.convert("RGB"), self.rembg, force=True)  # TripoSR would skip rembg for any PNG with a soft edge
        img = img.convert("RGBA")
        a = np.array(img)[..., 3]
        if (a > 10).mean() < 0.01:
            raise NoObject("no_object: the background removal found no product in the photo")
        img = self._resize(img, self.foreground_ratio)
        arr = np.array(img).astype(np.float32) / 255.0
        arr = arr[:, :, :3] * arr[:, :, 3:4] + (1 - arr[:, :, 3:4]) * 0.5  # TripoSR expects the object on 50 % grey
        return Image.fromarray((arr * 255.0).astype(np.uint8))

    def _run(self, image):
        torch = self.torch
        with torch.no_grad():
            codes = self.model([image], device=self.device)
        mesh = self.model.extract_mesh(codes, True, resolution=self.mc_resolution)[0]
        return codes, mesh

    def _free(self):
        gc.collect()
        torch = self.torch
        if self.home_device.startswith("cuda"):
            torch.cuda.empty_cache()
        elif self.home_device == "mps" and hasattr(torch, "mps"):
            torch.mps.empty_cache()

    @staticmethod
    def _gpu_problem(e):
        m = str(e).lower()
        return any(k in m for k in ("out of memory", "mps", "metal", "cuda", "cublas", "cudnn", "not implemented for", "not currently implemented"))

    def make(self, photo_bytes):
        image = self._prepare(photo_bytes)
        t0 = time.time()
        if self.home_device == "cpu":
            return self._make(image, t0)
        fallback = None
        try:
            return self._make(image, t0)
        except RuntimeError as e:
            if not self._gpu_problem(e):
                raise
            fallback = f"{type(e).__name__}: {str(e)[:160]}"  # leave the except block first: its traceback keeps GPU tensors alive
        log.warning("job on %s failed (%s) — this job runs on the CPU", self.home_device, fallback)
        self._free()
        self.device = "cpu"; self.model.to("cpu")
        try:
            return self._make(image, t0)
        finally:  # only this job: the next one is tried on the GPU again
            self.device = self.home_device; self.model.to(self.home_device); self._free()

    def _make(self, image, t0):
        codes, mesh = self._run(image)
        np = self.np
        v = np.asarray(mesh.vertices, np.float32); f = np.asarray(mesh.faces, np.int64)
        col = np.asarray(mesh.visual.vertex_colors)[:, :3] if len(v) else None
        v, f, col = meshkit.clean(v, f, col)
        if len(f) < 50:
            raise NoObject("no_object: the model produced an empty mesh")
        faces0 = len(f)
        s = meshkit.simplify(v, f, self.max_faces)
        if s is None:
            log.info("fast-simplification is not installed — keeping %d faces", len(f))
        elif len(s[1]) != len(f):
            v, f = s
            col = self._colors(codes, v)  # new vertices: ask the model for their colours again
        glb = meshkit.build_glb(v, f, col, extras={"source": "one photo", "model": "TripoSR", "approximate": True,
                                                   "note": "reconstructed from a single photo; hidden sides are guessed; not for real dimensions"})
        log.info("mesh %d → %d faces, GLB %.1f MB, %.0f s on %s", faces0, len(f), len(glb) / 1e6, time.time() - t0, self.device)
        return glb

    def _colors(self, codes, v):
        np, torch = self.np, self.torch
        with torch.no_grad():
            pos = torch.from_numpy(np.ascontiguousarray(v, dtype=np.float32)).to(codes.device)
            col = self.model.renderer.query_triplane(self.model.decoder, pos, codes[0])["color"].float().cpu().numpy()
        return np.clip(col, 0, 1)


# ---------------------------------------------------------------------------------------------------------------------
_stop = False


def run(api, engine, poll=5.0, once=False, keep_dir=None):
    """The queue loop: take a job, make the model, upload it; errors are reported (recoverable ones go back to the queue)."""
    global _stop
    backoff = poll
    while not _stop:
        try:
            job = api.next()
            backoff = poll
        except SystemExit:
            raise
        except Exception as e:  # the server is unreachable: wait and try again
            log.warning("queue unreachable: %s", e)
            if once:
                return 1
            time.sleep(min(backoff, 60)); backoff *= 2
            continue
        if not job:
            if once:
                return 0
            time.sleep(poll)
            continue
        jid = job["id"]
        log.info("job %s: product %s %r", jid, job.get("product_id"), job.get("name", ""))
        t0 = time.time()
        with tempfile.TemporaryDirectory(prefix="ai3d-") as td:  # libraries' temporary files for this job land here; always removed
            tempfile.tempdir = td
            try:
                photo = api.photo(job["photo_url"])
                glb = engine.make(photo)
                if keep_dir:
                    try:
                        os.makedirs(keep_dir, exist_ok=True); open(os.path.join(keep_dir, f"job{jid}.glb"), "wb").write(glb)
                    except OSError as e:
                        log.warning("could not keep a copy in %s: %s", keep_dir, e)
                res = api.result(jid, glb)
                log.info("job %s done in %.0f s%s", jid, time.time() - t0, " (photo changed meanwhile, discarded)" if res.get("discarded") else "")
            except NoObject as e:
                log.warning("job %s: %s", jid, e); _safe_fail(api, jid, e, retry=False)
            except MemoryError as e:
                log.error("job %s: out of memory", jid); _safe_fail(api, jid, "out of memory", retry=True)
            except Exception as e:
                msg = f"{type(e).__name__}: {e}"
                log.error("job %s failed: %s\n%s", jid, msg, traceback.format_exc(limit=-6))
                _safe_fail(api, jid, msg, retry="out of memory" in msg.lower() or isinstance(e, RETRYABLE))
            finally:
                tempfile.tempdir = None
        if once:
            return 0
    return 0


def _safe_fail(api, jid, err, retry):
    try:
        api.fail(jid, err, retry)
    except Exception as e:
        log.warning("could not report the failure of job %s: %s (the server will return it to the queue by itself)", jid, e)


def main(argv=None):
    p = argparse.ArgumentParser(description="Quriliş Go AI 3D worker (TripoSR)")
    p.add_argument("--server", default=os.environ.get("AI3D_SERVER", "http://localhost:8787"), help="Quriliş Go API address")
    p.add_argument("--token", default=os.environ.get("MODEL3D_WORKER_TOKEN", ""), help="the same MODEL3D_WORKER_TOKEN as on the server")
    p.add_argument("--triposr", default=os.environ.get("TRIPOSR_PATH", os.path.join(os.path.dirname(os.path.abspath(__file__)), "TripoSR")))
    p.add_argument("--device", default=os.environ.get("AI3D_DEVICE", "auto"), help="auto | mps | cpu | cuda:0")
    p.add_argument("--mc-resolution", type=int, default=int(os.environ.get("AI3D_MC_RESOLUTION", 256)), help="marching cubes grid (192 is faster, 256 sharper)")
    p.add_argument("--foreground-ratio", type=float, default=0.85)
    p.add_argument("--chunk-size", type=int, default=int(os.environ.get("AI3D_CHUNK", 8192)), help="lower it if memory runs out")
    p.add_argument("--max-faces", type=int, default=int(os.environ.get("AI3D_MAX_FACES", 80000)), help="simplify bigger meshes (needs fast-simplification); 0 = keep")
    p.add_argument("--poll", type=float, default=5.0)
    p.add_argument("--once", action="store_true", help="process at most one job and exit")
    p.add_argument("--keep", default=None, help="also save each GLB into this folder (for checking)")
    p.add_argument("--check", action="store_true", help="only check the connection to the server and exit")
    a = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not a.token:
        raise SystemExit("no token: pass --token or set MODEL3D_WORKER_TOKEN")
    api = Api(a.server, a.token)
    log.info("server %s: %s pending job(s)", a.server, api.ping().get("pending"))
    if a.check:
        return 0
    engine = TripoSREngine(a.triposr, a.device, a.mc_resolution, a.foreground_ratio, a.chunk_size, a.max_faces)

    def stop(*_):
        global _stop
        _stop = True
        log.info("stopping after the current job …")
    signal.signal(signal.SIGINT, stop); signal.signal(signal.SIGTERM, stop)
    log.info("waiting for jobs (%s, %s)", platform.machine(), engine.device)
    return run(api, engine, a.poll, a.once, a.keep)


if __name__ == "__main__":
    sys.exit(main())
