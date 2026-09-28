#!/bin/zsh
# Start Resume Tailor at http://localhost:8000
cd "$(dirname "$0")"
command -v uv >/dev/null || { echo "Installing uv (Python package manager)…"; brew install uv; }
command -v tectonic >/dev/null || { echo "Installing Tectonic (LaTeX → PDF)…"; brew install tectonic; }
[ -z "$NO_OPEN" ] && (sleep 2 && open http://localhost:8000) &
exec uv run uvicorn app.main:app --port 8000
