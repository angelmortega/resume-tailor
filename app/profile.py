"""Your standing materials: master CV, LaTeX templates, notes. Stored as plain files in data/profile."""

import json

from . import latex
from .config import PROFILE_DIR

TEXT_FIELDS = {
    "master_cv": "master_cv.txt",
    "resume_template": "resume_template.tex",
    "cover_template": "cover_template.tex",
    "cover_reference": "cover_reference.txt",
    "notes": "notes.txt",
}
META = PROFILE_DIR / "meta.json"


class ProfileError(Exception):
    pass


def _meta() -> dict:
    return json.loads(META.read_text()) if META.exists() else {}


def load() -> dict:
    p = {k: (PROFILE_DIR / f).read_text() if (PROFILE_DIR / f).exists() else "" for k, f in TEXT_FIELDS.items()}
    meta = _meta()
    p["name"] = meta.get("name", "")
    p["template_has_my_info"] = meta.get("template_has_my_info", True)
    p["compiled_resume_pages"] = meta.get("resume_pages", 1)
    # The page limit Claude must respect: your choice, else however long the template compiles to.
    p["resume_page_limit"] = meta.get("resume_page_limit")
    p["resume_pages"] = p["resume_page_limit"] or p["compiled_resume_pages"]
    p["cover_pages"] = meta.get("cover_pages", 1)
    p["ready"] = bool(p["resume_template"].strip() and p["cover_template"].strip())
    return p


def load_ready() -> dict:
    p = load()
    if not p["ready"]:
        raise ProfileError("Add your resume and cover letter LaTeX templates on the Profile tab first.")
    if not p["template_has_my_info"] and not p["master_cv"].strip():
        raise ProfileError("Your resume template is marked as sample text, so Claude needs your info dump. Add it on the Profile tab.")
    return p


def save(fields: dict) -> dict:
    """Save profile fields. New templates are compiled once to check they work and to learn their page count."""
    old = load()
    meta = _meta()
    checks = {}
    for key, pdf_name, meta_key in (
        ("resume_template", "resume_template.pdf", "resume_pages"),
        ("cover_template", "cover_template.pdf", "cover_pages"),
    ):
        tex = fields.get(key)
        if tex is None or not tex.strip() or (tex == old[key] and (PROFILE_DIR / pdf_name).exists()):
            continue
        try:
            pdf = latex.compile_tex(tex, PROFILE_DIR / pdf_name)
        except latex.CompileError as e:
            label = "Resume" if key == "resume_template" else "Cover letter"
            raise ProfileError(
                f"{label} template didn't compile. If it uses a custom .cls/.sty file, font or image, "
                f"upload it under 'Extra template files'.\n\n{e.log}"
            )
        meta[meta_key] = latex.page_count(pdf)
        checks[meta_key] = meta[meta_key]

    for key, fname in TEXT_FIELDS.items():
        if key in fields:
            (PROFILE_DIR / fname).write_text(fields[key] or "")
    if "name" in fields:
        meta["name"] = fields["name"].strip()
    if "template_has_my_info" in fields:
        meta["template_has_my_info"] = bool(fields["template_has_my_info"])
    if "resume_page_limit" in fields:
        meta["resume_page_limit"] = fields["resume_page_limit"] or None  # 0 → follow the template
    META.write_text(json.dumps(meta, indent=2))
    return checks
