"""Background jobs: tailor → compile (auto-fix errors) → enforce page limit + ATS keywords."""

import threading
import traceback

from . import ats, db, latex, llm, profile
from .config import APPS_DIR

MAX_POLISH_ROUNDS = 2  # extra Claude passes for page length / missing keywords


def app_dir(app_id: int):
    d = APPS_DIR / str(app_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def read_tex(app_id: int, which: str) -> str:
    f = app_dir(app_id) / f"{which}.tex"
    return f.read_text() if f.exists() else ""


def _write_tex(app_id: int, which: str, tex: str):
    (app_dir(app_id) / f"{which}.tex").write_text(tex)


def start(app_id: int, fn, *args):
    db.update(app_id, job_state="running", job_message="Starting…")

    def run():
        progress = lambda m: db.update(app_id, job_message=m)
        try:
            fn(app_id, progress, *args)
            db.update(app_id, job_state="idle", job_message="")
        except (llm.ClaudeError, profile.ProfileError) as e:
            db.update(app_id, job_state="error", job_message=str(e))
        except latex.CompileError as e:
            db.update(app_id, job_state="error", job_message="LaTeX still won't compile after automatic fixes:\n" + e.log)
        except Exception as e:
            traceback.print_exc()
            db.update(app_id, job_state="error", job_message=f"Unexpected error: {e}")

    threading.Thread(target=run, daemon=True).start()


# ---- jobs -------------------------------------------------------------------

def generate(app_id: int, progress):
    prof = profile.load_ready()
    app = db.get(app_id)
    out = llm.generate(prof, app["job_description"], progress)
    db.update(app_id, company=out["company"], role=out["role"], location=out["location"], changes=out["changes"])
    _write_tex(app_id, "resume", out["resume_tex"])
    _write_tex(app_id, "cover_letter", out["cover_letter_tex"])
    _build(app_id, prof, out["keywords"], progress)


def revise(app_id: int, progress, instructions: str, target: str):
    prof = profile.load_ready()
    app = db.get(app_id)
    scope = {"resume": "Only change the resume; leave the cover letter unchanged.",
             "cover_letter": "Only change the cover letter; leave the resume unchanged.",
             "both": ""}[target]
    out = llm.revise(prof, app["job_description"], read_tex(app_id, "resume"), read_tex(app_id, "cover_letter"),
                     f"{instructions}\n{scope}".strip(), progress)
    _apply(app_id, out)
    db.update(app_id, changes=out["changes"])
    _build(app_id, prof, app["ats"].get("keywords", []), progress)


def rebuild(app_id: int, progress):
    """Re-run the build (compile + checks) on the current LaTeX, e.g. after a failure."""
    app = db.get(app_id)
    if not read_tex(app_id, "resume"):
        return generate(app_id, progress)
    _build(app_id, profile.load_ready(), app["ats"].get("keywords", []), progress)


# ---- build ------------------------------------------------------------------

def _apply(app_id: int, out: dict):
    if out.get("resume_tex", "").strip():
        _write_tex(app_id, "resume", out["resume_tex"])
    if out.get("cover_letter_tex", "").strip():
        _write_tex(app_id, "cover_letter", out["cover_letter_tex"])


def _compile(app_id: int, which: str, progress, fix: bool = True):
    label = "Resume" if which == "resume" else "Cover letter"
    for attempt in range(3):
        try:
            return latex.compile_tex(read_tex(app_id, which), app_dir(app_id) / f"{which}.pdf")
        except latex.CompileError as e:
            if not fix or attempt == 2:
                raise
            progress(f"{label} LaTeX didn't compile. Asking Claude to fix it…")
            _write_tex(app_id, which, llm.fix_latex(read_tex(app_id, which), e.log, progress))


def evaluate(app_id: int, prof: dict, keywords: list) -> dict:
    d = app_dir(app_id)
    result = ats.check(keywords, latex.pdf_text(d / "resume.pdf"))
    result["resume_pages"] = latex.page_count(d / "resume.pdf")
    result["resume_page_limit"] = prof["resume_pages"]
    result["cover_pages"] = latex.page_count(d / "cover_letter.pdf")
    result["cover_page_limit"] = prof["cover_pages"]
    return result


def _issues(r: dict) -> list[str]:
    out = []
    if r["resume_pages"] > r["resume_page_limit"]:
        out.append(f"The resume compiles to {r['resume_pages']} pages but must fit on {r['resume_page_limit']}. "
                   "Tighten it: trim the least relevant bullets/projects and wordy phrasing, keeping every supported keyword.")
    if r["cover_pages"] > r["cover_page_limit"]:
        out.append(f"The cover letter runs to {r['cover_pages']} pages; cut it to {r['cover_page_limit']}.")
    if r["missing_supported"]:
        out.append("An ATS scan of the compiled resume PDF can't find these keywords, which the candidate's background "
                   "supports: " + "; ".join(r["missing_supported"]) + ". Work each one into the resume using the job "
                   "posting's exact wording, in a real bullet or the skills section.")
    return out


def _build(app_id: int, prof: dict, keywords: list, progress):
    app = db.get(app_id)
    for round_ in range(MAX_POLISH_ROUNDS + 1):
        progress("Compiling PDFs…")
        _compile(app_id, "resume", progress)
        _compile(app_id, "cover_letter", progress)
        progress("Running ATS keyword check on the PDF…")
        result = evaluate(app_id, prof, keywords)
        issues = _issues(result)
        if not issues or round_ == MAX_POLISH_ROUNDS:
            break
        out = llm.revise(prof, app["job_description"], read_tex(app_id, "resume"), read_tex(app_id, "cover_letter"),
                         "\n".join(issues), progress, label="Polishing (page length / ATS keywords)")
        _apply(app_id, out)
    result["warnings"] = issues
    db.update(app_id, ats=result)


def save_manual_edit(app_id: int, which: str, tex: str):
    """Your own LaTeX edit: compile as-is (no automatic changes) and re-run the checks."""
    app = db.get(app_id)
    old = read_tex(app_id, which)
    _write_tex(app_id, which, tex)
    try:
        _compile(app_id, which, progress=lambda m: None, fix=False)
    except latex.CompileError:
        _write_tex(app_id, which, old)
        raise
    prof = profile.load_ready()
    result = evaluate(app_id, prof, app["ats"].get("keywords", []))
    result["warnings"] = _issues(result)
    db.update(app_id, ats=result)
