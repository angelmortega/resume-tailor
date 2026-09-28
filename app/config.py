import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

# RESUME_TAILOR_DATA lets you point the app at another folder (e.g. a throwaway one for testing).
DATA_DIR = Path(os.getenv("RESUME_TAILOR_DATA", ROOT / "data"))
PROFILE_DIR = DATA_DIR / "profile"
ASSETS_DIR = PROFILE_DIR / "assets"  # extra .cls/.sty/fonts/images your templates need
APPS_DIR = DATA_DIR / "applications"
DB_PATH = DATA_DIR / "app.db"

# Sonnet 5 at medium effort: near-Opus writing quality at a fraction of the cost.
# Set MODEL=claude-opus-5 (and EFFORT=high) in .env for the strongest, priciest option.
MODEL = os.getenv("MODEL", "claude-sonnet-5")
EFFORT = os.getenv("EFFORT", "medium")

for d in (DATA_DIR, PROFILE_DIR, ASSETS_DIR, APPS_DIR):
    d.mkdir(parents=True, exist_ok=True)
