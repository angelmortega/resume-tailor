"""Unit tests for the deterministic checks (no Claude, no LaTeX)."""

from app import ats, latex, pipeline


def test_keyword_match_respects_word_boundaries():
    text = "Built C++ and C# tools on AWS. Draws laws. React apps."
    found = {k["term"]: k["found"] for k in ats.check(
        [{"term": t, "in_background": True, "importance": "required"} for t in ["C++", "C#", "AWS", "R", "Go", "React"]],
        text)["keywords"]}
    assert found == {"C++": True, "C#": True, "AWS": True, "R": False, "Go": False, "React": True}


def test_keyword_match_survives_pdf_extraction_quirks():
    # PDF text can split letters ("A WS") and hyphenate across lines.
    result = ats.check([{"term": "AWS", "in_background": True}, {"term": "fine-tuning", "in_background": True}],
                       "deployed on A WS and did fine-tun-\ning")
    assert all(k["found"] for k in result["keywords"])


def test_escape_percents_only_after_digits():
    assert latex.escape_percents("a 7% rate and 100%") == r"a 7\% rate and 100\%"
    assert latex.escape_percents(r"already 7\% ok") == r"already 7\% ok"
    assert latex.escape_percents("% a real comment") == "% a real comment"
    assert latex.escape_percents(r"\vspace{-5pt}% trailing") == r"\vspace{-5pt}% trailing"


def test_skill_lines_counts_labels_not_inline_bold():
    tex = "\\section{Skills}\n  \\textbf{Languages}{: Python, \\textbf{SQL}} \\\\\n  \\textbf{Cloud}{: AWS}\n\\end{document}"
    assert pipeline.skill_lines(tex) == 2
    assert pipeline.skill_lines("\\section*{Technical Skills}\n\\textbf{A}: x\n\\section{Other}") == 1
    assert pipeline.skill_lines("no skills section") == 0


def test_cover_body_words_counts_greeting_to_signoff():
    letter = "Header line\nDear Hiring Manager,\none two three\nThank you for reading.\nSincerely,\nName"
    assert pipeline.cover_body_words(letter) == 7
