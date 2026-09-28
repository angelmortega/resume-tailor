"""Start Resume Tailor at http://localhost:8000

    uv run main.py               # starts the app and opens your browser
    uv run main.py --no-browser  # starts the app only
"""

import shutil
import sys
import threading
import webbrowser

import uvicorn

PORT = 8000


def main():
    if not shutil.which("tectonic"):
        sys.exit("Tectonic (turns LaTeX into PDFs) isn't installed. Install it with:\n\n    brew install tectonic\n")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.5, webbrowser.open, [f"http://localhost:{PORT}"]).start()
    uvicorn.run("app.main:app", port=PORT)


if __name__ == "__main__":
    main()
