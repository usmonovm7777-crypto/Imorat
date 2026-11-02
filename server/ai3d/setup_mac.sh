#!/bin/bash
# Quriliş Go AI 3D worker on a Mac with Apple Silicon (M1–M4): a private Python environment, PyTorch with MPS, TripoSR (MIT)
# at a fixed commit, the worker's packages; checks that MPS works. Nothing is installed system-wide; everything is in ./venv
# and ./TripoSR next to this script. Free and open source; the first run downloads the model weights (~1.7 GB, Hugging Face)
# and the background-removal model (~170 MB).
#
#   bash setup_mac.sh                 install / update
#   bash setup_mac.sh --autostart     also start the worker at login and keep it running (LaunchAgent)
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd)"
TRIPOSR_COMMIT=107cefdc244c39106fa830359024f6a2f1c78871

[ "$(uname -s)" = "Darwin" ] || echo "! not macOS — this script is for Apple Silicon Macs; on Linux use the same steps with the CUDA or CPU torch wheel"
[ "$(uname -m)" = "arm64" ] || echo "! not Apple Silicon: MPS will not be available, the worker will use the CPU (slow)"
PY=""; for c in python3.11 python3.10 python3.12 python3; do if command -v $c >/dev/null 2>&1; then PY=$c; break; fi; done
[ -n "$PY" ] || { echo "Python 3 is missing: install it with  brew install python@3.11"; exit 1; }
echo "• Python: $($PY --version)  ($PY)"
command -v git >/dev/null || { echo "git is missing: xcode-select --install"; exit 1; }

[ -d venv ] || $PY -m venv venv
. venv/bin/activate
python -m pip install -q --upgrade pip wheel
echo "• PyTorch (with MPS on Apple Silicon)…"
python -m pip install -q "torch>=2.2" "torchvision>=0.17"
echo "• TripoSR @ ${TRIPOSR_COMMIT:0:7}…"
if [ ! -d TripoSR/.git ]; then git clone -q https://github.com/VAST-AI-Research/TripoSR.git TripoSR; fi
git -C TripoSR fetch -q origin && git -C TripoSR checkout -q "$TRIPOSR_COMMIT"
echo "• worker packages…"
python -m pip install -q -r requirements.txt
python -m pip install -q fast-simplification || echo "  (fast-simplification skipped: models are kept without simplification)"
python -m pip install -q PyMCubes || echo "  (PyMCubes skipped: scikit-image does the marching cubes)"

python - <<'PY'
import torch, sys
mps = getattr(torch.backends, "mps", None)
print("• torch", torch.__version__, "| MPS available:", bool(mps and mps.is_available()), "| built:", bool(mps and mps.is_built()))
if mps and mps.is_available():
    x = torch.ones(512, 512, device="mps"); print("• MPS test:", float((x @ x).sum().cpu()) == 512 ** 3)
import meshkit, rembg, skimage  # noqa
print("• meshkit / rembg / scikit-image: OK")
PY

ENVF="$HOME/.qurilish-ai3d.env"
if [ ! -f "$ENVF" ]; then
  printf '# Quriliş Go AI 3D worker settings (keep this file private)\nAI3D_SERVER=https://api.example.uz\nMODEL3D_WORKER_TOKEN=\n# AI3D_DEVICE=auto        # auto | mps | cpu\n# AI3D_MC_RESOLUTION=256  # 192 = faster, 256 = sharper\n# AI3D_MAX_FACES=80000\n' > "$ENVF"; chmod 600 "$ENVF"
  echo "• created $ENVF — put the server address and the same MODEL3D_WORKER_TOKEN as in server/.env there"
fi

if [ "${1:-}" = "--autostart" ]; then
  PL="$HOME/Library/LaunchAgents/uz.qurilishgo.ai3d.plist"; mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$PL" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>uz.qurilishgo.ai3d</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$HERE/run_mac.sh</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/qurilish-ai3d.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/qurilish-ai3d.log</string>
</dict></plist>
PL
  launchctl unload "$PL" 2>/dev/null || true; launchctl load "$PL"
  echo "• autostart on: the worker runs in the background (log: ~/Library/Logs/qurilish-ai3d.log; stop: launchctl unload $PL)"
fi
echo
echo "Done. Check the connection:  bash run_mac.sh --check"
echo "Run the worker:              bash run_mac.sh"
