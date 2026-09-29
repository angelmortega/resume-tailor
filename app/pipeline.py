"""Background jobs: tailor → compile (auto-fix errors) → enforce page limit + ATS keywords."""

import re
import threading
import traceback

from . import ats, db, latex, llm, profile
from .config import APPS_DIR

MAX_POLISH_ROUNDS = 2  # extra Claude passes for page length / missing keywords
BOTH_DOCS = ("resume", "cover_letter")
COVER_MAX_WORDS = 260  # body words; Claude aims for 180-250, this is the point where we make it trim

_LETTER_BODY = re.compile(
    r"^Dear\b.*?$(.*?)^(?:Sincerely|Best|Best regards|Kind regards|Regards|Warm regards|Respectfully)\b",
    re.S | re.M)


def cover_body_words(pdf_text: str) -> int:
    """Words between the greeting and the sign-off (falls back to the whole letter)."""
    m = _LETTER_BODY.search(pdf_text)
    return len((m.group(1) if m else pdf_text).split())


def app_dir(app_id: int):
    d = APPS_DIR / str(app_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def read_tex(app_id: int, which: str) -> str:
    f = app_dir(app_id) / f"{which}.tex"
    return f.read_text() if f.exists() else ""


def _write_tex(app_id: int, which: str, tex: str):
    (app_dir(app_id) / f"{which}.tex").write_text(latex.escape_percents(tex))


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
    # Enforce the chosen scope in code, even if Claude edited the other document anyway,
    # and keep the automatic polish pass inside the same scope.
    allowed = BOTH_DOCS if target == "both" else (target,)
    _apply(app_id, out, allowed)
    db.update(app_id, changes=out["changes"])
    _build(app_id, prof, app["ats"].get("keywords", []), progress, allowed)


def rebuild(app_id: int, progress):
    """Re-run the build (compile + checks) on the current LaTeX, e.g. after a failure."""
    app = db.get(app_id)
    if not read_tex(app_id, "resume"):
        return generate(app_id, progress)
    _build(app_id, profile.load_ready(), app["ats"].get("keywords", []), progress)


# ---- build ------------------------------------------------------------------

def _apply(app_id: int, out: dict, allowed=BOTH_DOCS):
    """Save Claude's updated documents, but only the ones it's allowed to change."""
    for which in allowed:
        tex = out.get(f"{which}_tex", "")
        if tex.strip():
            _write_tex(app_id, which, tex)


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
    result["cover_words"] = cover_body_words(latex.pdf_text(d / "cover_letter.pdf"))
    result["cover_word_limit"] = COVER_MAX_WORDS
    return result


def _issues(r: dict) -> list[tuple[str, str]]:
    """Problems found by the checks, each tagged with the document that has to change."""
    out = []
    if r["resume_pages"] > r["resume_page_limit"]:
        out.append(("resume", f"The resume compiles to {r['resume_pages']} pages but must fit on {r['resume_page_limit']}. "
                   "Tighten it: trim the least relevant bullets/projects and wordy phrasing, keeping every supported keyword."))
    if r["cover_pages"] > r["cover_page_limit"]:
        out.append(("cover_letter", f"The cover letter runs to {r['cover_pages']} pages; cut it to {r['cover_page_limit']}."))
    if r.get("cover_words", 0) > COVER_MAX_WORDS:
        out.append(("cover_letter", f"The cover letter body is {r['cover_words']} words. Cut it to about 220 words "
                    "(180-250), keeping the reason for interest and the strongest qualifications."))
    if r["missing_supported"]:
        out.append(("resume", "An ATS scan of the compiled resume PDF can't find these keywords, which the candidate's background "
                   "supports: " + "; ".join(r["missing_supported"]) + ". Add each one in the posting's exact wording where it reads naturally: "
                   "usually the Skills section, or a bullet only if it truly describes that work. Do not force it into a sentence."))
    return out


def _build(app_id: int, prof: dict, keywords: list, progress, allowed=BOTH_DOCS):
    """Compile, check, and let Claude fix page length / missing keywords, touching only
    the document that has the problem and only documents in `allowed`."""
    app = db.get(app_id)
    for round_ in range(MAX_POLISH_ROUNDS + 1):
        progress("Compiling PDFs…")
        _compile(app_id, "resume", progress)
        _compile(app_id, "cover_letter", progress)
        progress("Running ATS keyword check on the PDF…")
        result = evaluate(app_id, prof, keywords)
        fixable = [(doc, msg) for doc, msg in _issues(result) if doc in allowed]
        if not fixable or round_ == MAX_POLISH_ROUNDS:
            break
        docs = {doc for doc, _ in fixable}
        keep = [d.replace("_", " ") for d in BOTH_DOCS if d not in docs]
        instructions = "\n".join(msg for _, msg in fixable)
        if keep:
            instructions += f"\nOnly change the {' and '.join(d.replace('_', ' ') for d in docs)}; leave the {keep[0]} unchanged."
        out = llm.revise(prof, app["job_description"], read_tex(app_id, "resume"), read_tex(app_id, "cover_letter"),
                         instructions, progress, label="Polishing (page length / ATS keywords)")
        _apply(app_id, out, tuple(docs))
    result["warnings"] = [msg for _, msg in _issues(result)]
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
    result["warnings"] = [msg for _, msg in _issues(result)]
    db.update(app_id, ats=result)
