"""All Claude calls: tailor, revise, and fix LaTeX compile errors."""

import json
import time
from datetime import date
from typing import Callable

import anthropic

from .config import EFFORT, MODEL

_client = None


def _get_client():
    # Created lazily so the app still starts (and shows a helpful error) without an API key.
    global _client
    if _client is None:
        _client = anthropic.Anthropic()
    return _client


Progress = Callable[[str], None]

RULES = """You are an expert technical recruiter and resume writer. For each job posting you build the candidate a tailored resume and cover letter, and you make sure the resume passes Applicant Tracking System (ATS) keyword screening.

# What the candidate gives you
1. An **info dump**: everything about them (jobs, internships, research, projects, leadership, coursework, skills, awards, links, contact details). It may be long, messy, unordered, or pasted from several documents. It is the source of truth for facts.
2. A **resume LaTeX template**: it defines the design (document class, macros, section styles, spacing, header layout). It may hold the candidate's own resume, or placeholder/sample text; you'll be told which.
3. A **cover letter LaTeX template** (the layout) and, optionally, a **reference cover letter** they wrote before (the writing style to match).

# Honesty (non-negotiable)
- Use only facts from the info dump, the candidate's notes, the reference cover letter, and (only if it's marked as the candidate's real info) the resume template. You may select, reorder, merge, condense and reword them.
- Never invent employers, titles, dates, degrees, courses, certifications, metrics, tools, technologies or responsibilities. Never inflate seniority or scope.
- A keyword is "in background" only if the candidate's materials genuinely support it (directly, or as an accurate description of work they did - e.g. they built REST endpoints in Flask, so "REST APIs" is supported). If it isn't supported, leave it out of the resume.

# Building the resume for this job
1. Work out what the role needs most (required qualifications first, then preferred ones, then the day-to-day responsibilities).
2. Choose content from the info dump: the experiences, projects, research, leadership, skills, coursework and awards that best show fit for this role. The most relevant items come first within each section and get the most bullets; weaker or irrelevant items are cut to respect the page limit. Different jobs should get noticeably different selections.
3. Write each bullet fresh from the info dump: strong action verb + what they did + tools used + result (metrics only if they appear in the candidate's materials). Aim the framing at this job's requirements.
4. Pour it into the template: rebuild the body using the template's own macros and environments exactly as it uses them (e.g. if entries are written with \\resumeSubheading{...}{...}{...}{...} and \\resumeItem{...}, write every entry with those same commands, repeating them for as many entries as you need). You may add, remove, rename or reorder sections (e.g. add Projects or Research, move Skills up, drop an irrelevant section) when it helps for this role, always styled like the template's existing sections. Never add a summary, objective or interests section.
5. Header and contact details come from the info dump (or from the template if it holds the candidate's real info). Keep the header to the name and contact line. Never add a headline, tagline, summary, objective, profile or interests line or section anywhere; that space belongs to experience and projects.
6. If the template contains placeholder/sample text, replace every bit of it. No sample names, employers, bullets or links may remain.

# ATS strategy
- Extract the ATS keywords from the job description: hard skills, languages, frameworks, tools, platforms, methodologies, certifications, domain terms, and the job title itself. Usually 15-35 terms. Use the exact wording the posting uses.
- For every keyword the background supports, the resume must contain the posting's exact phrase at least once (ATS matching is literal). If the candidate's materials use a different form, use the posting's form, optionally with the other in parentheses, e.g. "Amazon Web Services (AWS)".
- Prefer working keywords into real accomplishment bullets; also list them in the skills section.
- No keyword stuffing, no hidden or white text, no keyword lists pretending to be experience. The resume must still read well to a human.

# LaTeX
- Keep the template's preamble, document class, packages, custom commands, spacing and section styling exactly as they are. Change content, not design.
- Output a complete, compilable document from \\documentclass to \\end{document}.
- Escape special characters in text: & % $ # _ { } ~ ^ \\.
- Do not add packages the template doesn't already load.

# Cover letter
- Fill the cover letter LaTeX template, keeping its formatting, with the candidate's real name and contact details. Replace any placeholder text. It must fit on one page.
- Style: if a reference cover letter is provided, it is the candidate's own writing. Write the new letter so it reads as if the same person wrote it: match its tone and formality, voice, length (within about 15%), number and order of paragraphs, how it opens and closes, sentence length and rhythm, and characteristic phrasing. Don't reuse its company-specific content; its facts about the candidate may be reused when relevant.
- Without a reference letter: 250-380 words, direct and specific, no clichés ("I am writing to express my interest"), no flattery filler.
- Address it to the company and role from the posting (use "Hiring Manager" if no name is given). Use today's date.
- Connect 2-3 of the job's top requirements to specific, real experience from the info dump. Mention only facts about the company that appear in the job description. Use the posting's key terms naturally."""


def _profile_block(profile: dict) -> str:
    if profile.get("template_has_my_info"):
        template_note = ("This template contains the candidate's real current resume, so its content is also a source "
                         "of facts. Rebuild it for each job; don't just lightly edit it.")
    else:
        template_note = ("This template's text is placeholder/sample content, NOT the candidate's. Use it only for its "
                         "design and macros; take every fact from the info dump.")
    parts = [
        "# Candidate materials",
        "## Info dump (source of truth for facts)",
        profile.get("master_cv") or "(empty - use the resume template's content as the source of facts)",
        "## Resume LaTeX template",
        template_note,
        profile["resume_template"],
        "## Cover letter LaTeX template (layout only; replace its text)",
        profile["cover_template"],
        "## Reference cover letter (the candidate's own writing; match its style)",
        profile.get("cover_reference") or "(none provided)",
    ]
    if profile.get("notes"):
        parts += ["## Candidate notes and preferences", profile["notes"]]
    return "\n\n".join(parts)


def _system(profile: dict) -> list:
    # Profile rarely changes, so cache it: generations and revisions reuse the same prefix.
    return [
        {"type": "text", "text": RULES},
        {"type": "text", "text": _profile_block(profile), "cache_control": {"type": "ephemeral"}},
    ]


KEYWORD_SCHEMA = {
    "type": "object",
    "properties": {
        "term": {"type": "string", "description": "Exact wording from the job description"},
        "variants": {"type": "array", "items": {"type": "string"}, "description": "Common alternate forms (e.g. JS for JavaScript)"},
        "importance": {"type": "string", "enum": ["required", "preferred"]},
        "category": {"type": "string", "enum": ["hard_skill", "tool", "soft_skill", "certification", "domain", "title"]},
        "in_background": {"type": "boolean"},
        "evidence": {"type": "string", "description": "Where in the candidate's materials this is backed up, or why it isn't"},
    },
    "required": ["term", "variants", "importance", "category", "in_background", "evidence"],
    "additionalProperties": False,
}

GENERATE_SCHEMA = {
    "type": "object",
    "properties": {
        "company": {"type": "string"},
        "role": {"type": "string"},
        "location": {"type": "string", "description": "City/remote as stated, or empty"},
        "keywords": {"type": "array", "items": KEYWORD_SCHEMA},
        "resume_tex": {"type": "string"},
        "cover_letter_tex": {"type": "string"},
        "changes": {"type": "string", "description": "3-6 short bullet lines (starting with '- ') on what was tailored and why"},
    },
    "required": ["company", "role", "location", "keywords", "resume_tex", "cover_letter_tex", "changes"],
    "additionalProperties": False,
}

REVISE_SCHEMA = {
    "type": "object",
    "properties": {
        "resume_tex": {"type": "string", "description": "Full updated resume, or empty string if unchanged"},
        "cover_letter_tex": {"type": "string", "description": "Full updated cover letter, or empty string if unchanged"},
        "changes": {"type": "string", "description": "Short bullet lines (starting with '- ') describing what changed"},
    },
    "required": ["resume_tex", "cover_letter_tex", "changes"],
    "additionalProperties": False,
}

FIX_SCHEMA = {
    "type": "object",
    "properties": {"tex": {"type": "string"}},
    "required": ["tex"],
    "additionalProperties": False,
}


class ClaudeError(Exception):
    pass


def _model_params(schema: dict, effort: str) -> dict:
    """Request settings that differ by model family."""
    fmt = {"type": "json_schema", "schema": schema}
    if MODEL.startswith("claude-haiku"):
        # Haiku 4.5 has no effort setting and uses a fixed thinking budget; 64K max output.
        return {"max_tokens": 64000, "thinking": {"type": "enabled", "budget_tokens": 8000}, "output_config": {"format": fmt}}
    params = {"max_tokens": 64000, "thinking": {"type": "adaptive"}, "output_config": {"effort": effort, "format": fmt}}
    if MODEL.startswith(("claude-opus", "claude-fable")):
        # If a safety classifier declines, retry on Anthropic's recommended fallback model.
        params["betas"] = ["server-side-fallback-2026-07-01"]
        params["fallbacks"] = "default"
    return params


def _call(system, user_text: str, schema: dict, progress: Progress | None, label: str, effort: str = EFFORT) -> dict:
    last = 0.0
    chars = 0
    try:
        client = _get_client()
    except Exception:
        raise ClaudeError("No Anthropic API key found. Put ANTHROPIC_API_KEY=... in the .env file and restart.")
    if progress:
        progress(f"{label}… (Claude is thinking)")
    try:
        with client.beta.messages.stream(
            model=MODEL,
            system=system,
            messages=[{"role": "user", "content": user_text}],
            **_model_params(schema, effort),
        ) as stream:
            for event in stream:
                if event.type == "content_block_delta" and event.delta.type == "text_delta":
                    chars += len(event.delta.text)
                    if progress and time.time() - last > 1.5:
                        progress(f"{label}… ({chars:,} characters written)")
                        last = time.time()
            msg = stream.get_final_message()
    except (anthropic.AuthenticationError, TypeError):
        # TypeError: the SDK couldn't resolve any credentials at all.
        raise ClaudeError("Your Anthropic API key is missing or invalid. Add it to the .env file and restart.")
    except anthropic.PermissionDeniedError as e:
        raise ClaudeError(f"The API key isn't allowed to do this: {e.message}")
    except anthropic.RateLimitError:
        raise ClaudeError("Rate limited by the Anthropic API. Wait a minute and try again.")
    except anthropic.BadRequestError as e:
        if "credit" in str(e.message).lower():
            raise ClaudeError("Your Anthropic account is out of credits. Add some at console.anthropic.com → Billing.")
        raise ClaudeError(f"Anthropic API rejected the request: {e.message}")
    except anthropic.APIStatusError as e:
        raise ClaudeError(f"Anthropic API error ({e.status_code}): {e.message}. Try again.")
    except anthropic.APIConnectionError:
        raise ClaudeError("Couldn't reach the Anthropic API. Check your internet connection.")

    if msg.stop_reason == "refusal":
        raise ClaudeError("Claude declined this request. Try rephrasing or check the job description text.")
    if msg.stop_reason == "max_tokens":
        raise ClaudeError("Claude's answer was cut off (too long). Try again.")
    text = "".join(b.text for b in msg.content if b.type == "text")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise ClaudeError("Claude returned malformed output. Try again.")


def generate(profile: dict, job_description: str, progress: Progress) -> dict:
    user = f"""Today's date: {date.today():%B %-d, %Y}
The resume must fit on {profile['resume_pages']} page(s), like the current resume.

# Job description
{job_description}

Extract the ATS keywords, decide which the candidate's background supports, then write the tailored resume and cover letter."""
    return _call(_system(profile), user, GENERATE_SCHEMA, progress, "Tailoring resume & cover letter")


def revise(profile: dict, job_description: str, resume_tex: str, cover_tex: str,
           instructions: str, progress: Progress, label: str = "Revising") -> dict:
    user = f"""Today's date: {date.today():%B %-d, %Y}
The resume must fit on {profile['resume_pages']} page(s).

# Job description
{job_description}

# Current tailored resume
{resume_tex}

# Current tailored cover letter
{cover_tex}

# Requested changes
{instructions}

Apply the requested changes, following all the rules. Return the full updated document(s); return an empty string for a document you didn't change."""
    return _call(_system(profile), user, REVISE_SCHEMA, progress, label)


def fix_latex(tex: str, log: str, progress: Progress) -> str:
    system = "You fix LaTeX compile errors. The document is compiled with Tectonic (XeTeX engine). Make the smallest change that fixes the error; don't alter content or design otherwise. Return the complete corrected document."
    user = f"# Document\n{tex}\n\n# Compiler output\n{log}"
    # A small mechanical edit: low effort is plenty and keeps it cheap.
    return _call(system, user, FIX_SCHEMA, progress, "Fixing a LaTeX error", effort="low")["tex"]
