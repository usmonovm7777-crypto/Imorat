#!/bin/bash
# Starts the Quriliş Go AI 3D worker with the settings from ~/.qurilish-ai3d.env (see setup_mac.sh). Extra arguments go to worker.py,
# e.g.  bash run_mac.sh --check   (only test the connection)   or   bash run_mac.sh --once --keep ~/Desktop/models
set -euo pipefail
cd "$(dirname "$0")"
ENVF="$HOME/.qurilish-ai3d.env"; [ -f "$ENVF" ] && { set -a; . "$ENVF"; set +a; }
[ -n "${MODEL3D_WORKER_TOKEN:-}" ] || { echo "MODEL3D_WORKER_TOKEN is empty — put it into $ENVF"; exit 1; }
export PYTORCH_ENABLE_MPS_FALLBACK=1
exec ./venv/bin/python worker.py --server "${AI3D_SERVER:-http://localhost:8787}" "$@"
