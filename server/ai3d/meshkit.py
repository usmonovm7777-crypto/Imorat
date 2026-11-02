"""Mesh helpers for the Quriliş Go AI 3D worker — numpy only (+ scikit-image or PyMCubes for marching cubes, scipy and
fast-simplification optional). Kept apart from the AI part so it is tested without torch.

    marching_cubes(vol, thr)      the torchmcubes contract on the CPU (used when torchmcubes cannot be built, e.g. macOS)
    clean(v, f, c)                drop broken faces, floating crumbs and unused vertices
    simplify(v, f, max_faces)     fewer faces for a smaller file (None when fast-simplification is not installed)
    build_glb(v, f, c, extras)    outward faces → glTF orientation (Y up) → standing on y = 0 → normals → linear colours → GLB
"""
import json, struct
import numpy as np


def marching_cubes(vol, thr):
    """Same result as torchmcubes.marching_cubes(vol, thr) on the CPU: vertices with x along the LAST axis, int faces."""
    vol = np.ascontiguousarray(vol, dtype=np.float32)
    if not (vol.min() < thr < vol.max()):
        return np.zeros((0, 3), np.float32), np.zeros((0, 3), np.int64)  # nothing crosses the surface: empty mesh
    try:
        import mcubes
        v, f = mcubes.marching_cubes(vol, float(thr))
    except ImportError:
        from skimage import measure
        v, f, _n, _vals = measure.marching_cubes(vol, float(thr))
    return np.ascontiguousarray(np.asarray(v)[:, [2, 1, 0]], dtype=np.float32), np.ascontiguousarray(f, dtype=np.int64)


def clean(v, f, c=None, keep_ratio=0.02):
    """Remove degenerate faces, small loose parts (< keep_ratio of the biggest part, the usual crumbs around a
    reconstruction) and vertices no face uses. Returns (v, f, c)."""
    v = np.asarray(v, np.float32); f = np.asarray(f, np.int64)
    if len(f):
        f = f[(f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])]
    if len(f) and keep_ratio:
        try:
            from scipy.sparse import coo_matrix
            from scipy.sparse.csgraph import connected_components
            e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
            g = coo_matrix((np.ones(len(e), np.int8), (e[:, 0], e[:, 1])), shape=(len(v), len(v)))
            _n, lab = connected_components(g, directed=False)
            flab = lab[f[:, 0]]
            sizes = np.bincount(flab)
            f = f[sizes[flab] >= max(1, keep_ratio * sizes.max())]
        except ImportError:
            pass
    used = np.zeros(len(v), bool); used[f.ravel()] = True
    remap = np.cumsum(used) - 1
    v2 = v[used]; f2 = remap[f]
    c2 = None if c is None else np.asarray(c)[used]
    return v2, f2.astype(np.int64), c2


def simplify(v, f, max_faces):
    """Quadric decimation to about max_faces faces, or None if fast-simplification is not installed."""
    if not max_faces or len(f) <= max_faces:
        return v, f
    try:
        import fast_simplification
    except ImportError:
        return None
    v2, f2 = fast_simplification.simplify(np.asarray(v, np.float32), np.asarray(f, np.int32), target_reduction=1 - max_faces / len(f))
    return np.asarray(v2, np.float32), np.asarray(f2, np.int64)


def signed_volume(v, f):
    a, b, c = v[f[:, 0]].astype(np.float64), v[f[:, 1]].astype(np.float64), v[f[:, 2]].astype(np.float64)
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)


def orient_gltf(v):
    """TripoSR's frame (Z up) → glTF (Y up): −90° about X, then +90° about Y — the turn TripoSR's own app applies
    (tsr.utils.to_gradio_3d_orientation). (x, y, z) → (−y, z, −x)."""
    v = np.asarray(v, np.float32)
    return np.stack([-v[:, 1], v[:, 2], -v[:, 0]], axis=1)


def vertex_normals(v, f):
    fn = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])  # length = 2 × area → area-weighted
    n = np.zeros_like(v, dtype=np.float64)
    for k in range(3):
        np.add.at(n, f[:, k], fn)
    ln = np.linalg.norm(n, axis=1, keepdims=True); ln[ln == 0] = 1
    return (n / ln).astype(np.float32)


def srgb_to_linear(c):
    c = np.clip(np.asarray(c, np.float64), 0, 1)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def build_glb(v, f, colors=None, extras=None, srgb=True):
    """A vertex-coloured mesh in TripoSR's frame → bytes of a binary glTF 2.0 file (core spec only, no extensions)."""
    v = np.asarray(v, np.float32); f = np.asarray(f, np.int64)
    if not len(f):
        raise ValueError("empty mesh")
    if signed_volume(v, f) < 0:  # faces must point outwards (marching cubes implementations differ in winding)
        f = f[:, [0, 2, 1]]
    v = orient_gltf(v)
    lo, hi = v.min(0), v.max(0)
    v = v - np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2], np.float32)  # centred, standing on the floor
    n = vertex_normals(v, f)
    views, accessors, blobs, off = [], [], [], 0

    def add(arr, comp, typ, count, target, normalized=False, minmax=False):
        nonlocal off
        b = arr.tobytes(); pad = (-len(b)) % 4
        views.append({"buffer": 0, "byteOffset": off, "byteLength": len(b), **({"target": target} if target else {})})
        acc = {"bufferView": len(views) - 1, "componentType": comp, "count": count, "type": typ}
        if normalized: acc["normalized"] = True
        if minmax: acc["min"] = [float(x) for x in arr.min(0)]; acc["max"] = [float(x) for x in arr.max(0)]
        accessors.append(acc); blobs.append(b + b"\0" * pad); off += len(b) + pad
        return len(accessors) - 1

    attrs = {"POSITION": add(v, 5126, "VEC3", len(v), 34962, minmax=True), "NORMAL": add(n, 5126, "VEC3", len(v), 34962)}
    if colors is not None:
        c = np.asarray(colors)[:, :3]
        c = c / 255.0 if np.issubdtype(c.dtype, np.integer) else c.astype(np.float64)  # trimesh keeps uint8, the model gives 0..1
        lin = srgb_to_linear(c) if srgb else np.clip(c, 0, 1)  # glTF vertex colours are linear
        rgba = np.concatenate([lin, np.ones((len(lin), 1))], 1)
        attrs["COLOR_0"] = add(np.round(rgba * 65535).astype(np.uint16), 5123, "VEC4", len(v), 34962, normalized=True)
    small = len(v) < 65535
    idx = add(f.astype(np.uint16 if small else np.uint32).ravel(), 5123 if small else 5125, "SCALAR", f.size, 34963)
    gltf = {
        "asset": {"version": "2.0", "generator": "Qurilis Go ai3d (TripoSR)", "extras": extras or {}},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": "product"}],
        "meshes": [{"primitives": [{"attributes": attrs, "indices": idx, "material": 0, "mode": 4}]}],
        "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.0, "roughnessFactor": 0.85}, "doubleSided": True}],
        "buffers": [{"byteLength": off}], "bufferViews": views, "accessors": accessors,
    }
    js = json.dumps(gltf, separators=(",", ":")).encode(); js += b" " * ((-len(js)) % 4)
    binb = b"".join(blobs)
    total = 12 + 8 + len(js) + 8 + len(binb)
    return struct.pack("<4sII", b"glTF", 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(binb), 0x004E4942) + binb


def read_glb(b):
    """Parse a GLB back (for checks): (json, bin, arrays) where arrays maps POSITION/NORMAL/COLOR_0/indices to numpy."""
    magic, ver, total = struct.unpack_from("<4sII", b, 0)
    assert magic == b"glTF" and ver == 2 and total == len(b), "not a glTF 2 binary"
    jl, jt = struct.unpack_from("<II", b, 12); assert jt == 0x4E4F534A
    g = json.loads(b[20:20 + jl])
    bl, bt = struct.unpack_from("<II", b, 20 + jl); assert bt == 0x004E4942
    binb = b[28 + jl:28 + jl + bl]
    dt = {5126: np.float32, 5123: np.uint16, 5125: np.uint32, 5121: np.uint8}
    width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}

    def acc(i):
        a = g["accessors"][i]; bv = g["bufferViews"][a["bufferView"]]
        arr = np.frombuffer(binb, dt[a["componentType"]], a["count"] * width[a["type"]], bv.get("byteOffset", 0) + a.get("byteOffset", 0))
        return arr.reshape(a["count"], width[a["type"]]) if width[a["type"]] > 1 else arr
    prim = g["meshes"][0]["primitives"][0]
    arrays = {k: acc(i) for k, i in prim["attributes"].items()}
    arrays["indices"] = acc(prim["indices"])
    return g, binb, arrays
