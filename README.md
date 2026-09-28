# Resume Tailor

A local web app that uses Claude to tailor your LaTeX resume and cover letter to a job
posting, makes sure the resume covers the posting's ATS keywords (only ones you actually have),
and keeps every posting you applied to so you can look at it again before an interview.

## First-time setup

0. **Install the tools** (once): [uv](https://docs.astral.sh/uv/) for Python, and Tectonic,
   which turns LaTeX into PDFs:
   ```
   brew install uv tectonic
   ```
1. **Get an Anthropic API key**: go to https://console.anthropic.com, sign in, then
   *API keys → Create key*. Add a few dollars of credit under *Billing*. This is separate
   from a Claude.ai subscription.
2. Copy `.env.example` to `.env` (if there's no `.env` yet) and paste the key into it:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
3. Start the app:
   ```
   uv run main.py
   ```
   It opens http://localhost:8000 (add `--no-browser` to skip that). Stop it with Ctrl+C.
   The first run installs the Python packages pinned in `uv.lock` automatically.
4. On the **Profile** tab:
   1. **Your info**: dump everything about you (jobs, research, projects, skills, awards, contact
      details). Paste it, or add files (PDF, Word, .tex, .txt); files are appended, so you can add your
      CV plus old resumes. This is the pool Claude picks from for every job.
   2. **Resume template**: your `.tex` resume. Say whether it's your real resume or just a
      blank/sample template. Either way its design and macros are kept, and its content is rebuilt
      from your info for each job. Pick a max page count (default: whatever the template compiles to).
   3. **Cover letter template**: your `.tex` cover letter. Its layout is kept and the text is written
      fresh for each job.
   4. **Reference cover letter** (recommended): a cover letter you wrote and like (paste it or load a
      PDF/Word/.txt). Claude matches its voice, tone, length, paragraph structure, opening and
      closing, so every new letter sounds like you. Its company-specific parts aren't reused.

   Click **Save**. The app compiles both templates once to check they work. If a template uses a
   custom `.cls`/`.sty`, font or image, upload it under *Extra template files*.

## Using it

- **New application**: paste the job description and click *Tailor*. Claude:
  1. pulls out the company, role and 15–35 ATS keywords, and marks which ones your background supports,
  2. picks the most relevant experience, projects and skills from your info dump for this role,
     writes fresh bullets aimed at the posting, and builds them into your resume template with the
     template's own LaTeX commands (it can add/reorder sections in the same style); then writes the cover letter in your
     reference letter's style inside your cover letter template,
  3. compiles the PDFs (automatically fixing any LaTeX errors),
  4. scans the text of the compiled PDF the way an ATS would. If a keyword you have is missing,
     or the resume runs over its page count, Claude revises it (up to 2 extra passes).
- Review the PDFs and the keyword chips, ask for changes in plain English, or edit the LaTeX yourself.
- Click **Save as applied** once you've sent it. It then shows up in **Applications**, where you can
  update the status (applied → interview → offer / rejected), add notes, and read the original
  job description again.

## Where things are

- `data/`: everything you save (database, profile, per-application `.tex`/`.pdf`). Back this folder up.
- `.env`: API key, and optionally `MODEL` (default `claude-opus-5`) and `EFFORT` (`low`…`max`, default `high`).
- `app/`: the code (FastAPI backend, and a plain HTML/JS frontend in `app/static`).
- `pyproject.toml` / `uv.lock`: dependencies. Add one with `uv add <package>`.

Each application costs roughly $0.30–1.00 in API usage at the default settings, depending on how
long your CV is and how many revision passes it needs.
