"""Shared test setup. Claude is never called: tests replace the llm functions with fakes.
LaTeX compiles for real with Tectonic, so the PDF checks run on real PDFs."""

import os
import tempfile

import pytest

# Point the app at a throwaway data folder before anything imports app.config.
os.environ["RESUME_TAILOR_DATA"] = tempfile.mkdtemp(prefix="resume-tailor-test-")

from app import db, llm, pipeline, profile  # noqa: E402

RESUME = r"""\documentclass[letterpaper,11pt]{article}
\usepackage[empty]{fullpage}
\usepackage{enumitem}
\begin{document}
\begin{center}{\Huge Test Person} \\ test@example.com\end{center}
\section{Experience}
\begin{itemize}
\item Built data pipelines in Python and SQL; deployed on Kubernetes and AWS with CI/CD.
\end{itemize}
\section{Skills}
\textbf{Languages}: Python, SQL \\
\textbf{Cloud}: AWS, Kubernetes
\end{document}
"""

COVER = r"""\documentclass[11pt]{letter}
\usepackage[margin=1in]{geometry}
\signature{Test Person}
\begin{document}
\begin{letter}{Hiring Manager \\ Company}
\opening{Dear Hiring Manager,}
Body text here.
\closing{Sincerely,}
\end{letter}
\end{document}
"""


def keyword(term, in_background=True, importance="required"):
    return {"term": term, "variants": [], "importance": importance, "category": "hard_skill",
            "in_background": in_background, "evidence": "test"}


@pytest.fixture(scope="session", autouse=True)
def setup_profile():
    db.init()
    profile.save({"name": "Test Person", "master_cv": "Python, SQL, AWS, Kubernetes, Docker.",
                  "resume_template": RESUME, "cover_template": COVER, "cover_reference": "",
                  "template_has_my_info": True, "resume_page_limit": 0})


class FakeClaude:
    """Stands in for app.llm. Records every revise instruction it gets."""

    def __init__(self, monkeypatch, resume=RESUME, cover=COVER, keywords=None, revise=None):
        self.instructions = []
        self.fixes = 0
        self._revise = revise or (lambda r, c, instr: {"resume_tex": "", "cover_letter_tex": "", "changes": ""})
        out = {"company": "Acme", "role": "Engineer", "location": "Remote", "changes": "- test",
               "keywords": keywords or [keyword("Python"), keyword("AWS")], "resume_tex": resume, "cover_letter_tex": cover}
        monkeypatch.setattr(llm, "generate", lambda prof, jd, progress: dict(out))
        monkeypatch.setattr(llm, "revise", self.revise)
        monkeypatch.setattr(llm, "fix_latex", self.fix_latex)

    def revise(self, prof, jd, resume_tex, cover_tex, instructions, progress, label="Revising"):
        self.instructions.append(instructions)
        return self._revise(resume_tex, cover_tex, instructions)

    def fix_latex(self, tex, log, progress):
        self.fixes += 1
        return tex.replace(r"\badcommand", "")


@pytest.fixture
def new_app():
    """Create an application and run the (faked) generation synchronously."""
    def make():
        app_id = db.create("A job posting " * 10)
        pipeline.generate(app_id, lambda msg: None)
        return app_id
    return make
