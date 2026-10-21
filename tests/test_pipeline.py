"""End-to-end pipeline tests with a fake Claude and real LaTeX compiles."""

from app import db, pipeline

from .conftest import COVER, RESUME, FakeClaude, keyword


def skills(n):
    return "\\section{Skills}\n" + "".join(f"\\textbf{{Group{i}}}: Python, AWS \\\\\n" for i in range(n))


def test_compile_error_is_fixed_and_missing_keyword_polished(monkeypatch, new_app):
    broken = RESUME.replace(r"\end{itemize}", "\\item broken \\badcommand\n\\end{itemize}")
    fake = FakeClaude(monkeypatch, resume=broken, keywords=[keyword("Python"), keyword("Docker")],
                      revise=lambda r, c, i: {"resume_tex": r.replace("CI/CD.", "CI/CD and Docker."), "cover_letter_tex": "", "changes": ""})
    a = db.get(new_app())
    assert a["job_state"] != "error"
    assert fake.fixes == 1
    assert "Docker" in fake.instructions[0]
    assert a["ats"]["missing_supported"] == []


def test_revise_only_changes_the_chosen_document(monkeypatch, new_app):
    # This fake Claude edits BOTH documents every time, whatever it is asked.
    n = [0]

    def edit_both(r, c, instr):
        n[0] += 1
        return {"resume_tex": r + f"% edit {n[0]}", "cover_letter_tex": c + f"% edit {n[0]}", "changes": "- x"}

    FakeClaude(monkeypatch)
    app_id = new_app()
    FakeClaude(monkeypatch, revise=edit_both)
    for target, resume_changes, cover_changes in [("resume", True, False), ("cover_letter", False, True), ("both", True, True)]:
        r0, c0 = pipeline.read_tex(app_id, "resume"), pipeline.read_tex(app_id, "cover_letter")
        pipeline.revise(app_id, lambda m: None, "change something", target)
        assert (pipeline.read_tex(app_id, "resume") != r0) == resume_changes, target
        assert (pipeline.read_tex(app_id, "cover_letter") != c0) == cover_changes, target


def test_long_cover_letter_is_trimmed_without_touching_resume(monkeypatch, new_app):
    long_cover = COVER.replace("Body text here.", " ".join(["A real sentence about Python work."] * 60))
    fake = FakeClaude(monkeypatch, cover=long_cover,
                      revise=lambda r, c, i: {"resume_tex": r + "% touched", "cover_letter_tex": COVER, "changes": ""})
    app_id = new_app()
    a = db.get(app_id)
    assert "cover letter body" in fake.instructions[0]
    assert "% touched" not in pipeline.read_tex(app_id, "resume")
    assert a["ats"]["cover_words"] <= pipeline.COVER_MAX_WORDS


def test_too_many_skill_lines_are_merged(monkeypatch, new_app):
    six = RESUME.split("\\section{Skills}")[0] + skills(6) + "\\end{document}\n"
    fake = FakeClaude(monkeypatch, resume=six,
                      revise=lambda r, c, i: {"resume_tex": r.replace(skills(6), skills(3)), "cover_letter_tex": c + "% touched", "changes": ""})
    app_id = new_app()
    a = db.get(app_id)
    assert "Skills section has 6" in fake.instructions[0]
    assert a["ats"]["skill_lines"] == 3
    assert "% touched" not in pipeline.read_tex(app_id, "cover_letter")


def test_bare_percent_is_escaped_when_saved(monkeypatch, new_app):
    FakeClaude(monkeypatch, cover=COVER.replace("Body text here.", "We cut costs by 7% last year and more."))
    app_id = new_app()
    assert r"7\% last year" in pipeline.read_tex(app_id, "cover_letter")
