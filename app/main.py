import html
import io
import os
import re
import shutil
import zipfile
from datetime import date
from typing import Literal

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pypdf import PdfReader

from . import db, latex, pipeline, profile
from .config import ASSETS_DIR, MODEL, ROOT

app = FastAPI(title="Resume Tailor")
db.init()

STATIC = ROOT / "app" / "static"


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


# ---- profile ----------------------------------------------------------------

@app.get("/api/profile")
def get_profile():
    p = profile.load()
    p["assets"] = sorted(f.name for f in ASSETS_DIR.iterdir() if f.is_file())
    p["api_key_set"] = bool(os.getenv("ANTHROPIC_API_KEY"))
    p["model"] = MODEL
    return p


class ProfileIn(BaseModel):
    name: str | None = None
    master_cv: str | None = None
    resume_template: str | None = None
    cover_template: str | None = None
    cover_reference: str | None = None
    notes: str | None = None
    template_has_my_info: bool | None = None
    resume_page_limit: int | None = None


@app.post("/api/profile")
def save_profile(body: ProfileIn):
    try:
        checks = profile.save(body.model_dump(exclude_none=True))
    except profile.ProfileError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "checks": checks}


@app.post("/api/profile/extract-text")
async def extract_text(file: UploadFile):
    """Turn an uploaded document (PDF / Word / .tex / .txt / .md) into text for a profile box."""
    data = await file.read()
    name = file.filename.lower()
    if name.endswith(".pdf"):
        reader = PdfReader(io.BytesIO(data))
        return {"text": "\n".join(p.extract_text() or "" for p in reader.pages)}
    if name.endswith(".docx"):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            xml = z.read("word/document.xml").decode("utf-8", errors="replace")
        xml = re.sub(r"</w:p>", "\n", xml)
        xml = re.sub(r"<w:tab/>", "\t", xml)
        return {"text": html.unescape(re.sub(r"<[^>]+>", "", xml)).strip()}
    return {"text": data.decode("utf-8", errors="replace")}


@app.post("/api/profile/assets")
async def upload_assets(files: list[UploadFile]):
    for f in files:
        name = os.path.basename(f.filename)
        (ASSETS_DIR / name).write_bytes(await f.read())
    return {"ok": True}


@app.delete("/api/profile/assets/{name}")
def delete_asset(name: str):
    (ASSETS_DIR / os.path.basename(name)).unlink(missing_ok=True)
    return {"ok": True}


# ---- applications -------------------------------------------------------------

def _get_or_404(app_id: int):
    a = db.get(app_id)
    if not a:
        raise HTTPException(404, "Application not found")
    return a


def _ensure_idle(a):
    if a["job_state"] == "running":
        raise HTTPException(409, "Claude is still working on this one.")


class NewApp(BaseModel):
    job_description: str


@app.post("/api/applications")
def create_application(body: NewApp):
    if len(body.job_description.strip()) < 50:
        raise HTTPException(400, "That job description looks too short. Paste the full posting.")
    try:
        profile.load_ready()
    except profile.ProfileError as e:
        raise HTTPException(400, str(e))
    app_id = db.create(body.job_description.strip())
    pipeline.start(app_id, pipeline.generate)
    return {"id": app_id}


@app.get("/api/applications")
def list_applications():
    rows = db.list_all()
    for r in rows:  # the list only needs the headline numbers
        a = r.pop("ats") or {}
        r["ats_score"] = a.get("score_supported")
    return rows


@app.get("/api/applications/{app_id}")
def get_application(app_id: int):
    a = _get_or_404(app_id)
    a["resume_tex"] = pipeline.read_tex(app_id, "resume")
    a["cover_letter_tex"] = pipeline.read_tex(app_id, "cover_letter")
    d = pipeline.app_dir(app_id)
    a["has_pdfs"] = (d / "resume.pdf").exists() and (d / "cover_letter.pdf").exists()
    a["pdf_version"] = int(max((d / f).stat().st_mtime for f in ("resume.pdf", "cover_letter.pdf"))) if a["has_pdfs"] else 0
    return a


class AppPatch(BaseModel):
    status: Literal["draft", "applied", "interview", "offer", "rejected"] | None = None
    notes: str | None = None
    company: str | None = None
    role: str | None = None
    location: str | None = None
    applied_at: str | None = None


@app.patch("/api/applications/{app_id}")
def patch_application(app_id: int, body: AppPatch):
    a = _get_or_404(app_id)
    fields = body.model_dump(exclude_none=True)
    if fields.get("status", "draft") != "draft" and not a["applied_at"] and "applied_at" not in fields:
        fields["applied_at"] = date.today().isoformat()
    if fields:
        db.update(app_id, **fields)
    return db.get(app_id)


class ReviseIn(BaseModel):
    instructions: str
    target: Literal["resume", "cover_letter", "both"] = "both"


@app.post("/api/applications/{app_id}/revise")
def revise_application(app_id: int, body: ReviseIn):
    a = _get_or_404(app_id)
    _ensure_idle(a)
    if not body.instructions.strip():
        raise HTTPException(400, "Tell Claude what to change.")
    pipeline.start(app_id, pipeline.revise, body.instructions.strip(), body.target)
    return {"ok": True}


@app.post("/api/applications/{app_id}/retry")
def retry_application(app_id: int):
    a = _get_or_404(app_id)
    _ensure_idle(a)
    pipeline.start(app_id, pipeline.rebuild)
    return {"ok": True}


class TexIn(BaseModel):
    which: Literal["resume", "cover_letter"]
    tex: str


@app.put("/api/applications/{app_id}/tex")
def save_tex(app_id: int, body: TexIn):
    a = _get_or_404(app_id)
    _ensure_idle(a)
    try:
        pipeline.save_manual_edit(app_id, body.which, body.tex)
    except latex.CompileError as e:
        raise HTTPException(400, "Didn't compile, so your edit wasn't saved:\n\n" + e.log)
    except profile.ProfileError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.delete("/api/applications/{app_id}")
def delete_application(app_id: int):
    a = _get_or_404(app_id)
    _ensure_idle(a)
    db.delete(app_id)
    shutil.rmtree(pipeline.app_dir(app_id), ignore_errors=True)
    return {"ok": True}


def _slug(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_")


@app.get("/api/applications/{app_id}/pdf/{which}")
def get_pdf(app_id: int, which: Literal["resume", "cover_letter"], download: bool = False):
    a = _get_or_404(app_id)
    pdf = pipeline.app_dir(app_id) / f"{which}.pdf"
    if not pdf.exists():
        raise HTTPException(404, "PDF not built yet")
    name = profile.load()["name"]
    label = "Resume" if which == "resume" else "Cover_Letter"
    filename = "_".join(p for p in (_slug(name), label, _slug(a["company"])) if p) + ".pdf"
    return FileResponse(pdf, media_type="application/pdf", filename=filename,
                        content_disposition_type="attachment" if download else "inline")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
