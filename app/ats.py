"""Check the compiled resume PDF for the job's keywords, the way an ATS would:
by searching the text it can extract from the PDF, not the LaTeX source."""

import re
import unicodedata

_LIGATURES = {"ﬁ": "fi", "ﬂ": "fl", "ﬀ": "ff", "ﬃ": "ffi", "ﬄ": "ffl", "’": "'", "–": "-", "—": "-"}


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    for a, b in _LIGATURES.items():
        text = text.replace(a, b)
    text = re.sub(r"-\s*\n\s*", "", text)  # words hyphenated across a line break
    return re.sub(r"\s+", " ", text).lower()


def _pattern(term: str):
    t = _normalize(term).strip()
    if not t:
        return None
    # PDF text extraction sometimes splits words ("A WS"), so allow a stray space between
    # characters. Keyword boundaries keep "R" from matching inside "React" and "AWS" inside
    # "draws", while "C++" / "C#" still work.
    body = r"\s?".join(r"\s*" if ch == " " else re.escape(ch) for ch in t)
    return re.compile(r"(?<![a-z0-9])" + body + r"(?![a-z0-9])")


def _found(term: str, text: str) -> bool:
    pat = _pattern(term)
    return bool(pat and pat.search(text))


def check(keywords: list[dict], pdf_text: str) -> dict:
    text = _normalize(pdf_text)
    results = []
    for k in keywords:
        exact = _found(k["term"], text)
        variant = next((v for v in k.get("variants", []) if _found(v, text)), None)
        results.append({**k, "found": exact, "found_variant": None if exact else variant})

    def pct(items):
        return round(100 * sum(r["found"] for r in items) / len(items)) if items else 100

    supported = [r for r in results if r.get("in_background")]
    required = [r for r in results if r.get("importance") == "required"]
    return {
        "keywords": results,
        "score_all": pct(results),  # share of every JD keyword present
        "score_supported": pct(supported),  # share of keywords your background backs up
        "score_required": pct(required),
        "missing_supported": [r["term"] for r in supported if not r["found"]],
    }
