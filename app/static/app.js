const $view = document.getElementById("view");
const STATUSES = ["draft", "applied", "interview", "offer", "rejected"];
let pollTimer = null;

// ---- helpers ------------------------------------------------------------------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    init.headers = { "Content-Type": "application/json" };
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.hidden = true), 3000);
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? iso + "T00:00" : iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function statusSelect(current, attrs = "") {
  return `<select ${attrs}>${STATUSES.map((s) => `<option value="${s}" ${s === current ? "selected" : ""}>${s[0].toUpperCase() + s.slice(1)}</option>`).join("")}</select>`;
}

function readFileText(file) {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = fail;
    r.readAsText(file);
  });
}

// ---- router -------------------------------------------------------------------

async function route() {
  clearInterval(pollTimer);
  const hash = location.hash.slice(1) || "new";
  const [name, id] = hash.split("/");
  const tab = name === "app" ? "apps" : name;
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  try {
    if (name === "apps") await renderApps();
    else if (name === "app") await renderApp(+id);
    else if (name === "profile") await renderProfile();
    else await renderNew();
  } catch (e) {
    $view.innerHTML = `<div class="banner error">${esc(e.message)}</div>`;
  }
}
window.addEventListener("hashchange", route);
route();

// ---- New application ----------------------------------------------------------

async function renderNew() {
  const p = await api("/api/profile");
  let warn = "";
  if (!p.api_key_set) warn += `<div class="banner">No Anthropic API key yet. Add <code>ANTHROPIC_API_KEY=...</code> to the <code>.env</code> file in the app folder, then restart the app.</div>`;
  if (!p.ready) warn += `<div class="banner">First, add your resume and cover letter LaTeX templates on the <a href="#profile">Profile</a> tab.</div>`;
  $view.innerHTML = `
    <h1>New application</h1>
    <p class="muted">Paste the job posting. Claude tailors your resume and cover letter to it, checks the ATS keywords, and saves the posting so you can come back to it.</p>
    ${warn}
    <div class="card">
      <label class="field" for="jd">Job description</label>
      <textarea id="jd" style="min-height:360px" placeholder="Paste the full job posting here: title, company, responsibilities, qualifications…"></textarea>
      <div class="row" style="margin-top:12px">
        <button class="primary" id="go" ${p.ready ? "" : "disabled"}>Tailor my resume & cover letter</button>
        <span class="muted small">Takes about 1–3 minutes.</span>
      </div>
    </div>`;
  const jd = document.getElementById("jd");
  try { jd.value = localStorage.getItem("jd-draft") || ""; } catch {}
  jd.oninput = () => { try { localStorage.setItem("jd-draft", jd.value); } catch {} };
  document.getElementById("go").onclick = async (e) => {
    e.target.disabled = true;
    try {
      const { id } = await api("/api/applications", { method: "POST", json: { job_description: jd.value } });
      try { localStorage.removeItem("jd-draft"); } catch {}
      location.hash = `app/${id}`;
    } catch (err) {
      toast(err.message);
      e.target.disabled = false;
    }
  };
}

// ---- Applications tracker -----------------------------------------------------

let appFilter = "all";
let appSearch = "";

async function renderApps() {
  const rows = await api("/api/applications");
  const counts = Object.fromEntries(STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]));
  const draw = () => {
    const q = appSearch.toLowerCase();
    const shown = rows.filter((r) =>
      (appFilter === "all" ? r.status !== "draft" : r.status === appFilter) &&
      (!q || `${r.company} ${r.role} ${r.location}`.toLowerCase().includes(q)));
    const tracked = rows.length - counts.draft;
    $view.innerHTML = `
      <div class="row spread" style="margin-bottom:16px">
        <div><h1>Applications</h1><p class="muted" style="margin:0">${tracked} tracked${counts.draft ? ` · ${counts.draft} unsaved draft${counts.draft > 1 ? "s" : ""}` : ""}</p></div>
        <a class="btn primary" href="#new">+ New application</a>
      </div>
      <div class="card">
        <div class="row spread" style="margin-bottom:12px">
          <div class="filters">
            <button data-f="all" class="${appFilter === "all" ? "on" : ""}">All (${tracked})</button>
            ${STATUSES.filter((s) => s !== "draft").map((s) => `<button data-f="${s}" class="${appFilter === s ? "on" : ""}">${s[0].toUpperCase() + s.slice(1)} (${counts[s]})</button>`).join("")}
            ${counts.draft ? `<button data-f="draft" class="${appFilter === "draft" ? "on" : ""}">Drafts (${counts.draft})</button>` : ""}
          </div>
          <input type="search" id="q" placeholder="Search company or role" value="${esc(appSearch)}" style="max-width:260px">
        </div>
        ${shown.length ? `
        <div class="table-wrap"><table>
          <thead><tr><th>Company</th><th>Role</th><th>Location</th><th>Applied</th><th>Status</th><th>ATS</th></tr></thead>
          <tbody>${shown.map((r) => `
            <tr data-id="${r.id}">
              <td><strong>${esc(r.company || "…")}</strong></td>
              <td>${esc(r.role)}</td>
              <td class="muted">${esc(r.location)}</td>
              <td class="muted">${fmtDate(r.applied_at || r.created_at)}</td>
              <td>${r.job_state === "running" ? `<span class="pill">working…</span>` : r.job_state === "error" ? `<span class="pill rejected">error</span>` : statusSelect(r.status, `data-status="${r.id}"`)}</td>
              <td>${r.ats_score != null ? r.ats_score + "%" : "—"}</td>
            </tr>`).join("")}
          </tbody></table></div>`
        : `<div class="empty">${q ? "Nothing matches." : appFilter === "all" && counts.draft ? `No saved applications yet. Open a draft and click <strong>Save as applied</strong> once you've sent it.` : rows.length ? "Nothing here yet." : `No applications yet. <a href="#new">Tailor your first one.</a>`}</div>`}
      </div>`;
    $view.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => { appFilter = b.dataset.f; draw(); }));
    const qEl = document.getElementById("q");
    qEl.oninput = () => { appSearch = qEl.value; draw(); const n = document.getElementById("q"); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };
    $view.querySelectorAll("tbody tr").forEach((tr) => (tr.onclick = (e) => { if (e.target.tagName !== "SELECT") location.hash = `app/${tr.dataset.id}`; }));
    $view.querySelectorAll("[data-status]").forEach((sel) => (sel.onchange = async () => {
      const r = rows.find((x) => x.id === +sel.dataset.status);
      const updated = await api(`/api/applications/${r.id}`, { method: "PATCH", json: { status: sel.value } });
      Object.assign(r, { status: updated.status, applied_at: updated.applied_at });
      STATUSES.forEach((s) => (counts[s] = rows.filter((x) => x.status === s).length));
      toast("Status updated");
      draw();
    }));
  };
  draw();
}

// ---- Application detail -------------------------------------------------------

let texTab = "resume";

async function renderApp(id) {
  const a = await api(`/api/applications/${id}`);
  if (a.job_state === "running") {
    $view.innerHTML = `
      <h1>${esc(a.company || "New application")}</h1>
      <div class="card row"><div class="spinner"></div><div><strong>Claude is working on it</strong><div class="muted small" id="msg">${esc(a.job_message)}</div></div></div>
      <details class="card"><summary>Job description</summary><div class="jd">${esc(a.job_description)}</div></details>`;
    pollTimer = setInterval(async () => {
      const x = await api(`/api/applications/${id}`).catch(() => null);
      if (!x) return;
      if (x.job_state !== "running") return route();
      const m = document.getElementById("msg");
      if (m) m.textContent = x.job_message;
    }, 1500);
    return;
  }

  const r = a.ats || {};
  const pdf = (w) => `/api/applications/${id}/pdf/${w}?v=${a.pdf_version}`;
  const scoreClass = (n) => (n >= 90 ? "good" : n >= 70 ? "mid" : "bad");

  $view.innerHTML = `
    <div class="row spread" style="margin-bottom:16px; align-items:flex-start">
      <div>
        <h1>${esc(a.company || "Untitled")}${a.role ? ` <span class="muted" style="font-weight:500">· ${esc(a.role)}</span>` : ""}</h1>
        <div class="muted small">${a.location ? esc(a.location) + " · " : ""}${a.applied_at ? "Applied " + fmtDate(a.applied_at) : "Created " + fmtDate(a.created_at)}</div>
      </div>
      <div class="row">
        ${a.status === "draft" ? `<button class="primary" id="markApplied">Save as applied</button>` : ""}
        <label class="row small" style="gap:6px">Status ${statusSelect(a.status, 'id="status"')}</label>
        <button class="danger" id="del">Delete</button>
      </div>
    </div>

    ${a.job_state === "error" ? `<div class="banner error">${esc(a.job_message)}</div><div style="margin:-6px 0 16px"><button id="retry">Try again</button></div>` : ""}

    ${a.has_pdfs ? `
    <div class="card">
      <div class="row spread" style="align-items:flex-start">
        <div class="stats">
          <div><div class="score ${scoreClass(r.score_supported)}">${r.score_supported}%</div><div class="muted small">of keywords you have<br>are in the resume</div></div>
          <div><div class="score ${scoreClass(r.score_required)}">${r.score_required}%</div><div class="muted small">of required keywords<br>matched</div></div>
          <div><div class="score">${r.score_all}%</div><div class="muted small">of all posting<br>keywords matched</div></div>
          <div><div class="score ${r.resume_pages > r.resume_page_limit ? "bad" : ""}">${r.resume_pages}<span class="muted" style="font-size:18px">/${r.resume_page_limit}</span></div><div class="muted small">resume pages</div></div>
        </div>
      </div>
      ${(r.warnings || []).length ? `<div class="banner" style="margin:14px 0 0">${r.warnings.map(esc).join("<br>")}</div>` : ""}
      <div class="chips" style="margin-top:14px">${(r.keywords || []).map((k) => {
        const cls = k.found ? "found" : !k.in_background ? "gap" : k.found_variant ? "variant" : "missing";
        const tip = `${k.importance} · ${k.category.replace("_", " ")}${k.found_variant ? ` · only found as "${k.found_variant}"` : ""}\n${k.evidence}`;
        return `<span class="chip ${cls}" title="${esc(tip)}">${esc(k.term)}${k.importance === "required" ? " *" : ""}</span>`;
      }).join("")}</div>
      <div class="legend">
        <span><i style="background:var(--good)"></i>In resume</span>
        <span><i style="background:var(--warn)"></i>Only a variant found</span>
        <span><i style="background:var(--bad)"></i>You have it, but missing</span>
        <span><i style="border:1px solid var(--muted)"></i>Not in your background (left out)</span>
        <span>* required · hover a keyword for details</span>
      </div>
    </div>

    <div class="grid2">
      <div class="card">
        <div class="row spread" style="margin-bottom:10px"><h2 style="margin:0">Resume</h2><a class="btn" href="${pdf("resume")}&download=true">Download PDF</a></div>
        <iframe class="pdf" src="${pdf("resume")}"></iframe>
      </div>
      <div class="card">
        <div class="row spread" style="margin-bottom:10px"><h2 style="margin:0">Cover letter</h2><a class="btn" href="${pdf("cover_letter")}&download=true">Download PDF</a></div>
        <iframe class="pdf" src="${pdf("cover_letter")}"></iframe>
      </div>
    </div>

    <div class="grid2">
      <div class="card">
        <h2>Ask Claude for changes</h2>
        <textarea id="rev" placeholder="e.g. Lead with the robotics project. Make the cover letter warmer and mention I'm relocating to Austin."></textarea>
        <div class="row" style="margin-top:10px">
          <select id="revTarget"><option value="both">Both documents</option><option value="resume">Resume only</option><option value="cover_letter">Cover letter only</option></select>
          <button class="primary" id="revise">Revise</button>
        </div>
      </div>
      <div class="card">
        <h2>What Claude tailored</h2>
        <div class="changes">${esc(a.changes) || '<span class="muted">—</span>'}</div>
      </div>
    </div>

    <details class="card">
      <summary>Edit the LaTeX yourself</summary>
      <div class="tabs"><button data-t="resume">Resume</button><button data-t="cover_letter">Cover letter</button></div>
      <textarea class="code" id="tex" spellcheck="false"></textarea>
      <div class="row" style="margin-top:10px"><button class="primary" id="saveTex">Save & recompile</button><span class="muted small">Compiles as-is and re-runs the ATS check. Claude doesn't touch it.</span></div>
    </details>` : ""}

    <div class="grid2">
      <div class="card">
        <h2>Job description</h2>
        <div class="jd">${esc(a.job_description)}</div>
      </div>
      <div class="card">
        <h2>Notes</h2>
        <textarea id="notes" style="min-height:200px" placeholder="Recruiter contact, interview dates, anything to remember…">${esc(a.notes)}</textarea>
        <div class="muted small" style="margin-top:6px">Saves automatically.</div>
      </div>
    </div>`;

  const patch = (json) => api(`/api/applications/${id}`, { method: "PATCH", json });

  document.getElementById("status").onchange = async (e) => { await patch({ status: e.target.value }); toast("Status updated"); route(); };
  const mark = document.getElementById("markApplied");
  if (mark) mark.onclick = async () => { await patch({ status: "applied" }); toast("Saved to your applications"); route(); };
  document.getElementById("del").onclick = async () => {
    if (!confirm(`Delete ${a.company || "this application"}? This removes the saved job description and PDFs.`)) return;
    await api(`/api/applications/${id}`, { method: "DELETE" });
    location.hash = "apps";
  };
  const retry = document.getElementById("retry");
  if (retry) retry.onclick = async () => { await api(`/api/applications/${id}/retry`, { method: "POST" }); route(); };

  const notes = document.getElementById("notes");
  notes.onblur = async () => { if (notes.value !== a.notes) { await patch({ notes: notes.value }); a.notes = notes.value; toast("Notes saved"); } };

  if (!a.has_pdfs) return;

  document.getElementById("revise").onclick = async (e) => {
    const instructions = document.getElementById("rev").value;
    e.target.disabled = true;
    try {
      await api(`/api/applications/${id}/revise`, { method: "POST", json: { instructions, target: document.getElementById("revTarget").value } });
      route();
    } catch (err) { toast(err.message); e.target.disabled = false; }
  };

  const tex = document.getElementById("tex");
  const texSrc = { resume: a.resume_tex, cover_letter: a.cover_letter_tex };
  const showTex = () => {
    tex.value = texSrc[texTab];
    $view.querySelectorAll("[data-t]").forEach((b) => b.classList.toggle("on", b.dataset.t === texTab));
  };
  $view.querySelectorAll("[data-t]").forEach((b) => (b.onclick = () => { texSrc[texTab] = tex.value; texTab = b.dataset.t; showTex(); }));
  showTex();
  document.getElementById("saveTex").onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Compiling…";
    try {
      await api(`/api/applications/${id}/tex`, { method: "PUT", json: { which: texTab, tex: tex.value } });
      toast("Recompiled");
      route();
    } catch (err) {
      alert(err.message);
      e.target.disabled = false;
      e.target.textContent = "Save & recompile";
    }
  };
}

// ---- Profile ------------------------------------------------------------------

async function renderProfile() {
  const p = await api("/api/profile");
  $view.innerHTML = `
    <h1>Profile</h1>
    <p class="muted">Set this up once. Claude uses it for every application.</p>
    ${p.api_key_set ? `<div class="banner ok">Anthropic API key found · model <code>${esc(p.model)}</code></div>`
      : `<div class="banner">No Anthropic API key yet. Add <code>ANTHROPIC_API_KEY=...</code> to the <code>.env</code> file in the app folder, then restart the app.</div>`}
    <div id="saveMsg"></div>

    <div class="card">
      <h2>1 · Your info</h2>
      <p class="muted small" style="margin-top:0">Dump everything here: every job, internship, research position, project, leadership role, class, skill, award, link and your contact details. Messy is fine, and longer is better. For each job, Claude picks the most relevant parts and rewrites them into your template.</p>
      <label class="field" for="name">Your name <span class="muted">(used in downloaded file names, e.g. Jane_Doe_Resume_Google.pdf)</span></label>
      <input type="text" id="name" value="${esc(p.name)}" placeholder="Jane Doe">
      <label class="field" for="master_cv">Info dump</label>
      <div class="row" style="margin-bottom:6px"><label class="btn small">Add from files (PDF, Word, .tex, .txt)<input type="file" id="cvFile" accept=".pdf,.docx,.tex,.txt,.md" multiple hidden></label><span class="muted small">Appends to what's already here: add your CV, old resumes, LinkedIn export…</span></div>
      <textarea id="master_cv" style="min-height:320px" placeholder="Contact: jane@email.com · (555) 555-5555 · linkedin.com/in/jane · github.com/jane

EXPERIENCE
Software Engineering Intern, Acme Corp, Jun–Aug 2025
- built … using Python, FastAPI …
- …

PROJECTS
…">${esc(p.master_cv)}</textarea>
    </div>

    <div class="grid2">
      <div class="card">
        <h2>2 · Resume template (LaTeX)</h2>
        <p class="muted small" style="margin-top:0">Its design, macros and section style are kept exactly. Its content is rebuilt from your info for each job.</p>
        <div style="margin:8px 0">
          <label class="row small" style="gap:8px"><input type="radio" name="tmode" value="real" ${p.template_has_my_info ? "checked" : ""}> It's my current resume (its content is my real info too)</label>
          <label class="row small" style="gap:8px"><input type="radio" name="tmode" value="sample" ${p.template_has_my_info ? "" : "checked"}> It's a blank/sample template (only use its design)</label>
        </div>
        <label class="row small" style="gap:8px; margin-bottom:8px">Max resume pages
          <select id="pageLimit">
            <option value="0" ${!p.resume_page_limit ? "selected" : ""}>Same as template${p.resume_template ? ` (${p.compiled_resume_pages})` : ""}</option>
            <option value="1" ${p.resume_page_limit === 1 ? "selected" : ""}>1</option>
            <option value="2" ${p.resume_page_limit === 2 ? "selected" : ""}>2</option>
          </select>
        </label>
        <div class="row" style="margin-bottom:6px"><label class="btn small">Load .tex file<input type="file" data-into="resume_template" accept=".tex" hidden></label></div>
        <textarea class="code" id="resume_template" spellcheck="false" placeholder="\\documentclass{...}">${esc(p.resume_template)}</textarea>
      </div>
      <div class="card">
        <h2>3 · Cover letter template (LaTeX)</h2>
        <p class="muted small" style="margin-top:0">The layout. Kept as-is; the text is written fresh for each job.</p>
        <div class="row" style="margin-bottom:6px"><label class="btn small">Load .tex file<input type="file" data-into="cover_template" accept=".tex" hidden></label></div>
        <textarea class="code" id="cover_template" spellcheck="false" placeholder="\\documentclass{...}">${esc(p.cover_template)}</textarea>
      </div>
    </div>

    <div class="card">
      <h2>4 · Reference cover letter <span class="muted" style="font-weight:400">(recommended)</span></h2>
      <p class="muted small" style="margin-top:0">A cover letter you wrote that you like. Claude matches its voice, tone, length, paragraph structure and how it opens and closes, so every new letter sounds like you. Its company-specific parts aren't reused.</p>
      <div class="row" style="margin-bottom:6px"><label class="btn small">Load from file (PDF, Word, .tex, .txt)<input type="file" id="refFile" accept=".pdf,.docx,.tex,.txt,.md" hidden></label></div>
      <textarea id="cover_reference" style="min-height:260px" placeholder="Paste a cover letter you've written before…">${esc(p.cover_reference)}</textarea>
    </div>

    <div class="card">
      <label class="field" style="margin-top:0">Extra template files <span class="muted">(only if your templates use a custom .cls/.sty, fonts or images)</span></label>
      <div>${p.assets.map((f) => `<span class="asset">${esc(f)}<button data-del="${esc(f)}" title="Remove">✕</button></span>`).join("") || '<span class="muted small">None</span>'}</div>
      <label class="btn small" style="margin-top:8px">Upload files<input type="file" id="assets" multiple hidden></label>

      <label class="field" for="notes">Notes for Claude <span class="muted">(optional preferences)</span></label>
      <textarea id="notes" placeholder="e.g. I'm targeting ML engineering roles. Always mention I'm bilingual (English/Spanish). Keep the Education section first.">${esc(p.notes)}</textarea>
    </div>

    <div class="row"><button class="primary" id="save">Save profile</button><span class="muted small" id="saveHint"></span></div>`;

  document.getElementById("cvFile").onchange = async (e) => {
    const box = document.getElementById("master_cv");
    for (const f of e.target.files) {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch("/api/profile/extract-text", { method: "POST", body: fd }).then((r) => r.json());
      box.value = (box.value.trim() ? box.value.trim() + "\n\n" : "") + `===== From ${f.name} =====\n` + res.text.trim();
    }
    e.target.value = "";
    toast("Added. Check it over, then save.");
  };
  document.getElementById("refFile").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    const res = await fetch("/api/profile/extract-text", { method: "POST", body: fd }).then((r) => r.json());
    document.getElementById("cover_reference").value = res.text.trim();
    e.target.value = "";
    toast("Reference letter loaded. Check it over, then save.");
  };
  $view.querySelectorAll("[data-into]").forEach((inp) => (inp.onchange = async () => {
    if (inp.files[0]) document.getElementById(inp.dataset.into).value = await readFileText(inp.files[0]);
  }));
  document.getElementById("assets").onchange = async (e) => {
    const fd = new FormData();
    [...e.target.files].forEach((f) => fd.append("files", f));
    await fetch("/api/profile/assets", { method: "POST", body: fd });
    route();
  };
  $view.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    await api(`/api/profile/assets/${encodeURIComponent(b.dataset.del)}`, { method: "DELETE" });
    route();
  }));

  document.getElementById("save").onclick = async (e) => {
    const body = Object.fromEntries(["name", "master_cv", "resume_template", "cover_template", "cover_reference", "notes"].map((k) => [k, document.getElementById(k).value]));
    body.template_has_my_info = document.querySelector('input[name="tmode"]:checked').value === "real";
    body.resume_page_limit = +document.getElementById("pageLimit").value;
    const msg = document.getElementById("saveMsg");
    e.target.disabled = true;
    document.getElementById("saveHint").textContent = "Checking your templates compile… (the very first time can take a minute or two while LaTeX packages download)";
    try {
      const res = await api("/api/profile", { method: "POST", json: body });
      const c = res.checks;
      const bits = [];
      if (c.resume_pages) bits.push(`resume compiles (${c.resume_pages} page${c.resume_pages > 1 ? "s" : ""})`);
      if (c.cover_pages) bits.push(`cover letter compiles (${c.cover_pages} page${c.cover_pages > 1 ? "s" : ""})`);
      msg.innerHTML = `<div class="banner ok">Saved${bits.length ? " · " + bits.join(" · ") : ""}. <a href="#new">Start an application →</a></div>`;
    } catch (err) {
      msg.innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
    e.target.disabled = false;
    document.getElementById("saveHint").textContent = "";
  };
}
