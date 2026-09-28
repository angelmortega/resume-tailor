const $view = document.getElementById("view");

const STATUS = {
  draft: { label: "Not applied yet", color: "var(--ink-faint)" },
  applied: { label: "Applied", color: "var(--sky-600)" },
  interview: { label: "Interview", color: "#c98a00" },
  offer: { label: "Offer", color: "var(--good)" },
  rejected: { label: "Rejected", color: "var(--bad)" },
};
const STATUS_KEYS = Object.keys(STATUS);

let pollTimer = null;
let tickTimer = null;
let leaveGuard = null; // returns true if it's OK to leave the current page
const pendingDeletes = new Map(); // id -> timeout; deleted only after the undo window closes

// ---- Helpers ---------------------------------------------------------------------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    init.headers = { "Content-Type": "application/json" };
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error("Can't reach the app. Start it again with: uv run main.py");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Something went wrong (error ${res.status}).`);
  return data;
}

async function upload(path, files, field) {
  const fd = new FormData();
  for (const f of files) fd.append(field, f);
  const res = await fetch(path, { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || "Upload failed.");
  return data;
}

/** Short message at the bottom of the screen, optionally with one action (e.g. Undo). */
function toast(msg, action) {
  const host = $("#toast");
  host.innerHTML = "";
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.onclick = () => { el.remove(); action.onClick(); };
    el.append(b);
  }
  host.append(el);
  setTimeout(() => el.remove(), action ? 7000 : 3500);
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? iso + "T00:00" : iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function scoreClass(n) {
  return n >= 90 ? "good" : n >= 70 ? "warn" : "bad";
}

function statusSelect(current, attrs = "") {
  return `<select ${attrs}>${STATUS_KEYS.map((s) => `<option value="${s}" ${s === current ? "selected" : ""}>${STATUS[s].label}</option>`).join("")}</select>`;
}

function readFileText(file) {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = fail;
    r.readAsText(file);
  });
}

function notice(kind, html) {
  const icon = { warn: "!", bad: "!", good: "✓", info: "i" }[kind];
  return `<div class="notice notice-${kind}" ${kind === "bad" ? 'role="alert"' : ""}><span class="ico" aria-hidden="true"><span>${icon}</span></span><div>${html}</div></div>`;
}

function hero(eyebrow, title, sub, actions = "") {
  return `<header class="hero">
    <span class="eyebrow">${eyebrow}</span>
    <h1>${title}</h1>
    ${sub ? `<p>${sub}</p>` : ""}
    ${actions ? `<div class="actions">${actions}</div>` : ""}
  </header>`;
}

// ---- Router --------------------------------------------------------------------------

let currentHash = location.hash;
let skipGuard = false;

async function route() {
  if (skipGuard) {
    // This hashchange is us putting the URL back after "stay on page"; keep the page (and its edits) as is.
    skipGuard = false;
    return;
  }
  if (location.hash !== currentHash && leaveGuard && !leaveGuard()) {
    skipGuard = true;
    location.hash = currentHash;
    return;
  }
  currentHash = location.hash;
  leaveGuard = null;
  clearInterval(pollTimer);
  clearInterval(tickTimer);
  document.body.classList.remove("has-savebar");

  const [name, id] = (location.hash.slice(1) || "new").split("/");
  const tab = name === "app" ? "apps" : name;
  $$(".topbar a[data-tab]").forEach((a) => (a.dataset.tab === tab ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  try {
    if (name === "apps") await renderBoard();
    else if (name === "app") await renderApp(+id);
    else if (name === "profile") await renderProfile();
    else await renderNew();
  } catch (e) {
    $view.innerHTML = `<div class="narrow">${notice("bad", esc(e.message))}</div>`;
  }
}

function pageShown(title) {
  document.title = `${title} · Resume Tailor`;
  window.scrollTo(0, 0);
  $view.focus({ preventScroll: true });
}

window.addEventListener("hashchange", route);
window.addEventListener("beforeunload", (e) => {
  if (leaveGuard && !leaveGuard(true)) e.preventDefault();
});
route();

// ---- New application ---------------------------------------------------------------

async function renderNew() {
  const p = await api("/api/profile");
  const missing = [];
  if (!p.master_cv.trim() && !p.template_has_my_info) missing.push("your info");
  if (!p.resume_template.trim()) missing.push("a resume template");
  if (!p.cover_template.trim()) missing.push("a cover letter template");

  if (missing.length) {
    $view.innerHTML = hero("Welcome", "Resume Tailor",
      `First, add ${missing.join(", ").replace(/, ([^,]*)$/, " and $1")}. You only do this once.`,
      `<a class="btn btn-primary btn-lg" href="#profile">Set up my profile</a>`);
    return pageShown("New application");
  }

  $view.innerHTML = `
    ${hero("New application", "Tailor for a new job", "Paste the posting. Get a matching resume and cover letter.")}
    <div class="narrow">
      ${p.api_key_set ? "" : `<div style="margin-bottom:var(--s5)">${notice("warn", `Claude isn't connected yet. <a href="#profile">Add your API key</a>.`)}</div>`}
      <form id="newForm" novalidate class="sky-panel">
        <div class="panel-inner">
          <label class="field" for="jd">Job posting</label>
          <p class="hint" id="jdHint">The full text works best.</p>
          <textarea id="jd" class="jd-input" aria-describedby="jdHint jdErr" placeholder="Paste the job posting here"></textarea>
          <p id="jdErr" class="small" style="color:var(--bad); margin-top:var(--s2)" role="alert"></p>
          <div class="row" style="margin-top:var(--s4); justify-content:space-between">
            <span class="char-count" id="count"></span>
            <button type="submit" class="btn btn-primary btn-lg">Tailor my documents</button>
          </div>
        </div>
      </form>
      <p class="muted small" style="text-align:center; margin-top:var(--s4)">Takes 1 to 3 minutes. You can leave the page while it works.</p>
    </div>`;

  const jd = $("#jd");
  const count = () => { const w = jd.value.trim() ? jd.value.trim().split(/\s+/).length : 0; $("#count").textContent = w ? `${w.toLocaleString()} words` : ""; };
  try { jd.value = localStorage.getItem("jd-draft") || ""; } catch {}
  count();
  jd.oninput = () => { count(); $("#jdErr").textContent = ""; try { localStorage.setItem("jd-draft", jd.value); } catch {} };

  $("#newForm").onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.submitter || $("#newForm button");
    if (jd.value.trim().length < 50) {
      $("#jdErr").textContent = "That looks too short for a job posting. Paste the whole thing.";
      jd.focus();
      return;
    }
    btn.disabled = true;
    btn.textContent = "Starting…";
    try {
      const { id } = await api("/api/applications", { method: "POST", json: { job_description: jd.value } });
      try { localStorage.removeItem("jd-draft"); } catch {}
      location.hash = `app/${id}`;
    } catch (err) {
      $("#jdErr").textContent = err.message;
      btn.disabled = false;
      btn.textContent = "Tailor my documents";
    }
  };
  pageShown("New application");
}

// ---- Applications board -------------------------------------------------------------

let boardSearch = "";

async function renderBoard() {
  const rows = await api("/api/applications");

  const draw = () => {
    const q = boardSearch.toLowerCase();
    const visible = rows.filter((r) => !pendingDeletes.has(r.id));
    const shown = visible.filter((r) => !q || `${r.company} ${r.role} ${r.location}`.toLowerCase().includes(q));

    if (!visible.length) {
      $view.innerHTML = hero("Applications", "Nothing here yet", "Every job you tailor for lands here, so you can track it.",
        `<a class="btn btn-primary btn-lg" href="#new">Tailor for a job</a>`);
      return;
    }

    const card = (r) => {
      const state = r.job_state === "running" ? `<span class="badge">Working…</span>`
        : r.job_state === "error" ? `<span class="badge bad">! Needs a look</span>`
        : r.ats_score != null ? `<span class="badge ${scoreClass(r.ats_score)}"><span class="visually-hidden">ATS keyword match </span>ATS ${r.ats_score}%</span>` : "";
      return `
        <div class="app-card" draggable="true" data-id="${r.id}">
          <h3 class="company"><a href="#app/${r.id}">${esc(r.company || "Untitled")}</a></h3>
          <div class="role">${esc(r.role)}</div>
          <div class="meta"><span>${fmtDate(r.applied_at || r.created_at)}</span>${state}</div>
          <div class="move">
            <label class="visually-hidden" for="mv${r.id}">Status for ${esc(r.company)}</label>
            ${statusSelect(r.status, `id="mv${r.id}" data-move="${r.id}"`)}
          </div>
        </div>`;
    };

    $view.innerHTML = `
      ${hero("Applications", "Your applications", `${visible.length} so far. Drag a card to update it.`)}
      <div class="toolbar">
        <div class="row">
          <label class="visually-hidden" for="q">Search applications</label>
          <input type="search" id="q" placeholder="Search company or role" value="${esc(boardSearch)}">
          ${q ? `<span class="muted small" aria-live="polite">${shown.length} match${shown.length === 1 ? "" : "es"}</span>` : ""}
        </div>
      </div>
      <div class="board">
        ${STATUS_KEYS.map((s) => {
          const items = shown.filter((r) => r.status === s);
          return `
            <section class="col" data-col="${s}" aria-label="${STATUS[s].label}">
              <h2 class="col-head"><span class="status-dot" style="background:${STATUS[s].color}" aria-hidden="true"></span>${STATUS[s].label}<span class="count"><span class="visually-hidden">, </span>${items.length}</span></h2>
              ${items.map(card).join("") || `<p class="col-empty">${s === "draft" ? "Tailored, not sent yet" : "Nothing here"}</p>`}
            </section>`;
        }).join("")}
      </div>`;

    const qEl = $("#q");
    qEl.oninput = () => { boardSearch = qEl.value; draw(); const n = $("#q"); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };

    $$(".app-card").forEach((c) => {
      c.onclick = (e) => { if (!e.target.closest("select, a")) location.hash = `app/${c.dataset.id}`; };
      c.ondragstart = (e) => { e.dataTransfer.setData("text/plain", c.dataset.id); c.classList.add("dragging"); };
      c.ondragend = () => c.classList.remove("dragging");
    });
    $$("[data-col]").forEach((col) => {
      col.ondragover = (e) => { e.preventDefault(); col.classList.add("drop"); };
      col.ondragleave = (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove("drop"); };
      col.ondrop = (e) => { e.preventDefault(); col.classList.remove("drop"); move(+e.dataTransfer.getData("text/plain"), col.dataset.col); };
    });
    $$("[data-move]").forEach((sel) => (sel.onchange = () => move(+sel.dataset.move, sel.value)));
  };

  async function move(id, status, { undoable = true } = {}) {
    const r = rows.find((x) => x.id === id);
    if (!r || r.status === status) return;
    const prev = r.status;
    try {
      const updated = await api(`/api/applications/${id}`, { method: "PATCH", json: { status } });
      Object.assign(r, { status: updated.status, applied_at: updated.applied_at });
      draw();
      if (undoable) toast(`${r.company || "Application"} moved to ${STATUS[status].label}`, { label: "Undo", onClick: () => move(id, prev, { undoable: false }) });
    } catch (err) {
      toast(err.message);
      draw();
    }
  }

  draw();
  pageShown("Applications");
}

// ---- Application page ---------------------------------------------------------------

const STEPS = ["Claude writes your documents", "Building the PDFs", "Checking keywords and length"];

function stepFor(msg) {
  const m = (msg || "").toLowerCase();
  if (m.includes("ats") || m.includes("polish")) return 2;
  if (m.includes("compil") || m.includes("fix")) return 1;
  return 0;
}

let texTab = "resume";

async function renderApp(id) {
  const a = await api(`/api/applications/${id}`);
  const title = a.company ? `${a.company}${a.role ? " · " + a.role : ""}` : "New application";

  if (a.job_state === "running") {
    const started = Date.now();
    $view.innerHTML = `
      <div class="narrow">
        <a class="back" href="#apps">← Applications</a>
        ${hero("Working on it", a.company ? esc(a.company) : "Tailoring…", "About 1 to 3 minutes. You can leave this page.")}
        <div class="sky-panel">
          <div class="panel-inner">
            <ol class="steps" id="steps" aria-live="polite" style="margin-top:0"></ol>
            <p class="progress-detail"><span id="detail"></span> · <span id="elapsed">0:00</span></p>
          </div>
        </div>
      </div>`;
    const paint = (msg) => {
      const cur = stepFor(msg);
      $("#steps").innerHTML = STEPS.map((label, i) => `
        <li class="${i < cur ? "done" : i === cur ? "now" : ""}">
          <span class="dot" aria-hidden="true">${i < cur ? "✓" : ""}</span>
          <span>${label}<span class="visually-hidden">${i < cur ? " (done)" : i === cur ? " (in progress)" : ""}</span></span>
        </li>`).join("");
      $("#detail").textContent = msg || "Starting…";
    };
    paint(a.job_message);
    tickTimer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      const el = $("#elapsed");
      if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 1000);
    pollTimer = setInterval(async () => {
      const x = await api(`/api/applications/${id}`).catch(() => null);
      if (!x) return;
      if (x.job_state !== "running") {
        route();
        toast(x.job_state === "error" ? "Something went wrong. See the details." : "Done. Your documents are ready.");
        return;
      }
      if ($("#detail") && $("#detail").textContent !== x.job_message) paint(x.job_message);
    }, 1500);
    return pageShown(title);
  }

  const r = a.ats || {};
  const kws = r.keywords || [];
  const matched = kws.filter((k) => k.found);
  const missing = kws.filter((k) => !k.found && k.in_background);
  const gaps = kws.filter((k) => !k.found && !k.in_background);
  const pdf = (w) => `/api/applications/${id}/pdf/${w}?v=${a.pdf_version}`;
  const isDraft = a.status === "draft";
  const date = a.applied_at ? `Applied ${fmtDate(a.applied_at)}` : `Created ${fmtDate(a.created_at)}`;
  // Plain-language length checks (the server's own warnings are written for Claude).
  const lengthWarnings = [];
  if (r.resume_pages > r.resume_page_limit) lengthWarnings.push(`Your resume is ${r.resume_pages} pages. The limit is ${r.resume_page_limit}. Ask Claude below to shorten it.`);
  if (r.cover_pages > r.cover_page_limit) lengthWarnings.push(`The cover letter runs to ${r.cover_pages} pages. Ask Claude below to shorten it.`);

  $view.innerHTML = `
    <a class="back" href="#apps">← Applications</a>
    <div class="app-head">
      <div>
        <span class="eyebrow">${esc(STATUS[a.status].label)}</span>
        <h1>${esc(a.company || "Untitled")}</h1>
        <p class="meta">${[esc(a.role), esc(a.location), date].filter(Boolean).join(" · ")}</p>
      </div>
      <div class="app-actions">
        <div class="status-field"><label for="status">Status</label>${statusSelect(a.status, 'id="status"')}</div>
        ${isDraft && a.has_pdfs ? `<button class="btn btn-primary" id="markApplied">Mark as applied</button>` : ""}
      </div>
    </div>

    ${a.job_state === "error" ? `<div style="margin-top:var(--s6)">${notice("bad", `<strong>This didn't finish.</strong><pre>${esc(a.job_message)}</pre><div class="row" style="margin-top:var(--s3)"><button class="btn" id="retry">Try again</button></div>`)}</div>` : ""}

    ${a.has_pdfs ? `
    <section style="margin-top:var(--s7)" aria-labelledby="atsH">
      <h2 id="atsH" class="visually-hidden">ATS check</h2>
      <div class="sky-panel ats-panel">
        <div class="panel-side">
          <span class="eyebrow">ATS match</span>
          <div class="score-big">${r.score_supported}%</div>
          <p class="score-label">of the keywords you have are in your resume.</p>
          <ul class="facts">
            <li><span>Required keywords</span><b>${r.score_required}%</b></li>
            <li><span>All posting keywords</span><b>${r.score_all}%</b></li>
            <li><span>Resume length</span><b>${r.resume_pages} of ${r.resume_page_limit} page${r.resume_page_limit > 1 ? "s" : ""}</b></li>
          </ul>
        </div>
        <div class="panel-inner">
          ${lengthWarnings.length ? `<div style="margin-bottom:var(--s5)">${lengthWarnings.map((w) => notice("warn", w)).join("")}</div>` : ""}
          <div class="kw-group">
            <h3><span aria-hidden="true">✓</span> In your resume · ${matched.length}</h3>
            <ul class="chips">${matched.map((k) => `<li class="chip">${esc(k.term)}${k.importance === "required" ? '<span class="req">required</span>' : ""}</li>`).join("") || '<li class="muted small">None yet</li>'}</ul>
          </div>
          ${missing.length ? `
          <div class="kw-group kw-missing">
            <h3><span aria-hidden="true">!</span> You have these, but they're missing · ${missing.length}</h3>
            <ul class="kw-list">${missing.map((k) => `<li><strong>${esc(k.term)}</strong>${k.importance === "required" ? " · required" : ""}${k.found_variant ? ` · only “${esc(k.found_variant)}” found` : ""}<span class="why">${esc(k.evidence)}</span></li>`).join("")}</ul>
            <button class="btn btn-ghost" id="addMissing" style="margin-top:var(--s4)">Ask Claude to add ${missing.length === 1 ? "it" : "them"}</button>
          </div>` : ""}
          ${gaps.length ? `
          <details class="disclosure kw-group">
            <summary>Not in your background · ${gaps.length}</summary>
            <p class="muted small" style="margin-bottom:var(--s3)">Left out on purpose. Claude never adds skills you don't have.</p>
            <ul class="kw-list">${gaps.map((k) => `<li><strong>${esc(k.term)}</strong>${k.importance === "required" ? " · required" : ""}<span class="why">${esc(k.evidence)}</span></li>`).join("")}</ul>
          </details>` : ""}
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="docsH">
      <div class="section-head"><div><span class="eyebrow">Documents</span><h2 id="docsH">Ready to send</h2></div></div>
      <div class="grid2">
        ${[["resume", "Resume"], ["cover_letter", "Cover letter"]].map(([w, label]) => `
        <div class="card doc-card">
          <div class="doc-head">
            <h3>${label}</h3>
            <div class="row" style="gap:var(--s1)">
              <a class="btn btn-quiet" href="${pdf(w)}" target="_blank" rel="noopener">Open<span class="visually-hidden"> ${label} in a new tab</span></a>
              <a class="btn btn-ghost" href="${pdf(w)}&download=true">Download<span class="visually-hidden"> ${label} PDF</span></a>
            </div>
          </div>
          <iframe class="pdf" src="${pdf(w)}" title="${label} preview"></iframe>
        </div>`).join("")}
      </div>
    </section>

    <section class="section" aria-labelledby="revH">
      <div class="grid2">
        <form id="revForm" novalidate class="card">
          <span class="eyebrow">Revise</span>
          <h2 id="revH" style="margin-bottom:var(--s4)">Ask Claude for changes</h2>
          <label class="visually-hidden" for="rev">What should change?</label>
          <textarea id="rev" aria-describedby="revErr" placeholder="e.g. Lead with the robotics project."></textarea>
          <p id="revErr" class="small" style="color:var(--bad)" role="alert"></p>
          <div class="row" style="margin-top:var(--s3); justify-content:space-between">
            <fieldset class="segmented" style="margin:0">
              <legend class="visually-hidden">Which document?</legend>
              <label><input type="radio" name="target" value="both" checked>Both</label>
              <label><input type="radio" name="target" value="resume">Resume</label>
              <label><input type="radio" name="target" value="cover_letter">Cover letter</label>
            </fieldset>
            <button type="submit" class="btn ${isDraft ? "btn-ghost" : "btn-primary"}">Revise</button>
          </div>
        </form>
        <div class="card">
          <span class="eyebrow">Last change</span>
          <h2 style="margin-bottom:var(--s4)">What Claude changed</h2>
          <div class="changes">${esc(a.changes) || "Nothing yet."}</div>
        </div>
      </div>
    </section>` : ""}

    <section class="section" aria-label="Job posting and notes">
      <div class="grid2">
        <div class="card">
          <span class="eyebrow">Saved posting</span>
          <h2 style="margin-bottom:var(--s4)">Job description</h2>
          <div class="jd">${esc(a.job_description)}</div>
        </div>
        <div class="card">
          <span class="eyebrow">Notes</span>
          <div class="section-head" style="margin-bottom:var(--s4)"><h2><label for="notes">Your notes</label></h2><span class="muted small" id="notesState" aria-live="polite">Saves automatically</span></div>
          <textarea id="notes" style="min-height:260px" placeholder="Recruiter, interview dates, questions to ask"></textarea>
        </div>
      </div>
    </section>

    ${a.has_pdfs ? `
    <section class="section">
      <details class="disclosure">
        <summary>Edit the LaTeX yourself</summary>
        <div class="card" style="margin-top:var(--s3)">
          <div class="segmented tabs" role="tablist" aria-label="Document">
            <label role="tab" data-t="resume"><input type="radio" name="texdoc" value="resume">Resume</label>
            <label role="tab" data-t="cover_letter"><input type="radio" name="texdoc" value="cover_letter">Cover letter</label>
          </div>
          <label class="visually-hidden" for="tex">LaTeX source</label>
          <textarea class="code" id="tex" spellcheck="false"></textarea>
          <div id="texErr"></div>
          <div class="row" style="margin-top:var(--s4)"><button class="btn btn-ghost" id="saveTex">Save and rebuild PDF</button><span class="muted small">Used as-is. Claude does not change it.</span></div>
        </div>
      </details>
    </section>` : ""}

    <hr>
    <div class="danger-zone">
      <div><h3>Delete this application</h3><p class="muted small">You can undo for a few seconds.</p></div>
      <button class="btn btn-danger" id="del">Delete</button>
    </div>`;

  $("#notes").value = a.notes || "";
  const patch = (json) => api(`/api/applications/${id}`, { method: "PATCH", json });

  $("#status").onchange = async (e) => {
    const prev = a.status;
    try {
      await patch({ status: e.target.value });
      toast(`Moved to ${STATUS[e.target.value].label}`, { label: "Undo", onClick: async () => { await patch({ status: prev }); route(); } });
      route();
    } catch (err) { toast(err.message); }
  };
  const mark = $("#markApplied");
  if (mark) mark.onclick = async () => {
    await patch({ status: "applied" });
    toast("Marked as applied", { label: "Undo", onClick: async () => { await patch({ status: "draft" }); route(); } });
    route();
  };

  $("#del").onclick = () => {
    const name = a.company || "Application";
    pendingDeletes.set(id, setTimeout(() => {
      pendingDeletes.delete(id);
      api(`/api/applications/${id}`, { method: "DELETE" }).catch((err) => toast(err.message));
    }, 7000));
    location.hash = "apps";
    toast(`${name} deleted`, { label: "Undo", onClick: () => { clearTimeout(pendingDeletes.get(id)); pendingDeletes.delete(id); route(); } });
  };

  const retry = $("#retry");
  if (retry) retry.onclick = async () => { retry.disabled = true; await api(`/api/applications/${id}/retry`, { method: "POST" }).catch((e) => toast(e.message)); route(); };

  // Notes save as you type (debounced), with visible status.
  const notes = $("#notes");
  let notesTimer;
  const saveNotes = async () => {
    if (notes.value === (a.notes || "")) return;
    $("#notesState").textContent = "Saving…";
    try { await patch({ notes: notes.value }); a.notes = notes.value; $("#notesState").textContent = "Saved"; }
    catch { $("#notesState").textContent = "Couldn't save. Is the app running?"; }
  };
  notes.oninput = () => { clearTimeout(notesTimer); $("#notesState").textContent = "Editing…"; notesTimer = setTimeout(saveNotes, 800); };
  notes.onblur = saveNotes;

  if (!a.has_pdfs) return pageShown(title);

  $("#revForm").onsubmit = async (e) => {
    e.preventDefault();
    const instructions = $("#rev").value.trim();
    if (!instructions) { $("#revErr").textContent = "Tell Claude what to change first."; $("#rev").focus(); return; }
    const btn = e.submitter || $("#revForm button[type=submit]");
    btn.disabled = true;
    try {
      await api(`/api/applications/${id}/revise`, { method: "POST", json: { instructions, target: $("input[name=target]:checked").value } });
      route();
    } catch (err) { $("#revErr").textContent = err.message; btn.disabled = false; }
  };
  $("#rev").oninput = () => ($("#revErr").textContent = "");
  const addMissing = $("#addMissing");
  if (addMissing) addMissing.onclick = () => {
    $("#rev").value = `Work these keywords into the resume using the posting's exact wording, only where my background supports them: ${missing.map((k) => k.term).join(", ")}.`;
    $("input[name=target][value=resume]").checked = true;
    $("#rev").scrollIntoView({ behavior: "smooth", block: "center" });
    $("#rev").focus({ preventScroll: true });
  };

  const tex = $("#tex");
  const texSrc = { resume: a.resume_tex, cover_letter: a.cover_letter_tex };
  const showTex = () => {
    tex.value = texSrc[texTab];
    $$("[data-t]").forEach((l) => { const on = l.dataset.t === texTab; l.setAttribute("aria-selected", String(on)); l.querySelector("input").checked = on; });
  };
  $$("[data-t] input").forEach((inp) => (inp.onchange = () => { texSrc[texTab] = tex.value; texTab = inp.value; showTex(); }));
  showTex();
  $("#saveTex").onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Rebuilding…";
    $("#texErr").innerHTML = "";
    try {
      await api(`/api/applications/${id}/tex`, { method: "PUT", json: { which: texTab, tex: tex.value } });
      toast("PDF rebuilt");
      route();
    } catch (err) {
      $("#texErr").innerHTML = `<div style="margin-top:var(--s3)">${notice("bad", `<strong>That didn't compile, so nothing was saved.</strong><pre>${esc(err.message)}</pre>`)}</div>`;
      btn.disabled = false;
      btn.textContent = "Save and rebuild PDF";
    }
  };
  pageShown(title);
}

// ---- Profile -------------------------------------------------------------------------

async function renderProfile() {
  const p = await api("/api/profile");
  const FIELDS = ["name", "master_cv", "resume_template", "cover_template", "cover_reference", "notes"];

  const checks = [
    ["Your info", !!p.master_cv.trim()],
    ["Resume template", !!p.resume_template.trim()],
    ["Cover letter template", !!p.cover_template.trim()],
    ["Reference letter", !!p.cover_reference.trim()],
  ];

  $view.innerHTML = `
    ${hero("Profile", "Your materials", "Set this up once. Claude uses it for every job.")}
    <ul class="checklist" aria-label="Setup progress" style="margin-top:calc(-1 * var(--s6))">
      ${checks.map(([label, ok]) => `<li class="check ${ok ? "ok" : ""}"><span aria-hidden="true">${ok ? "✓" : "○"}</span>${label}<span class="visually-hidden">${ok ? ": done" : ": not done"}</span></li>`).join("")}
    </ul>

    <div class="narrow" style="max-width:880px; margin-top:var(--s6)">
      ${p.api_key_set
        ? `<p class="muted small" style="text-align:center">✓ Connected to Claude · <code>${esc(p.model)}</code></p>`
        : notice("warn", `<strong>Connect Claude.</strong> Get an API key at <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a>. Put it in the <code>.env</code> file as <code>ANTHROPIC_API_KEY=...</code>, then restart the app.`)}
      <div id="saveResult" tabindex="-1" style="margin-top:var(--s4)"></div>

      <section class="section card" aria-labelledby="h1s" style="margin-top:var(--s6)">
        <span class="step-num">Step 1</span>
        <h2 id="h1s">Your info</h2>
        <p class="muted" style="margin:var(--s2) 0 var(--s5)">Everything about you. Messy is fine. Claude picks what fits each job.</p>
        <div class="field-group">
          <label class="field" for="name">Your name</label>
          <p class="hint" id="nameHint">For file names, like Jane_Doe_Resume_Google.pdf</p>
          <input type="text" id="name" autocomplete="name" aria-describedby="nameHint" value="${esc(p.name)}" style="max-width:420px">
        </div>
        <div class="field-group">
          <div class="row" style="justify-content:space-between; margin-bottom:var(--s2)">
            <label class="field" for="master_cv" style="margin:0">Info dump</label>
            <span class="btn btn-ghost file-btn">Add files<input type="file" id="cvFile" accept=".pdf,.docx,.tex,.txt,.md" multiple aria-label="Add info from files: PDF, Word, .tex or text"></span>
          </div>
          <p class="hint">Jobs, projects, research, skills, awards, links. Files are added to the end.</p>
          <textarea id="master_cv" style="min-height:320px" placeholder="Contact, experience, projects, skills…"></textarea>
        </div>
      </section>

      <section class="section card" aria-labelledby="h2s">
        <span class="step-num">Step 2</span>
        <h2 id="h2s">Resume template</h2>
        <p class="muted" style="margin:var(--s2) 0 var(--s5)">Your LaTeX resume. The design stays. The content is rebuilt for each job.</p>
        <fieldset style="border:0; padding:0; margin:0">
          <legend class="field" style="padding:0">What's in it?</legend>
          <label class="choice"><input type="radio" name="tmode" value="real" ${p.template_has_my_info ? "checked" : ""}><span><strong>My real resume</strong><span class="muted small">Its content counts as info too.</span></span></label>
          <label class="choice"><input type="radio" name="tmode" value="sample" ${p.template_has_my_info ? "" : "checked"}><span><strong>A blank or sample template</strong><span class="muted small">Only the design is used.</span></span></label>
        </fieldset>
        <div class="field-group">
          <label class="field" for="pageLimit">Maximum length</label>
          <select id="pageLimit">
            <option value="0" ${!p.resume_page_limit ? "selected" : ""}>Same as the template${p.resume_template ? ` (${p.compiled_resume_pages} page${p.compiled_resume_pages > 1 ? "s" : ""})` : ""}</option>
            <option value="1" ${p.resume_page_limit === 1 ? "selected" : ""}>1 page</option>
            <option value="2" ${p.resume_page_limit === 2 ? "selected" : ""}>2 pages</option>
          </select>
        </div>
        <div class="field-group">
          <div class="row" style="justify-content:space-between; margin-bottom:var(--s2)">
            <label class="field" for="resume_template" style="margin:0">LaTeX source</label>
            <span class="btn btn-ghost file-btn">Load .tex<input type="file" data-into="resume_template" accept=".tex" aria-label="Load resume .tex file"></span>
          </div>
          <textarea class="code" id="resume_template" spellcheck="false" placeholder="\\documentclass{…}"></textarea>
        </div>
      </section>

      <section class="section card" aria-labelledby="h3s">
        <span class="step-num">Step 3</span>
        <h2 id="h3s">Cover letter template</h2>
        <p class="muted" style="margin:var(--s2) 0 var(--s5)">Your LaTeX cover letter. The layout stays. The letter is new each time.</p>
        <div class="row" style="justify-content:space-between; margin-bottom:var(--s2)">
          <label class="field" for="cover_template" style="margin:0">LaTeX source</label>
          <span class="btn btn-ghost file-btn">Load .tex<input type="file" data-into="cover_template" accept=".tex" aria-label="Load cover letter .tex file"></span>
        </div>
        <textarea class="code" id="cover_template" spellcheck="false" placeholder="\\documentclass{…}"></textarea>
      </section>

      <section class="section card" aria-labelledby="h4s">
        <span class="step-num">Step 4 · Optional</span>
        <h2 id="h4s">Reference cover letter</h2>
        <p class="muted" style="margin:var(--s2) 0 var(--s5)">A letter you wrote and like. New letters match its voice and structure.</p>
        <div class="row" style="justify-content:space-between; margin-bottom:var(--s2)">
          <label class="field" for="cover_reference" style="margin:0">Your letter</label>
          <span class="btn btn-ghost file-btn">Load file<input type="file" id="refFile" accept=".pdf,.docx,.tex,.txt,.md" aria-label="Load reference cover letter from a file"></span>
        </div>
        <textarea id="cover_reference" style="min-height:260px" placeholder="Paste a cover letter you wrote"></textarea>
      </section>

      <section class="section">
        <details class="disclosure" ${p.notes || p.assets.length ? "open" : ""}>
          <summary>More options</summary>
          <div class="card" style="margin-top:var(--s3)">
            <div class="field-group">
              <label class="field" for="notes">Notes for Claude</label>
              <p class="hint">Applies to every application.</p>
              <textarea id="notes" placeholder="e.g. Always mention I'm bilingual. Keep Education first."></textarea>
            </div>
            <div class="field-group">
              <span class="field">Extra template files</span>
              <p class="hint">Only for custom .cls or .sty files, fonts or images.</p>
              <div>${p.assets.map((f) => `<span class="asset">${esc(f)}<button type="button" data-del="${esc(f)}" aria-label="Remove ${esc(f)}">×</button></span>`).join("")}</div>
              <span class="btn btn-ghost file-btn">Upload files<input type="file" id="assets" multiple aria-label="Upload extra template files"></span>
            </div>
          </div>
        </details>
      </section>
    </div>

    <div class="savebar" id="savebar" role="region" aria-label="Unsaved changes">
      <div class="savebar-inner">
        <span class="msg" id="saveMsg">Unsaved changes</span>
        <button class="btn btn-quiet" id="discard" type="button">Discard</button>
        <button class="btn btn-primary" id="save" type="button">Save</button>
      </div>
    </div>`;

  // Set long values as properties, not markup, so nothing in them gets mangled.
  for (const k of FIELDS) $("#" + k).value = p[k] || "";

  // --- Unsaved-changes tracking (error prevention: warn before leaving) ---
  const snapshot = () => JSON.stringify([...FIELDS.map((k) => $("#" + k).value), $("input[name=tmode]:checked").value, $("#pageLimit").value]);
  let saved = snapshot();
  const isDirty = () => snapshot() !== saved;
  const refreshBar = () => {
    const dirty = isDirty();
    $("#savebar").classList.toggle("show", dirty);
    document.body.classList.toggle("has-savebar", dirty);
  };
  $view.addEventListener("input", refreshBar);
  $view.addEventListener("change", refreshBar);
  leaveGuard = (silent) => !isDirty() || (!silent && confirm("You have unsaved changes. Leave without saving?"));

  $("#discard").onclick = () => { leaveGuard = null; route(); };

  // --- Imports ---
  $("#cvFile").onchange = async (e) => {
    const box = $("#master_cv");
    try {
      for (const f of e.target.files) {
        const res = await upload("/api/profile/extract-text", [f], "file");
        box.value = (box.value.trim() ? box.value.trim() + "\n\n" : "") + `===== From ${f.name} =====\n` + res.text.trim();
      }
      toast(`Added ${e.target.files.length} file${e.target.files.length > 1 ? "s" : ""}. Check it, then save.`);
    } catch (err) { toast(err.message); }
    e.target.value = "";
    refreshBar();
  };
  $("#refFile").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const res = await upload("/api/profile/extract-text", [f], "file");
      $("#cover_reference").value = res.text.trim();
      toast("Letter loaded. Check it, then save.");
    } catch (err) { toast(err.message); }
    e.target.value = "";
    refreshBar();
  };
  $$("[data-into]").forEach((inp) => (inp.onchange = async () => {
    if (!inp.files[0]) return;
    $("#" + inp.dataset.into).value = await readFileText(inp.files[0]);
    toast(`Loaded ${inp.files[0].name}`);
    inp.value = "";
    refreshBar();
  }));
  $("#assets").onchange = async (e) => {
    try { await upload("/api/profile/assets", e.target.files, "files"); toast("Uploaded"); } catch (err) { toast(err.message); }
    if (!isDirty()) route();
  };
  $$("[data-del]").forEach((b) => (b.onclick = async () => {
    await api(`/api/profile/assets/${encodeURIComponent(b.dataset.del)}`, { method: "DELETE" });
    b.parentElement.remove();
    toast(`Removed ${b.dataset.del}`);
  }));

  // --- Save ---
  $("#save").onclick = async () => {
    const body = Object.fromEntries(FIELDS.map((k) => [k, $("#" + k).value]));
    body.template_has_my_info = $("input[name=tmode]:checked").value === "real";
    body.resume_page_limit = +$("#pageLimit").value;
    const btn = $("#save");
    btn.disabled = true;
    btn.textContent = "Saving…";
    $("#saveMsg").textContent = "Checking your templates compile…";
    try {
      const res = await api("/api/profile", { method: "POST", json: body });
      saved = snapshot();
      const c = res.checks;
      const bits = [];
      if (c.resume_pages) bits.push(`resume ${c.resume_pages}p`);
      if (c.cover_pages) bits.push(`cover letter ${c.cover_pages}p`);
      leaveGuard = null;
      await route();
      toast(`Saved${bits.length ? ". Templates compile (" + bits.join(", ") + ")" : ""}`);
    } catch (err) {
      $("#saveResult").innerHTML = notice("bad", `<strong>Not saved.</strong><pre>${esc(err.message)}</pre>`);
      $("#saveResult").scrollIntoView({ behavior: "smooth", block: "center" });
      $("#saveResult").focus({ preventScroll: true });
      btn.disabled = false;
      btn.textContent = "Save";
      $("#saveMsg").textContent = "Unsaved changes";
    }
  };

  pageShown("Profile");
}
