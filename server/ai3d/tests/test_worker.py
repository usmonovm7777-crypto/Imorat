"""The worker's own logic that does not need torch: GPU → CPU fallback for one job only, which errors are retried."""
import os, sys, types, unittest, urllib.error, http.client

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import worker  # noqa: E402


class FakeModel:
    def __init__(self): self.moves = []
    def to(self, d): self.moves.append(d); return self


def engine(fail_with):
    e = worker.TripoSREngine.__new__(worker.TripoSREngine)  # no TripoSR, no torch: only the control flow is under test
    e.home_device = e.device = "mps"; e.model = FakeModel(); e.calls = []
    e.torch = types.SimpleNamespace(mps=types.SimpleNamespace(empty_cache=lambda: e.calls.append("empty_cache")), cuda=None)
    e._prepare = lambda b: "image"

    def _make(image, t0):
        e.calls.append(e.device)
        if e.device != "cpu" and fail_with:
            raise fail_with
        return b"glb-from-" + e.device.encode()
    e._make = _make
    return e


class Worker(unittest.TestCase):
    def test_gpu_out_of_memory_runs_this_job_on_cpu_and_the_next_on_gpu_again(self):
        e = engine(RuntimeError("MPS backend out of memory (MPS allocated: 9 GB)"))
        self.assertEqual(e.make(b"photo"), b"glb-from-cpu")
        self.assertEqual(e.device, "mps"); self.assertEqual(e.model.moves, ["cpu", "mps"]); self.assertIn("empty_cache", e.calls)

    def test_a_non_device_error_is_not_hidden_by_the_cpu_fallback(self):
        e = engine(RuntimeError("shape '[0, -1]' is invalid for input of size 0"))
        with self.assertRaises(RuntimeError):
            e.make(b"photo")
        self.assertEqual(e.model.moves, []); self.assertEqual(e.device, "mps")

    def test_no_object_is_final(self):
        e = engine(worker.NoObject("no_object: TripoSR found no surface"))
        with self.assertRaises(worker.NoObject):
            e.make(b"photo")
        self.assertEqual(e.model.moves, [])

    def test_which_errors_go_back_to_the_queue(self):
        for err in (worker.Transient("result: HTTP 502"), TimeoutError(), ConnectionResetError(), http.client.RemoteDisconnected("x"), urllib.error.URLError("dns")):
            self.assertIsInstance(err, worker.RETRYABLE, repr(err))
        from PIL import UnidentifiedImageError
        self.assertNotIsInstance(UnidentifiedImageError("bad photo"), worker.RETRYABLE)  # a broken photo is not retried

    def test_server_errors_are_transient_client_errors_are_not(self):
        api = worker.Api("http://x", "t")
        with self.assertRaises(worker.Transient):
            api._json(503, b"{}", "next")
        with self.assertRaises(worker.Transient):
            api._json(429, b"{}", "next")
        with self.assertRaises(RuntimeError):
            api._json(409, b'{"error":"not_processing"}', "result")
        with self.assertRaises(SystemExit):
            api._json(401, b"{}", "next")


if __name__ == "__main__":
    unittest.main()
