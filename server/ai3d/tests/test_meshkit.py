"""Checks of the worker's mesh part (marching cubes stand-in, cleaning, orientation, GLB writer) — numpy + scikit-image.
The AI model itself (TripoSR + torch) is not exercised here.   python3 -m unittest discover -s server/ai3d/tests"""
import os, sys, unittest
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import meshkit  # noqa: E402

R = 96


def grid():
    x = np.linspace(0, 1, R)
    return np.meshgrid(x, x, x, indexing="ij")  # the same grid TripoSR builds (MarchingCubeHelper.grid_vertices)


def box_level(hx, hy, hz, cx=0.5, cy=0.5, cz=0.5):
    """'density − threshold' of a box: positive inside, like the level TripoSR hands to marching cubes."""
    X, Y, Z = grid()
    return np.minimum(np.minimum(hx - abs(X - cx), hy - abs(Y - cy)), hz - abs(Z - cz)).astype(np.float32)


def triposr_mesh(level):
    """What tsr.models.isosurface.MarchingCubeHelper.forward does around torchmcubes: mc → swap axes → / (R − 1)."""
    v, f = meshkit.marching_cubes(level, 0.0)
    return v[:, [2, 1, 0]] / (R - 1.0), f


class MeshKit(unittest.TestCase):
    def test_marching_cubes_follows_the_torchmcubes_axis_order(self):
        v, f = triposr_mesh(box_level(0.40, 0.20, 0.10))  # wide in x, medium in y, thin in z
        ext = v.max(0) - v.min(0)
        self.assertGreater(len(f), 100)
        np.testing.assert_allclose(ext, [0.80, 0.40, 0.20], atol=0.03)

    def test_empty_volume_gives_an_empty_mesh(self):
        v, f = meshkit.marching_cubes(np.full((8, 8, 8), -1, np.float32), 0.0)
        self.assertEqual((len(v), len(f)), (0, 0))

    def test_clean_drops_loose_crumbs_and_keeps_the_object(self):
        lv = np.maximum(box_level(0.3, 0.3, 0.3), box_level(0.02, 0.02, 0.02, 0.92, 0.92, 0.92))
        v, f = triposr_mesh(lv)
        v2, f2, _ = meshkit.clean(v, f, np.zeros((len(v), 3)))
        self.assertLess(len(f2), len(f)); self.assertLess(v2.max(), 0.85)
        self.assertEqual(f2.max(), len(v2) - 1)

    def test_glb_stands_up_faces_outwards_and_keeps_colours(self):
        # a column, tall along TripoSR's z (up), red on the +x half and grey (sRGB 0.5) on the other
        v, f = triposr_mesh(box_level(0.12, 0.12, 0.40))
        col = np.where(v[:, :1] > 0.5, [[1.0, 0.0, 0.0]], [[0.5, 0.5, 0.5]])
        f = f[:, [0, 2, 1]]  # wrong winding on purpose: the writer must turn the faces outwards
        glb = meshkit.build_glb(v, f, col, extras={"approximate": True})
        g, _b, a = meshkit.read_glb(glb)
        self.assertEqual(g["asset"]["version"], "2.0"); self.assertNotIn("extensionsRequired", g)
        self.assertTrue(g["asset"]["extras"]["approximate"])
        P, N, C, I = a["POSITION"], a["NORMAL"], a["COLOR_0"], a["indices"].reshape(-1, 3).astype(np.int64)
        ext = P.max(0) - P.min(0)
        self.assertAlmostEqual(float(P[:, 1].min()), 0.0, places=5)  # stands on the floor
        self.assertGreater(ext[1], 2.5 * ext[0]); self.assertGreater(ext[1], 2.5 * ext[2])  # z-up became y-up
        self.assertLess(abs(float(P[:, 0].min() + P[:, 0].max())), 1e-4)
        self.assertGreater(meshkit.signed_volume(P, I), 0)  # outward faces
        centre = (P.max(0) + P.min(0)) / 2
        self.assertGreater(float((np.einsum("ij,ij->i", N, P - centre) > 0).mean()), 0.95)  # normals point out
        self.assertEqual(g["accessors"][g["meshes"][0]["primitives"][0]["attributes"]["COLOR_0"]]["normalized"], True)
        lin = C[:, :3] / 65535.0
        self.assertTrue(np.any(np.all(np.abs(lin - [1, 0, 0]) < 1e-3, axis=1)))
        self.assertTrue(np.any(np.all(np.abs(lin - 0.2140) < 2e-3, axis=1)))  # sRGB 0.5 → linear 0.214

    def test_uint8_colours_from_trimesh_are_scaled(self):
        v, f = triposr_mesh(box_level(0.2, 0.2, 0.2))
        dark = np.ones((len(v), 3), np.uint8)  # almost black, as trimesh stores it: must not turn white
        _g, _b, a = meshkit.read_glb(meshkit.build_glb(v, f, dark))
        self.assertLess(float(a["COLOR_0"][:, :3].max()) / 65535.0, 0.01)

    def test_size_of_a_typical_mesh(self):
        X, Y, Z = grid()
        lv = (0.35 - np.sqrt((X - .5) ** 2 + (Y - .5) ** 2 + (Z - .5) ** 2)).astype(np.float32)
        v, f = triposr_mesh(lv)
        glb = meshkit.build_glb(v, f, np.full((len(v), 3), 0.7))
        per_face = len(glb) / len(f)
        self.assertLess(per_face, 40)  # ~ 20 bytes per face with 16-bit indices: 80 000 faces ≈ 2–3 MB


if __name__ == "__main__":
    unittest.main()
