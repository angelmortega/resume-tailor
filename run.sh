#!/bin/zsh
# Start Resume Tailor at http://localhost:8000
cd "$(dirname "$0")"
command -v tectonic >/dev/null || { echo "Installing Tectonic (LaTeX → PDF)…"; brew install tectonic; }
if [ ! -d .venv ]; then
  python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt
fi
[ -z "$NO_OPEN" ] && (sleep 2 && open http://localhost:8000) &
exec .venv/bin/uvicorn app.main:app --port 8000
