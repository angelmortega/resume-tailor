"""Compile LaTeX to PDF with Tectonic and read PDFs back (page count, text)."""

import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from pypdf import PdfReader

from .config import ASSETS_DIR

# Tectonic runs XeTeX, which already emits searchable Unicode text. These pdfTeX-only
# lines (common in resume templates for ATS friendliness) would fail there, so skip them.
_PDFTEX_ONLY = [
    re.compile(r"^\s*\\input\{glyphtounicode\}.*$", re.M),
    re.compile(r"^\s*\\pdfgentounicode\s*=\s*1.*$", re.M),
]


# In LaTeX a bare "%" starts a comment and silently drops the rest of the line. After a
# digit ("7%") it is always meant as a percent sign, so escape it.
_BARE_PERCENT = re.compile(r"(?<=\d)%")


def escape_percents(tex: str) -> str:
    return _BARE_PERCENT.sub(r"\\%", tex)


class CompileError(Exception):
    def __init__(self, log: str):
        super().__init__("LaTeX compile failed")
        self.log = log


def _xetex_compatible(tex: str) -> str:
    for pat in _PDFTEX_ONLY:
        tex = pat.sub(lambda m: "% (skipped for XeTeX) " + m.group(0).strip(), tex)
    return tex


def compile_tex(tex: str, out_pdf: Path) -> Path:
    """Compile `tex` and write the PDF to `out_pdf`. Raises CompileError with a trimmed log."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        for f in ASSETS_DIR.iterdir():
            if f.is_file():
                shutil.copy(f, tmp / f.name)
        (tmp / "doc.tex").write_text(_xetex_compatible(tex), encoding="utf-8")
        try:
            proc = subprocess.run(
                ["tectonic", "--chatter", "minimal", "--keep-logs", "doc.tex"],
                cwd=tmp, capture_output=True, text=True, timeout=300,
            )
        except FileNotFoundError:
            raise CompileError("Tectonic is not installed. Run: brew install tectonic")
        except subprocess.TimeoutExpired:
            raise CompileError("LaTeX compile timed out after 5 minutes.")
        pdf = tmp / "doc.pdf"
        if proc.returncode != 0 or not pdf.exists():
            raise CompileError(_trim_log(proc.stdout + "\n" + proc.stderr, tmp / "doc.log"))
        out_pdf.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(pdf, out_pdf)
    return out_pdf


def _trim_log(output: str, log_file: Path) -> str:
    lines = [l for l in output.splitlines() if l.strip() and "downloading" not in l.lower()]
    text = "\n".join(lines)
    if log_file.exists():
        log = log_file.read_text(errors="replace")
        # The interesting part of a TeX log starts at the first "!" error line.
        i = log.find("\n!")
        if i != -1:
            text += "\n--- log excerpt ---\n" + log[i : i + 2500]
    return text[-5000:]


def page_count(pdf: Path) -> int:
    return len(PdfReader(pdf).pages)


def pdf_text(pdf: Path) -> str:
    """The text an ATS would see when it parses this PDF."""
    return "\n".join(p.extract_text() or "" for p in PdfReader(pdf).pages)
