"use strict";
/* Kite web app: plain JS, no build step. Views: today, plan, threads, brain, settings. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const CHECK = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2"><path d="M2.5 6.2 5 8.6 9.6 3.6"/></svg>';
const DIMS = { hook: "hook", share: "share", discussion: "talk", novelty: "new", clarity: "clear", fit: "fit", voice: "voice" };

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}
function lift() { const b = $("#brand"); b.classList.remove("lift"); void b.offsetWidth; b.classList.add("lift"); }

if (window.DOMPurify) DOMPurify.addHook("afterSanitizeAttributes", (n) => { if (n.tagName === "A") { n.target = "_blank"; n.rel = "noopener noreferrer"; } });
function md(text, extra = {}) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(text || "", { gfm: true, breaks: true }), extra);
  return esc(text).replace(/\n/g, "<br>");
}
async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); toast("Copied"); if (btn) btn.textContent = "Copied"; }
  catch { toast("Couldn't copy; select the text instead"); }
}
function readFiles(fileList) {
  return Promise.all([...fileList].filter((f) => f.size <= 15 * 1024 * 1024).map((f) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res({ name: f.name, type: f.type || (f.name.endsWith(".js") ? "text/javascript" : "text/plain"), data: String(r.result).split(",")[1] || "" });
    r.onerror = rej; r.readAsDataURL(f);
  })));
}
async function follow(jobId, onUpdate) {
  let since = 0;
  for (;;) {
    const v = await api(`/api/job/${jobId}?since=${since}`);
    since = v.next;
    onUpdate(v);
    if (v.status !== "running") return v;
    await sleep(900);
  }
}

// ---------------------------------------------------------------- router

const VIEWS = ["today", "plan", "threads", "brain", "settings"];
let view = "today";
function go(v, arg) { location.hash = arg ? `${v}/${arg}` : v; }
window.addEventListener("hashchange", route);
function route() {
  const [v, arg] = (location.hash.slice(1) || "today").split("/");
  view = VIEWS.includes(v) ? v : "today";
  VIEWS.forEach((x) => { $(`#v-${x}`).hidden = x !== view; });
  $$(".tab, [data-view]").forEach((b) => b.setAttribute("aria-current", b.dataset.view === view ? "page" : "false"));
  window.scrollTo(0, 0);
  ({ today: loadToday, plan: () => loadPlan(arg), threads: () => loadThreads(arg), brain: loadBrain, settings: loadSettings })[view]();
}
$$("[data-view]").forEach((b) => (b.onclick = () => go(b.dataset.view)));
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
  const n = Number(e.key);
  if (n >= 1 && n <= 5) go(VIEWS[n - 1]);
  if (e.key === "n") { go("plan"); setTimeout(() => $("#goal").focus(), 50); }
});

let WS = {};
async function workspace() { WS = await api("/api/workspace").catch(() => ({})); return WS; }
function setHealth(t) {
  const ok = t.writer.ok && t.judge.ok;
  $("#health").classList.toggle("ok", ok);
  $("#health").title = `Writer: ${t.writer.info}\nJudge: ${t.judge.info}`;
}

// ---------------------------------------------------------------- Today

let deckIndex = 0;
async function loadToday() {
  const t = await api("/api/today");
  setHealth(t);
  const h = new Date().getHours();
  const hi = h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  $("#hello").textContent = `${hi}${t.handle ? `, ${t.handle.replace(/^@?/, "@")}` : ""}.`;
  $("#direction").textContent = t.direction || (t.run ? `Working toward: ${t.run.goal}` : "");
  const days = t.activity.days.slice(-7);
  $("#streak").innerHTML = `<div class="days" title="Last 7 days with something done">${days.map((d, i) =>
    `<i class="${d.done ? "on" : ""} ${i === days.length - 1 ? "today" : ""}" title="${d.day}: ${d.done} done"></i>`).join("")}</div>
    <span class="small dim">${t.activity.streak ? `${t.activity.streak}-day streak` : "Start a streak today"}</span>`;
  const body = $("#today-body");
  if (!t.writer.ok || !t.profile) return renderOnboarding(body, t);
  if (!t.run) {
    body.innerHTML = `<div class="block card strong"><h2>First plan</h2>
      <p>What are you going for? Kite will research, draft and let Jev pick what's worth doing.</p>
      <div class="row"><input class="grow" id="todayGoal" placeholder="e.g. 1,000 followers by launch day" value="${esc(t.goal)}"><button class="btn" id="todayRun">Make a plan</button></div></div>`;
    $("#todayRun").onclick = () => startRun($("#todayGoal").value);
    return;
  }
  const open = t.actions.filter((a) => a.status !== "done" && a.status !== "skipped");
  const doneCount = t.actions.filter((a) => a.status === "done").length;
  const threadFor = Object.fromEntries(t.threads.map((th) => [th.action, th.id]));
  const busy = t.threads.filter((th) => th.busy).length;
  // One thing at a time: the next action up front, the rest folded away.
  body.innerHTML = `
    <div class="block"><h2><span class="grow">${open.length ? "Next up" : "Focus"}</span><span class="tiny dim">${doneCount}/${t.actions.length} done</span></h2>
      <div class="focus" id="focus"></div>
      ${open.length > 1 ? `<details class="later"><summary>${open.length - 1} more after this</summary><div class="focus" id="later"></div></details>` : ""}</div>
    <div class="block" id="deckBlock"><h2><span class="grow">Ready to post</span><span class="pager" id="pager"></span></h2><div class="deck" id="deck"></div></div>
    <div class="block row small dim">
      <a href="#plan/${t.run.id}">Full plan →</a>
      ${t.threads.length ? `<a href="#threads">${t.threads.length} thread${t.threads.length > 1 ? "s" : ""}${busy ? `, ${busy} working` : ""} →</a>` : ""}
      <span class="grow"></span><button class="btn quiet sm" id="newPlan">New plan</button></div>`;
  $("#newPlan").onclick = () => { go("plan"); setTimeout(() => $("#goal").focus(), 50); };
  const row = (a) => actionRow(a, t.run.id, () => loadToday(), { compact: true, thread: threadFor[a.text] });
  if (open.length) $("#focus").append(row(open[0]));
  else $("#focus").innerHTML = `<div class="alldone">All done. Nice work. <button class="btn quiet sm" id="again">Make the next plan</button></div>`;
  open.slice(1).forEach((a) => $("#later").append(row(a)));
  $("#again")?.addEventListener("click", () => go("plan"));
  deckIndex = Math.min(deckIndex, Math.max(0, t.posts.length - 1));
  renderDeck(t.posts, t.run.id);
}

function renderOnboarding(body, t) {
  const step = (ok, n, title, inner) => `<div class="step ${ok ? "ok" : ""}"><span class="n">${ok ? CHECK : n}</span><div><b>${title}</b>${inner}</div></div>`;
  body.innerHTML = `<div class="block card onboard">
    ${step(t.writer.ok, 1, "Connect a model", `<p class="small dim">${esc(t.writer.info)}. ${t.judge.ok ? "Jev is connected." : esc(t.judge.info) + "."}</p>
      ${t.writer.ok ? "" : `<button class="btn sm" id="obSettings">Open settings</button>`}`)}
    ${step(t.profile, 2, "Teach Kite your voice", t.profile ? `<p class="small dim">Profile saved. Edit it in Settings.</p>` : `
      <p class="small dim">Open your profile, press Cmd+A then Cmd+C, and paste it here. Messy is fine. Or add screenshots or an export in Settings.</p>
      <textarea id="obPaste" placeholder="Paste your profile page"></textarea>
      <div class="row" style="margin-top:8px"><button class="btn sm" id="obRead" ${t.writer.ok ? "" : "disabled"}>Read my profile</button><span class="tiny dim" id="obStatus"></span></div>`)}
    ${step(false, 3, "Make your first plan", `<p class="small dim">Set a goal and Kite drafts a plan and posts, with Jev picking the winners.</p>`)}
  </div>`;
  $("#obSettings")?.addEventListener("click", () => go("settings"));
  $("#obRead")?.addEventListener("click", async () => {
    const pasted = $("#obPaste").value.trim();
    if (!pasted) return toast("Paste something first");
    $("#obRead").disabled = true;
    try {
      const { job } = await api("/api/profile", { platform: WS.platform || "x", handle: WS.handle || "", pasted });
      const v = await follow(job, (u) => { const l = u.log.at(-1); if (l) $("#obStatus").textContent = l.text; });
      if (v.status === "error") throw new Error(v.error);
      toast("Profile saved"); lift(); loadToday();
    } catch (e) { $("#obStatus").textContent = e.message; $("#obRead").disabled = false; }
  });
}

function actionRow(a, runId, after, opts = {}) {
  const el = document.createElement("div");
  el.className = `act ${a.status === "done" ? "done" : ""} ${a.status === "skipped" ? "skipped" : ""} ${opts.compact ? "compact" : ""}`;
  el.innerHTML = `<button class="check" aria-label="Mark done">${CHECK}</button>
    <div><div class="what" title="${opts.compact ? "Show all" : ""}"></div>${a.reason && !opts.compact ? `<div class="why">${esc(a.reason)}</div>` : ""}
      ${opts.compact ? "" : `<div class="meta">Jev ${Math.round(a.priority || 0)}${a.first >= 0.2 ? ` · do first ${pct(a.first)}` : ""}</div>`}</div>
    <div class="side">${a.status === "in progress" ? '<span class="chip">in progress</span>' : ""}
      <button class="btn ghost sm work">${opts.thread ? "Continue →" : "Work on it →"}</button>
      <button class="btn quiet sm skip">${a.status === "skipped" ? "Undo skip" : "Skip"}</button></div>`;
  $(".what", el).textContent = a.text;
  const set = async (status) => {
    try { await api("/api/brain/event", { type: "action", action: a.text, status }); } catch (e) { return toast(e.message); }
    if (status === "done") { lift(); toast("Nice. Saved to your brain."); }
    after();
  };
  $(".check", el).onclick = () => set(a.status === "done" ? "todo" : "done");
  $(".skip", el).onclick = () => set(a.status === "skipped" ? "todo" : "skipped");
  $(".work", el).onclick = () => (opts.thread ? go("threads", opts.thread) : newThread(a, runId));
  if (opts.compact) $(".what", el).onclick = (e) => e.currentTarget.classList.toggle("full");
  return el;
}

function postCard(p, runId, onDone) {
  const el = document.createElement("div");
  el.className = "post";
  const s = p.scores || {};
  el.innerHTML = `${p.kind ? `<div class="kind">${esc(p.kind)}</div>` : ""}<div class="text"></div>
    ${p.reason ? `<div class="why">${esc(p.reason)}</div>` : ""}
    <details class="scores"><summary>Scores</summary><div class="bars">${Object.entries(DIMS).map(([k, l]) => `<div>${l}<span><b style="width:${((s[k] || 0) / 4) * 100}%"></b></span></div>`).join("")}</div>
      <p class="tiny dim">${[p.h2h != null ? `head-to-head ${pct(p.h2h)}` : "", `breakout ${pct(p.breakout)}`, `bait ${pct(p.bait)}`, p.rehash ? `rehash ${pct(p.rehash)}` : ""].filter(Boolean).join(" · ")}</p></details>
    <div class="foot"><span class="score">${Math.round(p.viral)}<small>Jev</small></span>
      <span class="tiny dim grow">${[p.h2h != null ? `wins ${pct(p.h2h)} head-to-head` : "", p.bait > 0.2 ? "reads as bait" : "", p.rehash > 0.3 ? "close to an old post" : ""].filter(Boolean).join(" · ")}</span>
      <button class="btn ghost sm cp">Copy</button><button class="btn sm posted">I posted it</button><button class="btn quiet sm pass">Skip</button></div>`;
  $(".text", el).textContent = p.text;
  $(".cp", el).onclick = (e) => copy(p.text, e.target);
  $(".posted", el).onclick = async () => {
    await api("/api/brain/event", { type: "posted", text: p.text, kind: p.kind, viral: p.viral, run: runId }).catch((e) => toast(e.message));
    lift(); toast("Posted. Saved to your brain."); onDone?.();
  };
  $(".pass", el).onclick = async () => {
    await api("/api/brain/event", { type: "post_skipped", text: p.text, run: runId }).catch((e) => toast(e.message));
    toast("Skipped"); onDone?.();
  };
  return el;
}

function renderDeck(posts, runId) {
  const deck = $("#deck"), pager = $("#pager");
  deck.innerHTML = "";
  if (!posts.length) { $("#deckBlock").innerHTML = `<h2>Ready to post</h2><p class="empty">Nothing waiting. Every post from this plan is published or skipped.</p>`; return; }
  const i = deckIndex;
  deck.append(postCard(posts[i], runId, () => loadToday()));
  pager.innerHTML = posts.length > 1 ? `<button class="btn quiet sm" id="prev" ${i === 0 ? "disabled" : ""}>←</button>${i + 1}/${posts.length}<button class="btn quiet sm" id="next" ${i === posts.length - 1 ? "disabled" : ""}>→</button>` : "";
  $("#prev")?.addEventListener("click", () => { deckIndex--; renderDeck(posts, runId); });
  $("#next")?.addEventListener("click", () => { deckIndex++; renderDeck(posts, runId); });
}

async function newThread(a, runId) {
  try {
    await workspace();
    const run = runId ? await api(`/api/job/${runId}`).catch(() => null) : null;
    const context = run ? [
      run.mix?.length ? "Content mix (Jev): " + run.mix.map((m) => `${m.kind} ${pct(m.share)}`).join("; ") : "",
      run.ideas?.length ? "Top ideas (Jev): " + run.ideas.slice(0, 6).map((x) => x.text).join(" | ") : "",
      run.final?.plan?.length ? "Full plan: " + run.final.plan.map((x, i) => `${i + 1}. ${x.text}`).join(" ") : "",
    ].filter(Boolean).join("\n") : "";
    const { thread } = await api("/api/thread", { action: a.text, reason: a.reason, platform: WS.platform, profile: WS.profile,
      goal: run?.meta?.goal || WS.goal, digest: WS.digest, context, run: runId });
    go("threads", thread);
  } catch (e) { toast(e.message); }
}

async function startRun(goal) {
  await workspace();
  if (!WS.profile) { toast("Add your profile first"); return go("settings"); }
  try {
    const { job } = await api("/api/run", { platform: WS.platform || "x", goal, profile: WS.profile, digest: WS.digest, top: WS.top });
    go("plan", job);
  } catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------- Plan

let runPoll = 0;
async function loadPlan(id) {
  await workspace();
  $("#goal").value = $("#goal").value || WS.goal || "";
  $("#runBtn").onclick = () => startRun($("#goal").value.trim());
  $("#goal").onkeydown = (e) => { if (e.key === "Enter") startRun($("#goal").value.trim()); };
  const runs = await api("/api/runs");
  const current = id || runs[0]?.id;
  $("#runs").innerHTML = runs.length ? runs.map((r) => `<button data-run="${r.id}" aria-current="${r.id === current}">${esc(r.goal || "(no goal)")}
    <span class="sub">${new Date(r.created * 1000).toLocaleDateString([], { month: "short", day: "numeric" })} · ${r.status === "running" ? "working…" : r.plan ? `${r.plan} actions · ${r.posts} posts` : r.status === "error" ? "stopped" : "empty"}</span></button>`).join("")
    : `<p class="empty">No plans yet.</p>`;
  $$("#runs [data-run]").forEach((b) => (b.onclick = () => go("plan", b.dataset.run)));
  if (!current) { $("#run").innerHTML = `<p class="empty" style="margin-top:40px">Set a goal on the left to make your first plan.</p>`; return; }
  openRun(current);
}

async function openRun(id) {
  const token = ++runPoll;
  let since = 0, log = [];
  for (;;) {
    let v;
    try { v = await api(`/api/job/${id}?since=${since}`); } catch (e) { $("#run").innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
    if (token !== runPoll || view !== "plan") return;
    log = log.concat(v.log); since = v.next;
    renderRun(v, log);
    if (v.status !== "running") { if (v.status === "done" && log.length && since > 0) lift(); return; }
    await sleep(1000);
  }
}

// The steps worth showing by default; the full log (thinking, every score) is one click away.
const MILESTONES = new Set(["tool", "research", "read", "ask", "final", "error"]);
function stepText(e) {
  const t = String(e.text).split("\n")[0];
  return ({ research: `Searching ${t}`, read: `Reading ${t.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}`, ask: `Asking Jev: ${t}`, final: "Plan ready" })[e.kind] ?? t;
}
let fullLog = false;
function logText(e) {
  const first = (s) => String(s).split("\n")[0].slice(0, 120);
  return ({ tool: `→ ${e.text}`, score: `   ${String(Math.round(e.viral)).padStart(3)}  ${first(e.text)}`, action: `   P${String(Math.round(e.priority)).padStart(3)}  ${first(e.text)}`,
    idea: `   I${String(Math.round(e.priority)).padStart(3)}  ${first(e.text)}`, mix: `   ${String(Math.round(e.share * 100)).padStart(3)}%  ${first(e.text)}`,
    ask: `? ${e.text}`, answer: `   = ${e.text}`, h2h: `   head-to-head  ${e.text}`, research: `⌕ ${e.text}`, found: `   ${e.text}`, read: `  reading ${e.text}`,
    claude: e.text, think: `  ${String(e.text).replace(/\s+/g, " ").slice(0, 300)}`, error: `! ${e.text}`, final: `✓ ${e.text}` })[e.kind] ?? e.text;
}

async function renderRun(v, log) {
  const running = v.status === "running";
  const el = $("#run");
  const wasOpen = $("details.log", el)?.open;
  const logBox = $(".logbox", el);
  const atBottom = logBox ? logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 30 : true;
  const final = v.final || {};
  const plan = final.plan || (running ? v.actions : []);
  const posts = final.posts || (running ? v.drafts.slice(0, 3) : []);
  const steps = log.filter((e) => MILESTONES.has(e.kind));
  el.innerHTML = `
    <h1>${esc(v.meta?.goal || "Plan")}</h1>
    <div class="row small dim">${running ? '<span class="working"><i></i><i></i><i></i></span> Working on it' : v.status === "error" ? "Stopped" : "Done"}
      · ${new Date((v.meta?.created || 0) * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
      · Jev ${v.cost.jevCalls} calls${(v.cost.llm ?? v.cost.claude) ? ` · ≈ $${((v.cost.llm ?? v.cost.claude) + v.cost.jev).toFixed(2)}` : ""}
      <span class="grow"></span>${running ? "" : `<button class="btn quiet sm" id="delRun">Remove</button>`}</div>
    ${v.error ? `<p class="small" style="margin-top:10px"><b>${esc(v.error)}</b></p>` : ""}
    <details class="log block" ${wasOpen ? "open" : ""}><summary>${running ? esc(steps.length ? stepText(steps[steps.length - 1]) : "Getting started") : "How Kite got here"}
      <span class="dim"> · ${steps.length} step${steps.length === 1 ? "" : "s"}</span></summary>
      <div class="logbox ${fullLog ? "" : "steps"}"></div><button class="btn quiet sm" id="fullLog">${fullLog ? "Show fewer details" : "Show full log"}</button></details>
    ${v.mix?.length ? `<div class="block"><h2>Mix</h2><div class="mixbar">${v.mix.map((m) => `<i style="width:${m.share * 100}%" title="${esc(m.kind)}"></i>`).join("")}</div>
      <div class="mixlegend">${v.mix.slice(0, 5).map((m) => `<div><b>${pct(m.share)}</b><span>${esc(m.kind)}</span></div>`).join("")}</div></div>` : ""}
    ${v.ideas?.length ? `<div class="block"><h2>Ideas</h2><div class="ideas">${v.ideas.slice(0, 5).map((i) => `<div class="idea" title="${esc(i.basis || "")}"><span class="p">${Math.round(i.priority)}</span>
      <div>${esc(i.text)}</div></div>`).join("")}</div></div>` : ""}
    ${plan.length ? `<div class="block"><h2>${final.plan ? "Plan" : "Actions so far"}</h2><div class="focus" id="planActs"></div></div>` : ""}
    ${posts.length ? `<div class="block"><h2>${final.posts ? "Posts" : "Best drafts so far"}</h2><div class="stack" id="planPosts"></div></div>` : ""}`;
  const box = $(".logbox", el);
  box.innerHTML = fullLog ? log.map((e) => `<div class="${e.kind}">${esc(logText(e))}</div>`).join("")
    : steps.map((e) => `<div class="${e.kind}">${esc(stepText(e))}</div>`).join("");
  $("#fullLog").onclick = () => { fullLog = !fullLog; renderRun(v, log); };
  if (atBottom) box.scrollTop = box.scrollHeight;
  $("#delRun")?.addEventListener("click", async () => {
    if (!confirm("Remove this plan from the list? It's moved to data/runs/trash, not erased.")) return;
    await api(`/api/runs/${v.id}/delete`, {}); toast("Removed"); go("plan");
  });
  if (plan.length) {
    const statuses = final.plan ? await api("/api/brain/statuses", { actions: plan.map((a) => a.text) }).catch(() => ({})) : {};
    const box2 = $("#planActs");
    if (!box2) return;
    plan.forEach((a) => {
      const row = actionRow({ ...a, status: statuses[a.text] || "todo" }, v.id, () => openRun(v.id));
      if (!final.plan) $$(".side button", row).forEach((b) => b.remove());
      box2.append(row);
    });
  }
  const state = v.postState || {};
  posts.forEach((p) => {
    const card = postCard(p, v.id, () => openRun(v.id));
    if (state[p.text]) { card.style.opacity = ".5"; $(".foot .posted", card).textContent = state[p.text] === "posted" ? "Posted" : "Skipped"; $(".foot .posted", card).disabled = true; }
    if (!final.posts) $$(".posted, .pass", card).forEach((b) => b.remove());
    $("#planPosts")?.append(card);
  });
}

// ---------------------------------------------------------------- Threads

let threadPoll = 0, threadFiles = [];
async function loadThreads(id) {
  const list = await api("/api/threads");
  const current = id || list[0]?.id;
  $("#threadList").innerHTML = list.length ? list.map((t) => `<button data-th="${t.id}" aria-current="${t.id === current}">${esc(t.action)}
    <span class="sub">${t.total ? `${t.done}/${t.total} steps` : "new"}${t.busy ? " · working" : ""}</span></button>`).join("") : `<p class="empty">No threads yet.</p>`;
  $$("#threadList [data-th]").forEach((b) => (b.onclick = () => go("threads", b.dataset.th)));
  if (!current) { $("#thread").innerHTML = `<p class="empty" style="margin-top:40px">Open a plan and hit “Work on it” on any action. Kite breaks it into steps and drafts the work with you.</p>`; return; }
  const th = await api(`/api/thread/${current}`).catch(() => null);
  if (!th) return;
  renderThread(th);
  if (th.busy && th.job) watchTurn(th.id, th.job);
}

function renderThread(th) {
  const el = $("#thread");
  const draft = $("#tInput")?.value || "";
  el.innerHTML = `
    <h1 style="font-size:22px">${esc(th.action)}</h1>
    ${th.reason ? `<p class="small dim" style="margin:0">${esc(th.reason)}</p>` : ""}
    ${th.run ? `<p class="tiny" style="margin:6px 0 0"><a href="#plan/${th.run}">From the plan: ${esc(th.runGoal || "a saved plan")} →</a></p>` : ""}
    <div class="checklist" id="checklist"></div>
    <div class="chat" id="chat"></div>
    <div class="composer">
      <textarea id="tInput" placeholder="Paste the posts you want to reply to (or attach screenshots), ask for changes, or say what you did."></textarea>
      <div class="row" style="margin-top:8px"><button class="btn ghost sm" id="tAttach">Attach</button><button class="btn quiet sm" id="tClip" title="Collect posts from X, LinkedIn, Bluesky and more">Clip posts</button><input type="file" id="tFile" multiple accept="image/*,.txt,.csv,.json,.md" hidden>
        <span class="tiny dim grow" id="tStatus">${th.cost ? `≈ $${th.cost.toFixed(2)} so far · ` : ""}⌘↵ to send</span>
        <button class="btn quiet sm" id="tShare">Share</button><button class="btn quiet sm" id="tDelete">Delete</button><button class="btn" id="tSend" ${th.busy ? "disabled" : ""}>Send</button></div>
    </div>`;
  $("#tInput").value = draft;
  if (pendingThreadText?.id === th.id) { $("#tInput").value = pendingThreadText.text; pendingThreadText = null; }
  $("#tClip").onclick = () => showClipperGuide();
  // A clip pasted here becomes a readable list of posts to reply to.
  $("#tInput").addEventListener("input", (e) => {
    const v = e.target.value.trim();
    if (!v.startsWith('{"kite_clip"')) return;
    try { e.target.value = clipAsText(JSON.parse(v)); } catch { /* not a complete clip; leave it as pasted */ }
  });
  const cl = $("#checklist");
  cl.innerHTML = th.checklist.map((c, i) => `<label class="${c.done ? "done" : ""}"><input type="checkbox" data-i="${i}" ${c.done ? "checked" : ""}><span>${esc(c.text)}</span></label>`).join("");
  $$("input", cl).forEach((box) => (box.onchange = async () => {
    const t = await api(`/api/thread/${th.id}/check`, { i: +box.dataset.i, done: box.checked });
    if (box.checked) lift();
    renderThread(t);
  }));
  const chat = $("#chat");
  // Group each reply (everything between two user messages) and show only its last round of Jev cards.
  const turns = [];
  for (const m of th.display) {
    if (m.role === "user") turns.push({ user: m, items: [] });
    else (turns[turns.length - 1] || turns[turns.push({ items: [] }) - 1]).items.push(m);
  }
  for (const turn of turns) {
    const m = turn.user;
    if (m && !m.hidden) chat.insertAdjacentHTML("beforeend", `<div class="msg user"><div class="who">You</div><div class="body">${linkify(esc(m.text))}${m.images ? `\n[${m.images} screenshot${m.images > 1 ? "s" : ""}]` : ""}</div></div>`);
    const cards = turn.items.filter((x) => x.role === "cards"), last = cards[cards.length - 1];
    if (cards.length > 1) {
      const d = document.createElement("details"); d.className = "rounds";
      d.innerHTML = `<summary>${cards.length - 1} earlier round${cards.length > 2 ? "s" : ""} of drafts</summary>`;
      cards.slice(0, -1).forEach((c) => d.append(cardsEl(c, th)));
      chat.append(d);
    }
    for (const x of turn.items) {
      if (x.role === "claude") chat.insertAdjacentHTML("beforeend", `<div class="msg"><div class="who">Kite</div><div class="body md">${md(x.text)}</div></div>`);
      else if (x === last) chat.append(cardsEl(x, th));
    }
  }
  $("#tAttach").onclick = () => $("#tFile").click();
  $("#tFile").onchange = async (e) => { threadFiles = threadFiles.concat(await readFiles(e.target.files)); $("#tStatus").textContent = `${threadFiles.length} attached`; };
  $("#tSend").onclick = () => sendThread(th.id);
  $("#tInput").onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendThread(th.id); };
  $("#tShare").onclick = () => {
    const last = [...th.display].reverse().find((m) => m.role === "cards");
    showShare(last ? shareFromCards(last, th) : shareFromChecklist(th), th.action);
  };
  $("#tDelete").onclick = async () => { if (!confirm("Delete this thread?")) return; await api(`/api/thread/${th.id}/delete`, {}); go("threads"); };
}

function cardsEl(m, th) {
  const el = document.createElement("div");
  el.className = "msg";
  const head = { replies: "Replies to", posts: "Posts", choice: "Jev's pick" }[m.kind] || "";
  el.innerHTML = `<div class="row cardhead"><div class="who grow">Jev · ${esc(head)}</div><button class="btn quiet sm shareCard">Share</button></div>${m.kind === "replies" ? `<p class="small dim" style="margin:0 0 8px">${esc(m.title)}</p>` : m.kind === "choice" ? `<p class="small dim" style="margin:0 0 8px">${esc(m.title)}</p>` : ""}<div class="opts"></div>`;
  const items = [...m.items].sort((a, b) => (b.score ?? b.viral ?? b.p ?? 0) - (a.score ?? a.viral ?? a.p ?? 0));
  items.forEach((it, i) => {
    const o = document.createElement("div");
    o.className = `opt ${i === 0 ? "best" : ""}`;
    o.hidden = i >= 2;
    let n, meta = "";
    if (m.kind === "replies") { n = Math.round(it.score); meta = `author engages ${pct(it.author)} · profile visit ${pct(it.follow)} · spam ${pct(it.spam)}`; }
    else if (m.kind === "posts") { n = Math.round(it.viral); meta = Object.entries(DIMS).map(([k, l]) => `${l} ${(it.scores?.[k] ?? 0).toFixed(1)}`).join(" · "); }
    else { n = pct(it.p); }
    o.innerHTML = `<div class="n">${n}</div><div><div class="text"></div>${meta ? `<div class="meta">${meta}</div>` : ""}
      <div class="row" style="margin-top:8px"><button class="btn ghost sm cp">Copy</button>${m.kind !== "choice" ? `<button class="btn quiet sm posted">I posted it</button>` : ""}</div></div>`;
    $(".text", o).textContent = it.text;
    $(".cp", o).onclick = (e) => copy(it.text, e.target);
    $(".posted", o)?.addEventListener("click", async (e) => {
      await api("/api/brain/event", { type: "posted", text: it.text, kind: m.kind === "replies" ? "reply" : it.kind, viral: it.viral ?? it.score, action: th.action }).catch((x) => toast(x.message));
      e.target.textContent = "Saved"; e.target.disabled = true; lift();
    });
    $(".opts", el).append(o);
  });
  $(".shareCard", el).onclick = () => showShare(shareFromCards(m, th), th.action);
  if (items.length > 2) {
    const more = document.createElement("button"); more.className = "btn quiet sm"; more.textContent = `Show ${items.length - 2} more`;
    more.onclick = () => { $$(".opt", el).forEach((o) => (o.hidden = false)); more.remove(); };
    el.append(more);
  }
  return el;
}

// ---------------------------------------------------------------- Share as image

const CARD_LABEL = { replies: "Replies, ranked by Jev", posts: "Posts, scored by Jev", choice: "Jev's pick" };
function shareFromCards(m, th) {
  const items = [...m.items].sort((a, b) => (b.score ?? b.viral ?? b.p ?? 0) - (a.score ?? a.viral ?? a.p ?? 0)).slice(0, 3);
  const top = items[0]?.p ?? 1;
  const rows = items.map((it) => m.kind === "choice" ? { n: pct(it.p), frac: it.p / (top || 1), text: it.text }
    : { n: String(Math.round(it.viral ?? it.score ?? 0)), frac: (it.viral ?? it.score ?? 0) / 100, text: it.text });
  const done = th.checklist.filter((c) => c.done).length;
  return { label: CARD_LABEL[m.kind] || "Jev", title: th.action, subtitle: m.kind === "posts" ? "" : m.title, rows,
    foot: th.checklist.length ? `${done}/${th.checklist.length} steps done` : "" };
}
function shareFromChecklist(th) {
  const done = th.checklist.filter((c) => c.done).length;
  return { label: "Working on it", title: th.action, subtitle: th.reason || "", check: true,
    rows: th.checklist.slice(0, 8).map((c) => ({ n: c.done ? "✓" : "○", done: c.done, text: c.text })), foot: `${done}/${th.checklist.length} steps done` };
}
function wrapLines(ctx, text, width, max) {
  // Wrap each paragraph on its own so a post's line breaks survive; stop at `max` lines.
  const paras = String(text || "").split(/\n+/).map((p) => p.replace(/\s+/g, " ").trim().split(" ").filter(Boolean)).filter((p) => p.length);
  const lines = [];
  let cut = false;
  for (const words of paras) {
    let line = "";
    for (let i = 0; i < words.length; i++) {
      const t = line ? `${line} ${words[i]}` : words[i];
      if (line && ctx.measureText(t).width > width) {
        lines.push(line); line = words[i];
        if (lines.length === max) { cut = true; break; }
      } else line = t;
    }
    if (cut) break;
    if (lines.length === max) { cut = true; break; }
    lines.push(line);
  }
  if (cut || lines.length > max) {  // ran out of room: end the last line with an ellipsis
    lines.length = Math.min(lines.length, max);
    let last = lines[lines.length - 1];
    while (last && ctx.measureText(`${last}…`).width > width) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last.trimEnd()}…`;
  }
  return lines;
}
function shareCanvas(d) {
  // 1200px wide, drawn at 2x. Pure black and white, like the app.
  const W = 1200, P = 72, S = 2, TEXT = W - 2 * P, NUM = d.check ? 56 : 132;
  const sans = (w, px) => `${w} ${px}px -apple-system, "SF Pro Display", "Segoe UI", system-ui, sans-serif`;
  const mono = (px) => `500 ${px}px ui-monospace, "SF Mono", Menlo, monospace`;
  const m = document.createElement("canvas").getContext("2d");
  m.font = sans(700, 44); const title = wrapLines(m, d.title, TEXT, 3);
  m.font = sans(400, 23); const sub = d.subtitle ? wrapLines(m, d.subtitle, TEXT, 2) : [];
  m.font = sans(400, d.check ? 25 : 24); const rows = d.rows.map((r) => ({ ...r, lines: wrapLines(m, r.text, TEXT - NUM - 28, d.check ? 2 : 4) }));
  const lh = d.check ? 34 : 34, gap = d.check ? 18 : 40;
  let y = P + 34 + 64;
  const titleY = y; y += title.length * 54;
  const subY = y + 14; if (sub.length) y += 14 + sub.length * 32;
  y += 44;
  rows.forEach((r) => { r.y = y; y += r.lines.length * lh + (d.check ? 0 : 22) + gap; });
  const H = Math.max(675, y + 56 + P);

  const c = document.createElement("canvas"); c.width = W * S; c.height = H * S;
  const x = c.getContext("2d"); x.scale(S, S);
  x.fillStyle = "#0a0a0a"; x.fillRect(0, 0, W, H);
  x.textBaseline = "alphabetic";
  // header: kite mark + wordmark, label on the right
  x.fillStyle = "#f4f4f4"; x.beginPath(); x.moveTo(P + 12, P); x.lineTo(P + 24, P + 13); x.lineTo(P + 12, P + 32); x.lineTo(P, P + 13); x.closePath(); x.fill();
  x.font = sans(700, 28); x.fillText("kite", P + 36, P + 25);
  x.font = mono(15); x.fillStyle = "#8c8c8c"; x.textAlign = "right"; x.fillText(d.label.toUpperCase().split("").join(String.fromCharCode(8202)), W - P, P + 22); x.textAlign = "left";
  // title and question
  x.fillStyle = "#f4f4f4"; x.font = sans(700, 44); title.forEach((l, i) => x.fillText(l, P, titleY + i * 54));
  x.fillStyle = "#9a9a9a"; x.font = sans(400, 23); sub.forEach((l, i) => x.fillText(l, P, subY + i * 32 + 18));
  // rows
  const round = (rx, ry, rw, rh, rr) => { x.beginPath(); x.roundRect ? x.roundRect(rx, ry, rw, rh, rr) : x.rect(rx, ry, rw, rh); };
  rows.forEach((r, i) => {
    const best = !d.check && i === 0, textH = r.lines.length * lh;
    if (best) { x.strokeStyle = "#f4f4f4"; x.lineWidth = 1.5; round(P - 22, r.y - 34, TEXT + 44, textH + 22 + 40, 16); x.stroke(); }
    x.fillStyle = d.check ? (r.done ? "#f4f4f4" : "#6e6e6e") : best ? "#f4f4f4" : "#8c8c8c";
    x.font = d.check ? sans(600, 26) : sans(700, 38); x.fillText(r.n, P, r.y + (d.check ? 0 : 6));
    x.fillStyle = d.check ? (r.done ? "#8c8c8c" : "#f4f4f4") : best ? "#f4f4f4" : "#b4b4b4";
    x.font = sans(400, d.check ? 25 : 24); r.lines.forEach((l, j) => x.fillText(l, P + NUM + 28, r.y + j * lh));
    if (d.check && r.done) { x.fillRect(P + NUM + 28, r.y - 9, Math.min(TEXT - NUM - 28, x.measureText(r.lines[0]).width), 1.5); }
    if (!d.check) {
      const bx = P + NUM + 28, by = r.y + textH - 12, bw = TEXT - NUM - 28;
      x.fillStyle = "#222"; round(bx, by, bw, 5, 3); x.fill();
      x.fillStyle = best ? "#f4f4f4" : "#555"; round(bx, by, Math.max(6, bw * Math.min(1, r.frac || 0)), 5, 3); x.fill();
    }
  });
  // footer
  x.fillStyle = "#2a2a2a"; x.fillRect(P, H - P - 30, TEXT, 1);
  x.font = sans(400, 18); x.fillStyle = "#8c8c8c"; x.fillText("made with kite · open-kite.vercel.app", P, H - P + 4);
  if (d.foot) { x.textAlign = "right"; x.fillText(d.foot, W - P, H - P + 4); x.textAlign = "left"; }
  return c;
}
function brainCanvas() {
  // "What kite learned in N days": the real map as a constellation, with the numbers that show it growing.
  const W = 1200, H = 675, S = 2, st = G.stats || { days: [], learnings: [] };
  const sans = (w, px) => `${w} ${px}px -apple-system, "SF Pro Display", "Segoe UI", system-ui, sans-serif`;
  const mono = (px) => `500 ${px}px ui-monospace, "SF Mono", Menlo, monospace`;
  const c = document.createElement("canvas"); c.width = W * S; c.height = H * S;
  const x = c.getContext("2d"); x.scale(S, S);
  x.fillStyle = "#0a0a0a"; x.fillRect(0, 0, W, H);

  // --- the map, fitted into the left panel
  const A = { x: 36, y: 36, w: 660, h: 560 }, pad = 56;
  const xs = G.nodes.map((n) => n.x), ys = G.nodes.map((n) => n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const k = Math.min((A.w - 2 * pad) / (maxX - minX || 1), (A.h - 2 * pad) / (maxY - minY || 1), 2.4);
  const cx = A.x + A.w / 2, cy = A.y + A.h / 2, mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  const P = (n) => [cx + (n.x - mx) * k, cy + (n.y - my) * k];
  // faint growth rings behind it
  x.strokeStyle = "#161616"; x.lineWidth = 1;
  for (let r = 70; r < 420; r += 70) { x.beginPath(); x.arc(cx, cy, r, 0, 6.2832); x.stroke(); }
  const core = (n) => !n.folder;
  for (const [ia, ib] of G.edges) {
    const a = G.byId[ia], b = G.byId[ib], [ax, ay] = P(a), [bx, by] = P(b);
    x.strokeStyle = core(a) && core(b) ? "#5a5a5a" : "#343434"; x.lineWidth = 1;
    x.beginPath(); x.moveTo(ax, ay); x.lineTo(bx, by); x.stroke();
  }
  const labels = [];
  for (const n of G.nodes) {
    const [nx, ny] = P(n), r = radius(n) * 1.15;
    x.beginPath(); x.arc(nx, ny, r, 0, 6.2832);
    if (n.folder === "Actions" && n.status !== "done") { x.fillStyle = "#0a0a0a"; x.fill(); x.strokeStyle = "#d8d8d8"; x.lineWidth = 1.5; x.stroke(); }
    else { x.fillStyle = n.folder === "Log" ? "#6a6a6a" : core(n) ? "#f4f4f4" : "#cfcfcf"; x.fill(); }
    if (core(n)) labels.push([n, nx, ny + r + 18]);
  }
  x.textAlign = "center"; x.lineJoin = "round";
  for (const [n, lx, ly] of labels) {
    x.font = sans(core(n) ? 600 : 400, 15); const t = shortTitle(n.title);
    x.strokeStyle = "#0a0a0a"; x.lineWidth = 5; x.strokeText(t, lx, ly);
    x.fillStyle = core(n) ? "#f4f4f4" : "#a8a8a8"; x.fillText(t, lx, ly);
  }
  x.textAlign = "left";

  // --- the story, on the right
  const R = 744, RW = W - R - 48;
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const first = st.days[0]?.day, days = first ? Math.max(1, Math.floor((today - new Date(`${first}T00:00:00`)) / 864e5) + 1) : 1;
  x.fillStyle = "#f4f4f4"; x.beginPath(); x.moveTo(R + 11, 50); x.lineTo(R + 22, 62); x.lineTo(R + 11, 80); x.lineTo(R, 62); x.closePath(); x.fill();
  x.font = sans(700, 26); x.fillText("kite", R + 32, 73);
  x.font = mono(14); x.fillStyle = "#8c8c8c"; x.textAlign = "right"; x.fillText("BRAIN", W - 48, 71); x.textAlign = "left";
  x.fillStyle = "#f4f4f4"; x.font = sans(700, 42);
  x.fillText("what kite learned", R, 150); x.fillText(`in ${days} day${days === 1 ? "" : "s"}`, R, 198);
  const stat = (n, label, sx, sy) => { x.fillStyle = "#f4f4f4"; x.font = sans(700, 40); x.fillText(String(n), sx, sy); x.fillStyle = "#8c8c8c"; x.font = sans(400, 16); x.fillText(label, sx, sy + 24); };
  stat(st.notes ?? G.nodes.length, "notes", R, 270); stat(G.edges.length, "links", R + RW / 2, 270);
  stat(st.actions ? `${st.done}/${st.actions}` : 0, "actions done", R, 350); stat(st.posts ?? 0, st.posts === 1 ? "post published" : "posts published", R + RW / 2, 350);
  const lesson = st.learnings?.[0];
  if (lesson) {
    x.font = mono(12); x.fillStyle = "#8c8c8c"; x.fillText("WHAT IT KNOWS ABOUT ME", R, 418);
    x.font = sans(400, 19); x.fillStyle = "#e6e6e6"; wrapLines(x, lesson, RW, 3).forEach((l, i) => x.fillText(l, R, 448 + i * 27));
  }
  // memory added each day: the last 14 days, ending today
  const byDay = Object.fromEntries(st.days.map((d) => [d.day, d.events]));
  const recent = Array.from({ length: 14 }, (_, i) => { const d = new Date(today); d.setDate(d.getDate() - 13 + i); return byDay[dayKey(d)] || 0; });
  const top = Math.max(1, ...recent);
  x.font = mono(12); x.fillStyle = "#8c8c8c"; x.fillText("MEMORY ADDED EACH DAY", R, 552);
  recent.forEach((ev, i) => {
    const g = Math.round(90 + (ev / top) * 154);
    x.beginPath(); x.roundRect ? x.roundRect(R + i * 22, 564, 16, 16, 4) : x.rect(R + i * 22, 564, 16, 16);
    if (ev) { x.fillStyle = `rgb(${g},${g},${g})`; x.fill(); } else { x.strokeStyle = "#2c2c2c"; x.lineWidth = 1; x.stroke(); }
  });
  // footer
  x.fillStyle = "#2a2a2a"; x.fillRect(36, 616, W - 84, 1);
  x.font = sans(400, 17); x.fillStyle = "#8c8c8c"; x.fillText("made with kite · open-kite.vercel.app", 48, 648);
  x.textAlign = "right"; x.fillText("a local brain of plain markdown notes", W - 48, 648); x.textAlign = "left";
  return c;
}
function showShare(data, name) {
  const canvas = data instanceof HTMLCanvasElement ? data : shareCanvas(data), url = canvas.toDataURL("image/png");
  const ov = document.createElement("div"); ov.className = "share-ov";
  ov.innerHTML = `<div class="share-box" role="dialog" aria-label="Share image"><img alt="Preview of the image to share">
    <div class="row"><button class="btn" id="shDl">Download</button><button class="btn ghost" id="shCp">Copy image</button><span class="grow"></span><button class="btn quiet" id="shX">Close</button></div></div>`;
  $("img", ov).src = url;
  document.body.append(ov);
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  document.addEventListener("keydown", onKey);
  ov.onclick = (e) => { if (e.target === ov) close(); };
  $("#shX", ov).onclick = close;
  $("#shDl", ov).onclick = () => { const a = document.createElement("a"); a.href = url; a.download = `kite-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/-$/, "")}.png`; a.click(); };
  $("#shCp", ov).onclick = () => canvas.toBlob(async (b) => {
    try { await navigator.clipboard.write([new ClipboardItem({ "image/png": b })]); toast("Image copied"); } catch { toast("Couldn't copy; use Download"); }
  });
}

async function sendThread(id) {
  const text = $("#tInput").value.trim();
  if (!text && !threadFiles.length) return;
  $("#tSend").disabled = true;
  try {
    const { job } = await api(`/api/thread/${id}/message`, { text, files: threadFiles });
    $("#tInput").value = ""; threadFiles = [];
    const th = await api(`/api/thread/${id}`); renderThread(th);
    watchTurn(id, job);
  } catch (e) { $("#tStatus").textContent = e.message; $("#tSend").disabled = false; }
}

async function watchTurn(id, job) {
  const token = ++threadPoll;
  let since = 0, last = 0;
  for (;;) {
    const v = await api(`/api/job/${job}?since=${since}`).catch(() => null);
    if (!v || token !== threadPoll || view !== "threads") return;
    since = v.next;
    const line = [...v.log].reverse().find((e) => e.kind !== "think");
    if (Date.now() - last > 2500 || v.status !== "running") { last = Date.now(); renderThread(await api(`/api/thread/${id}`)); }
    const status = $("#tStatus");
    if (status && v.status === "running") status.innerHTML = `<span class="working"><i></i><i></i><i></i></span> ${esc(line ? logText(line).trim().slice(0, 100) : "Thinking")}`;
    if (v.status !== "running") {
      if (v.status === "error" && status) {
        status.textContent = v.error + " ";
        const again = document.createElement("button"); again.className = "btn quiet sm"; again.textContent = "Try again";
        again.onclick = () => { $("#tInput").value = "Please continue where you left off."; sendThread(id); };
        status.append(again);
      }
      return;
    }
    await sleep(900);
  }
}

// ---------------------------------------------------------------- Brain map

const G = { nodes: [], edges: [], byId: {}, adj: {}, scale: 1, ox: 0, oy: 0, hover: null, sel: null, alpha: 0, drag: null, pan: null, moved: false, running: false, filter: "", touched: false, autoFit: true };
let noteMode = "read";

async function loadBrain() {
  const d = await api("/api/brain");
  $("#brainPath").textContent = d.path;
  G.stats = d.stats;
  const old = G.byId;
  G.nodes = d.nodes.map((n) => ({ ...n, x: old[n.id]?.x, y: old[n.id]?.y, vx: 0, vy: 0 }));
  G.byId = Object.fromEntries(G.nodes.map((n) => [n.id, n]));
  G.edges = d.edges.filter(([a, b]) => G.byId[a] && G.byId[b]);
  G.adj = Object.fromEntries(G.nodes.map((n) => [n.id, new Set()]));
  for (const [a, b] of G.edges) { G.adj[a].add(b); G.adj[b].add(a); }
  let fresh = false;
  for (const n of G.nodes) {
    n.deg = G.adj[n.id].size;
    if (n.x == null) {
      fresh = true;
      const nb = [...G.adj[n.id]].map((i) => G.byId[i]).find((m) => m.x != null), a = Math.random() * 6.28, r = nb ? 40 : 100 + Math.random() * 120;
      n.x = (nb?.x ?? 0) + Math.cos(a) * r; n.y = (nb?.y ?? 0) + Math.sin(a) * r;
    }
  }
  G.alpha = 1;
  if (fresh) { const t0 = performance.now(); while (G.alpha > 0.05 && performance.now() - t0 < 150) tick(); }  // open already arranged
  G.autoFit = !G.touched; resize(); if (G.autoFit) fitView(); draw();
  if (!G.running) { G.running = true; requestAnimationFrame(loop); }
  loadTrash();
  if (G.sel && G.byId[G.sel]) openNote(G.sel, true);
}
const radius = (n) => (n.folder === "Log" ? 3 : n.folder ? 4 + Math.min(4, Math.sqrt(n.deg) * 1.2) : 6 + Math.min(7, Math.sqrt(n.deg) * 1.8));
function tick() {
  const N = G.nodes, k = G.alpha;
  for (let i = 0; i < N.length; i++) for (let j = i + 1; j < N.length; j++) {
    const a = N[i], b = N[j]; let dx = a.x - b.x, dy = a.y - b.y; const d2 = dx * dx + dy * dy + 0.01;
    if (d2 > 250000) continue;
    const f = (1800 / d2) * k; dx *= f; dy *= f; a.vx += dx; a.vy += dy; b.vx -= dx; b.vy -= dy;
  }
  for (const [ia, ib] of G.edges) {
    const a = G.byId[ia], b = G.byId[ib], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, f = ((d - 90) / d) * 0.05 * k;
    a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
  }
  for (const n of N) { n.vx -= n.x * 0.015 * k; n.vy -= n.y * 0.015 * k; if (n !== G.drag) { n.x += n.vx; n.y += n.vy; } n.vx *= 0.82; n.vy *= 0.82; }
  G.alpha = Math.max(0, G.alpha * 0.985 - 0.0005);
}
function fitView() {
  if (!G.nodes.length) return;
  const r = $("#graph").getBoundingClientRect(), pad = 60, xs = G.nodes.map((n) => n.x), ys = G.nodes.map((n) => n.y);
  const w = Math.max(...xs) - Math.min(...xs) || 1, h = Math.max(...ys) - Math.min(...ys) || 1;
  G.scale = Math.min(2, Math.max(0.25, Math.min((r.width - 2 * pad) / w, (r.height - 2 * pad) / h)));
  G.ox = r.width / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * G.scale; G.oy = r.height / 2 - ((Math.max(...ys) + Math.min(...ys)) / 2) * G.scale;
}
function loop() {
  if (view !== "brain") { G.running = false; return; }
  if (G.alpha > 0.01 || G.drag) { tick(); if (G.autoFit && G.alpha > 0.05) fitView(); draw(); }
  requestAnimationFrame(loop);
}
function resize() {
  // Size the bitmap in device pixels. devicePixelRatio can be below 1 (zoomed out, scaled panes).
  const c = $("#graph"), dpr = window.devicePixelRatio || 1, r = c.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  G.dpr = dpr; G.w = r.width; G.h = r.height;
}
window.addEventListener("resize", () => { if (view === "brain") { resize(); draw(); } });
new ResizeObserver(() => { if (view === "brain") { resize(); draw(); } }).observe($("#graph"));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const shortTitle = (t) => (t.length > 32 ? t.slice(0, 30).trimEnd() + "…" : t);
function draw() {
  const c = $("#graph"), ctx = c.getContext("2d"), fg = css("--fg"), dim = css("--dim"), bg = css("--bg");
  // Clear in raw device pixels so the whole bitmap is wiped whatever the pixel ratio is.
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height);
  const s = G.dpr * G.scale; ctx.setTransform(s, 0, 0, s, G.dpr * G.ox, G.dpr * G.oy);
  const focus = G.hover || G.sel, near = focus ? G.adj[focus] : null;
  const match = (n) => !G.filter || n.title.toLowerCase().includes(G.filter);
  const lit = (n) => (!focus || n.id === focus || near.has(n.id)) && match(n);
  const px = 1 / G.scale;
  ctx.lineCap = "round";
  for (const [ia, ib] of G.edges) {
    const a = G.byId[ia], b = G.byId[ib], on = focus && (ia === focus || ib === focus);
    ctx.strokeStyle = on ? fg : dim; ctx.globalAlpha = on ? 0.85 : focus || G.filter ? 0.3 : 0.55; ctx.lineWidth = (on ? 1.25 : 1) * px;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  const labels = [];
  for (const n of G.nodes) {
    const r = radius(n), on = lit(n);
    ctx.globalAlpha = on ? (n.status === "skipped" ? 0.45 : 1) : 0.35;
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 6.2832);
    ctx.fillStyle = bg; ctx.fill();  // knock out the edges behind the node
    if (n.folder === "Actions" && n.status !== "done") { ctx.strokeStyle = fg; ctx.lineWidth = 1.5 * px; ctx.stroke(); }
    else { ctx.fillStyle = n.folder === "Log" ? dim : fg; ctx.fill(); }
    if (n.id === G.sel) { ctx.beginPath(); ctx.arc(n.x, n.y, r + 4 * px + 1, 0, 6.2832); ctx.strokeStyle = fg; ctx.lineWidth = px; ctx.stroke(); }
    const few = G.nodes.length <= 24;
    if (on && (n.id === focus || near?.has(n.id) || (G.filter && match(n)) || (n.folder !== "Log" && (few || !n.folder || G.scale > 1.4 || n.deg >= 4)))) labels.push([n, r]);
  }
  // Labels last, with a halo in the background colour so lines never run through the text.
  ctx.globalAlpha = 1; ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.lineJoin = "round";
  for (const [n, r] of labels) {
    const strong = n.id === focus || !n.folder;
    ctx.font = `${strong ? 500 : 400} ${11.5 * px}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
    const t = shortTitle(n.title), y = n.y + r + 5 * px;
    ctx.strokeStyle = bg; ctx.lineWidth = 4 * px; ctx.strokeText(t, n.x, y);
    ctx.fillStyle = strong || (focus && near?.has(n.id)) ? fg : dim; ctx.fillText(t, n.x, y);
  }
  ctx.globalAlpha = 1;
}
const toWorld = (e) => { const r = $("#graph").getBoundingClientRect(); return { x: (e.clientX - r.left - G.ox) / G.scale, y: (e.clientY - r.top - G.oy) / G.scale }; };
function nodeAt(p) { let best = null, bd = 1e9; for (const n of G.nodes) { const d = Math.hypot(n.x - p.x, n.y - p.y); if (d < radius(n) + 6 / G.scale && d < bd) { best = n; bd = d; } } return best; }
const graph = $("#graph");
graph.addEventListener("pointerdown", (e) => {
  graph.setPointerCapture(e.pointerId); G.moved = false; G.touched = true; G.autoFit = false;
  const n = nodeAt(toWorld(e));
  if (n) { G.drag = n; G.alpha = Math.max(G.alpha, 0.3); } else G.pan = { x: e.clientX - G.ox, y: e.clientY - G.oy };
  graph.classList.add("dragging");
});
graph.addEventListener("pointermove", (e) => {
  const p = toWorld(e);
  if (G.drag) {
    // keep the dragged note inside the visible map
    const m = 24, lo = (o) => (m - o) / G.scale, hi = (size, o) => (size - m - o) / G.scale;
    G.drag.x = Math.min(hi(G.w, G.ox), Math.max(lo(G.ox), p.x)); G.drag.y = Math.min(hi(G.h, G.oy), Math.max(lo(G.oy), p.y));
    G.moved = true; draw(); return;
  }
  if (G.pan) { G.ox = e.clientX - G.pan.x; G.oy = e.clientY - G.pan.y; G.moved = true; draw(); return; }
  const n = nodeAt(p), id = n ? n.id : null;
  if (id !== G.hover) { G.hover = id; graph.title = n ? n.id : ""; draw(); }
});
graph.addEventListener("pointerup", () => { const n = G.drag; graph.classList.remove("dragging"); if (n && !G.moved) openNote(n.id); G.drag = null; G.pan = null; });
graph.addEventListener("wheel", (e) => {
  e.preventDefault(); G.touched = true; G.autoFit = false;
  const r = graph.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, s2 = Math.min(4, Math.max(0.25, G.scale * Math.exp(-e.deltaY * 0.0015)));
  G.ox = mx - ((mx - G.ox) * s2) / G.scale; G.oy = my - ((my - G.oy) * s2) / G.scale; G.scale = s2; draw();
}, { passive: false });
$("#brainSearch").oninput = (e) => { G.filter = e.target.value.trim().toLowerCase(); draw(); };
$("#brainSearch").onkeydown = (e) => { if (e.key === "Enter") { const n = G.nodes.find((x) => x.title.toLowerCase().includes(G.filter)); if (n) openNote(n.id); } };
$("#brainRefresh").onclick = () => loadBrain();
$("#brainShare").onclick = () => { if (G.nodes.length) showShare(brainCanvas(), "brain"); };

function linkTo(t) {
  const a = document.createElement("a");
  a.textContent = t.split("/").pop();
  a.onclick = () => { const hit = G.byId[t] || G.nodes.find((x) => x.title.toLowerCase() === t.split("/").pop().toLowerCase()); if (hit) openNote(hit.id); };
  return a;
}
async function openNote(id, quiet) {
  const n = await api(`/api/brain/note?path=${encodeURIComponent(id)}`).catch(() => null);
  if (!n) return;
  G.sel = n.id; draw();
  $("#noteFolder").textContent = n.id.includes("/") ? n.id.split("/")[0] : "note";
  $("#noteTitle").textContent = n.id.split("/").pop();
  $("#noteText").value = n.content; $("#noteText").dataset.id = n.id;
  $("#noteMode").disabled = false; $("#noteDelete").disabled = false;
  if (!quiet) $("#noteSaved").textContent = "";
  setNoteMode(noteMode);
  const links = [...new Set([...n.content.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim()))];
  $("#noteLinks").replaceChildren(...(links.length ? [document.createTextNode("Links: "), ...links.map(linkTo)] : []));
  $("#noteBacklinks").replaceChildren(...(n.backlinks.length ? [document.createTextNode("Linked from: "), ...n.backlinks.map(linkTo)] : []));
}
function setNoteMode(mode) {
  noteMode = mode;
  const has = !!$("#noteText").dataset.id, reading = mode === "read" || !has;
  $("#noteRead").hidden = !reading; $("#noteText").hidden = reading; $("#noteSave").hidden = reading;
  $("#noteMode").textContent = reading ? "Edit" : "Read";
  if (reading && has) {
    const src = $("#noteText").value.replace(/^---\n[\s\S]*?\n---\n/, (fm) => "```\n" + fm.replace(/^---\n|\n---\n$/g, "") + "\n```\n")
      .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, t, alias) => `<span class="wl" data-to="${esc(t.trim())}">${esc((alias || t.split("/").pop()).trim())}</span>`);
    $("#noteRead").innerHTML = md(src, { ADD_ATTR: ["data-to"] });
    $$(".wl", $("#noteRead")).forEach((w) => (w.onclick = () => linkTo(w.dataset.to).onclick()));
  }
}
$("#noteMode").onclick = () => setNoteMode(noteMode === "read" ? "edit" : "read");
$("#noteText").oninput = () => { $("#noteSaved").textContent = "Unsaved changes"; };
$("#noteSave").onclick = async () => {
  const id = $("#noteText").dataset.id;
  try { await api("/api/brain/note", { path: id, content: $("#noteText").value }); $("#noteSaved").textContent = "Saved"; toast("Saved"); loadBrain(); }
  catch (e) { $("#noteSaved").textContent = e.message; }
};
$("#noteDelete").onclick = async () => {
  const id = $("#noteText").dataset.id;
  if (!id || !confirm(`Delete "${id.split("/").pop()}"?\n\nIt goes to the trash (you can restore it), and links to it become plain text.`)) return;
  try {
    const d = await api("/api/brain/delete", { path: id, unlink: true });
    G.sel = null; delete $("#noteText").dataset.id; $("#noteText").value = "";
    $("#noteTitle").textContent = "Deleted"; $("#noteFolder").textContent = ""; $("#noteLinks").textContent = ""; $("#noteBacklinks").textContent = "";
    $("#noteMode").disabled = true; $("#noteDelete").disabled = true;
    $("#noteRead").innerHTML = `<p class="dim">${d.unlinked ? `Unlinked from ${d.unlinked} note${d.unlinked > 1 ? "s" : ""}. ` : ""}Restore it from Recently deleted.</p>`; setNoteMode("read");
    loadBrain();
  } catch (e) { toast(e.message); }
};
async function loadTrash() {
  const items = await api("/api/brain/trash").catch(() => []);
  $("#trashBox").hidden = !items.length;
  $("#trashList").replaceChildren(...items.slice(0, 20).map((it) => {
    const row = document.createElement("div"); row.className = "row"; row.style.margin = "4px 0";
    const name = document.createElement("span"); name.className = "grow"; name.textContent = it.id;
    const b = document.createElement("button"); b.className = "btn quiet sm"; b.textContent = "Restore";
    b.onclick = async () => { try { const d = await api("/api/brain/restore", { file: it.file }); await loadBrain(); openNote(d.id); } catch (e) { b.textContent = e.message; } };
    row.append(name, b); return row;
  }));
}
$("#reflectBtn").onclick = async () => {
  $("#reflectBtn").disabled = true; $("#brainStatus").textContent = "Reviewing your brain…";
  try {
    const { job } = await api("/api/brain/reflect", {});
    const v = await follow(job, (u) => { const l = [...u.log].reverse().find((e) => e.kind !== "think"); if (l) $("#brainStatus").textContent = logText(l).trim().slice(0, 140); });
    if (v.status === "error") throw new Error(v.error);
    $("#brainStatus").textContent = "Direction updated."; lift();
    await loadBrain(); openNote("Direction");
  } catch (e) { $("#brainStatus").textContent = e.message; }
  finally { $("#reflectBtn").disabled = false; }
};

// ---------------------------------------------------------------- Settings

let profileFiles = [];
async function loadSettings() {
  const [s] = await Promise.all([api("/api/settings"), workspace()]);
  const S = s.settings, el = $("#settings");
  const val = (sec, k) => S[sec][k].secret ? "" : S[sec][k].value || "";
  const keyField = (sec, k, label, hint = "") => `<label class="field">${label}${S[sec][k].set ? `<span class="from">saved ${S[sec][k].value}${S[sec][k].from === "env" ? " (from .env)" : ""}</span>` : ""}</label>
    <input type="password" data-sec="${sec}" data-k="${k}" placeholder="${S[sec][k].set ? "Leave blank to keep" : "Paste a key"}" autocomplete="off">${hint ? `<p class="hint">${hint}</p>` : ""}`;
  const text = (sec, k, label, placeholder = "") => `<label class="field">${label}</label><input data-sec="${sec}" data-k="${k}" value="${esc(val(sec, k))}" placeholder="${esc(placeholder)}">`;
  const wp = S.writer.provider.value, jp = S.judge.provider.value, preset = s.writers[wp] || {};
  el.innerHTML = `
    <div class="set"><div><h3>Writer</h3><p class="hint">The model that researches, plans and writes.</p></div><div>
      <div class="seg" id="writerSeg">${Object.entries(s.writers).map(([k, w]) => `<button data-p="${k}" aria-pressed="${k === wp}">${esc(w.label.replace(/ \(.*/, ""))}</button>`).join("")}</div>
      ${text("writer", "model", "Model", preset.model)}
      ${text("writer", "backup_model", "Backup model (used when the main one is overloaded or declines)", preset.backup || "optional")}
      ${wp === "bedrock" ? text("writer", "region", "AWS region", "from your AWS config") + text("writer", "aws_profile", "AWS profile", "default") + `<p class="hint">Uses your AWS CLI credentials (env vars, ~/.aws, SSO).</p>` : ""}
      ${wp === "anthropic" ? keyField("writer", "anthropic_api_key", "Anthropic API key", "console.anthropic.com") : ""}
      ${wp === "openai" ? text("writer", "base_url", "API URL", preset.base_url) + keyField("writer", "openai_api_key", "OpenAI API key") : ""}
      ${wp === "openrouter" ? keyField("writer", "openrouter_api_key", "OpenRouter API key", "One key for Claude, GPT, Gemini, Llama and more.") : ""}
      ${wp === "compatible" ? text("writer", "base_url", "Server URL", preset.base_url) + keyField("writer", "compatible_api_key", "API key (if the server needs one)") + `<p class="hint">Ollama, LM Studio, vLLM… In Docker use http://host.docker.internal:11434/v1.</p>` : ""}
      <div class="row" style="margin-top:14px"><button class="btn sm" data-save>Save</button><button class="btn ghost sm" data-test="writer">Test</button><span class="test" data-result="writer"></span></div>
    </div></div>
    <div class="set"><div><h3>Judge</h3><p class="hint">Jev decides what's worth doing and scores every draft.</p></div><div>
      <div class="seg" id="judgeSeg">${Object.entries(s.judges).map(([k, j]) => `<button data-p="${k}" aria-pressed="${k === jp}">${esc(j.label)}</button>`).join("")}</div>
      ${jp === "typesafe" ? keyField("judge", "typesafe_api_key", "TypeSafe API key", "From TypeSafe's developer console.") : keyField("judge", "openrouter_api_key", "OpenRouter API key", "Jev is billed to your OpenRouter account.")}
      ${text("judge", "model", "Model", s.judges[jp]?.model)}
      <div class="row" style="margin-top:14px"><button class="btn sm" data-save>Save</button><button class="btn ghost sm" data-test="judge">Test</button><span class="test" data-result="judge"></span></div>
    </div></div>
    <div class="set"><div><h3>You</h3><p class="hint">How Kite learns your voice. Paste your profile page, add screenshots, or an export (X archive <b>data/tweets.js</b>, CSV, JSON).</p></div><div>
      <div class="row"><select id="pPlatform" style="width:auto">${["x", "linkedin", "threads", "bluesky", "instagram", "tiktok", "youtube"].map((p) =>
        `<option value="${p}" ${p === (WS.platform || "x") ? "selected" : ""}>${{ x: "X", linkedin: "LinkedIn", threads: "Threads", bluesky: "Bluesky", instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" }[p]}</option>`).join("")}</select>
        <input id="pHandle" class="grow" placeholder="@handle (Bluesky fetches for free)" value="${esc(WS.handle || "")}"></div>
      <div class="clipper"><a class="btn ghost sm clipDrag" href="#">kite clipper</a>
        <span class="tiny dim grow">Collect your posts from any site. Drag it to your bookmarks bar, open your profile and click it.</span>
        <button class="btn quiet sm" id="clipHow">How to install</button></div>
      <textarea id="pPaste" style="margin-top:10px" placeholder="Paste your profile page (Cmd+A, Cmd+C on it) or what the kite clipper copied"></textarea>
      <div class="row" style="margin-top:8px"><button class="btn ghost sm" id="pAttach">Add files</button><input type="file" id="pFiles" multiple accept="image/*,.js,.json,.csv,.txt,.md" hidden>
        <span class="tiny dim grow" id="pFileList"></span><button class="btn sm" id="pRead">Read profile</button></div>
      <p class="tiny dim" id="pStatus"></p>
      <label class="field">Your profile (edit freely)</label><textarea id="pText" style="min-height:220px">${esc(WS.profile || "")}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn sm" id="pSave">Save profile</button></div>
    </div></div>
    <div class="set"><div><h3>Browser extension</h3><p class="hint">Lets threads find posts and set up replies in your own browser, where you're logged in. It never posts for you.</p></div><div>
      <div class="row"><span class="health" id="extDot"></span><span class="small grow" id="extState">Checking…</span>
        <button class="btn sm" id="extInstall">Install the extension</button></div>
    </div></div>
    <div class="set"><div><h3>Extras</h3><p class="hint">Optional.</p></div><div>
      ${keyField("research", "brave_api_key", "Brave Search key", "Adds general web search to research (free tier at brave.com/search/api).")}
      ${keyField("sources", "x_bearer_token", "X API bearer token", "Only for fetching X profiles directly (X API reads are paid). Pasting works without it.")}
      <div class="row" style="margin-top:14px"><button class="btn sm" data-save>Save</button></div>
    </div></div>
    <div class="set"><div><h3>Keyboard</h3></div><div class="small dim">1–4 switch views · 5 settings · n new plan · ⌘↵ send in a thread</div></div>`;
  let writer = wp, judge = jp;
  $$("#writerSeg button").forEach((b) => (b.onclick = async () => { writer = b.dataset.p; await api("/api/settings", { writer: { provider: writer, model: "", backup_model: "", base_url: "" } }); loadSettings(); }));
  $$("#judgeSeg button").forEach((b) => (b.onclick = async () => { judge = b.dataset.p; await api("/api/settings", { judge: { provider: judge, model: "" } }); loadSettings(); }));
  const collect = () => {
    const out = { writer: { provider: writer }, judge: { provider: judge }, research: {}, sources: {} };
    $$("[data-sec]", el).forEach((i) => { out[i.dataset.sec][i.dataset.k] = i.value; });
    return out;
  };
  $$("[data-save]", el).forEach((b) => (b.onclick = async () => { try { await api("/api/settings", collect()); toast("Saved"); loadSettings(); refreshHealth(); } catch (e) { toast(e.message); } }));
  $$("[data-test]", el).forEach((b) => (b.onclick = async () => {
    const part = b.dataset.test, out = $(`[data-result="${part}"]`);
    await api("/api/settings", collect());
    out.textContent = "Testing…";
    const r = await api("/api/settings/test", { part }).catch((e) => ({ ok: false, message: e.message }));
    out.textContent = `${r.ok ? "✓" : "✕"} ${r.message}`; refreshHealth();
  }));
  armClipLinks(el);
  $("#clipHow").onclick = () => showClipperGuide();
  $("#extInstall").onclick = () => showExtensionGuide();
  const extCheck = async () => {
    if (view !== "settings" || !$("#extState")) return;
    const b = await api("/api/bridge/status").catch(() => ({}));
    $("#extDot").classList.toggle("ok", !!b.connected);
    $("#extState").textContent = b.connected ? "Connected. Threads can find posts and open replies in your browser." : "Not installed yet. It takes about a minute.";
    $("#extInstall").textContent = b.connected ? "Reinstall" : "Install the extension";
    setTimeout(extCheck, 4000);
  };
  extCheck();
  $("#pPaste").addEventListener("input", () => {
    const v = $("#pPaste").value.trim();
    if (!v.startsWith('{"kite_clip"')) return;
    try {
      const c = JSON.parse(v);
      if (c.platform && $(`#pPlatform option[value="${c.platform}"]`)) $("#pPlatform").value = c.platform;
      $("#pStatus").textContent = c.page === "feed"
        ? `These ${c.posts.length} posts come from several accounts, not your profile. Paste them in a thread to reply to them, or clip your own profile.`
        : `${c.posts.length} posts from the clipper${c.url ? ` (${new URL(c.url).hostname})` : ""}. Hit Read profile.`;
    } catch { $("#pStatus").textContent = "That clipper block looks cut off. Copy it again."; }
  });
  $("#pAttach").onclick = () => $("#pFiles").click();
  $("#pFiles").onchange = async (e) => { profileFiles = profileFiles.concat(await readFiles(e.target.files)); $("#pFileList").textContent = profileFiles.map((f) => f.name).join(", "); };
  $("#pSave").onclick = async () => { await api("/api/workspace", { profile: $("#pText").value, platform: $("#pPlatform").value, handle: $("#pHandle").value }); toast("Profile saved"); };
  $("#pRead").onclick = async () => {
    $("#pRead").disabled = true;
    try {
      const { job } = await api("/api/profile", { platform: $("#pPlatform").value, handle: $("#pHandle").value.trim(), pasted: $("#pPaste").value, files: profileFiles });
      const v = await follow(job, (u) => { const l = u.log.at(-1); if (l) $("#pStatus").textContent = l.text; });
      if (v.status === "error") throw new Error(v.error);
      profileFiles = []; toast("Profile saved"); lift(); loadSettings();
    } catch (e) { $("#pStatus").textContent = e.message; }
    finally { const b = $("#pRead"); if (b) b.disabled = false; }
  };
  $("#dataPath").textContent = "data/";
  if (pendingProfileClip) { $("#pPaste").value = pendingProfileClip; pendingProfileClip = null; $("#pPaste").dispatchEvent(new Event("input")); $("#pPaste").scrollIntoView({ block: "center" }); }
}
async function refreshHealth() { setHealth(await api("/api/today")); }

// ---------------------------------------------------------------- kite clipper

let clipCode = null, pendingProfileClip = null, pendingThreadText = null;
async function armClipLinks(root = document) {
  // The bookmarklet is web/clipper.js with this Kite's address baked in, so "Send to Kite" finds its way back.
  try { clipCode ??= await (await fetch("/clipper.js")).text(); } catch { return; }
  $$(".clipDrag", root).forEach((a) => {
    a.href = `javascript:${encodeURIComponent(clipCode.replace("__KITE_ORIGIN__", location.origin))}`;
    a.onclick = (e) => { e.preventDefault(); toast("Drag it to your bookmarks bar"); };
  });
}
function openModal(inner, cls = "") {
  const ov = document.createElement("div"); ov.className = "share-ov";
  ov.innerHTML = `<div class="share-box ${cls}" role="dialog">${inner}</div>`;
  document.body.append(ov);
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  document.addEventListener("keydown", onKey);
  ov.onclick = (e) => { if (e.target === ov || e.target.closest("[data-close]")) close(); };
  return { el: ov, close };
}
function showClipperGuide() {
  const m = openModal(`
    <div class="guide-head"><b>kite clipper</b><span class="small dim">Collect posts from any site. No API, no login.</span></div>
    <div class="g-demo" aria-hidden="true">
      <div class="g-bar"><i></i><i></i><i></i><span>x.com/dev_brok</span></div>
      <div class="g-marks"><span>Docs</span><span>Mail</span><span class="g-slot">kite clipper</span></div>
      <div class="g-page"><span class="g-post"></span><span class="g-post"></span></div>
      <span class="g-pill">kite clipper</span>
    </div>
    <ol class="g-steps">
      <li><b>Show your bookmarks bar.</b> Press <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>B</kbd>, or Ctrl+Shift+B on Windows.</li>
      <li><b>Drag this onto the bar:</b> <a class="btn sm clipDrag" href="#">kite clipper</a></li>
      <li><b>Open the posts you want.</b> Your own profile teaches Kite your voice. A search or a thread gives you posts to reply to. Works on X, LinkedIn, Bluesky, Threads, Reddit and Mastodon.</li>
      <li><b>Click the bookmark.</b> It scrolls and collects, then <b>Send to Kite</b> asks where the posts should go.</li>
    </ol>
    <p class="small dim" style="margin:12px 0 0">Want Kite to do this by itself, and set up your replies too? <button class="btn quiet sm" id="gExt">Add the browser extension</button></p>
    <details class="g-alt"><summary>Can't drag it?</summary>
      <p class="small dim">Copy the code, add a new bookmark (right-click the bookmarks bar, then Add page), name it kite clipper and paste the code as its URL.</p>
      <button class="btn ghost sm" id="gCopy">Copy the code</button></details>
    <div class="row" style="margin-top:14px"><span class="grow"></span><button class="btn" data-close>Done</button></div>`, "guide");
  armClipLinks(m.el);
  $("#gExt", m.el).onclick = () => { m.close(); showExtensionGuide(); };
  $("#gCopy", m.el).onclick = async (e) => {
    await armClipLinks(m.el);
    try { await navigator.clipboard.writeText($(".clipDrag", m.el).href); e.target.textContent = "Copied"; } catch { toast("Couldn't copy; drag the button instead"); }
  };
}
const linkify = (html) => html.replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}</a>`);
function showExtensionGuide() {
  const m = openModal(`
    <div class="guide-head"><b>Kite browser extension</b><span class="small dim">Lets threads find posts and set up replies in your own browser. It never posts for you.</span></div>
    <div class="x-demo" aria-hidden="true">
      <div class="x-top"><b>Extensions</b><span class="x-dev">Developer mode <i class="x-toggle"><i></i></i></span></div>
      <div class="x-tools"><span class="x-load">Load unpacked</span><span>Pack extension</span><span>Update</span></div>
      <div class="x-card"><span class="x-icon"></span><span><b>Kite</b> 0.1.0<br><span class="dim">Lets your local Kite collect posts…</span></span></div>
    </div>
    <ol class="g-steps">
      <li><b>Download it</b> and double-click the zip to unzip it. <a class="btn sm" href="/kite-extension.zip" download>Download kite-extension.zip</a></li>
      <li><b>Open chrome://extensions</b> in a new tab. Works in Chrome, Edge, Brave and Arc. <button class="btn quiet sm" id="xCopy">Copy address</button></li>
      <li><b>Turn on Developer mode</b>, top right.</li>
      <li><b>Click Load unpacked</b> and pick the <b>kite-extension</b> folder.</li>
    </ol>
    <div class="x-status"><span class="health" id="xDot"></span><span id="xState">Waiting for the extension…</span></div>
    <p class="tiny dim" style="margin:10px 0 0">Browsers only let you add extensions from outside their store this way. Keep the folder where it is: Chrome loads it from there. If your browser ever asks about developer-mode extensions, keep Kite on.</p>
    <div class="row" style="margin-top:14px"><span class="grow"></span><button class="btn" data-close>Done</button></div>`, "guide");
  $("#xCopy", m.el).onclick = (e) => copy("chrome://extensions", e.target);
  let was = null;
  const check = async () => {
    if (!document.body.contains(m.el)) return;
    const b = await api("/api/bridge/status").catch(() => ({}));
    $("#xDot", m.el).classList.toggle("ok", !!b.connected);
    $("#xState", m.el).textContent = b.connected ? "Connected. You're all set: ask a thread to find posts to reply to." : "Waiting for the extension…";
    if (b.connected && was === false) lift();
    was = !!b.connected;
    setTimeout(check, 2000);
  };
  check();
}
function clipAsText(c) {
  const host = c.url ? new URL(c.url).hostname.replace(/^www\./, "") : "the clipper";
  return `Posts to reply to (from ${host}):\n\n` + c.posts.slice(0, 20).map((q, i) =>
    `${i + 1}. ${q.author ? `@${q.author}` : "post"}${q.likes != null ? ` (${q.likes} likes, ${q.replies ?? 0} replies)` : ""}:\n${q.text}${q.cut ? " …" : ""}${q.url ? `\n${q.url}` : ""}`).join("\n\n");
}
async function showClipChooser(c) {
  await workspace();
  const list = await api("/api/threads").catch(() => []);
  const host = c.url ? new URL(c.url).hostname.replace(/^www\./, "") : "the clipper";
  const authors = new Set(c.posts.map((p) => p.author).filter(Boolean)).size;
  const m = openModal(`
    <div class="guide-head"><b>${c.posts.length} posts from ${esc(host)}</b><span class="small dim">${c.page === "feed" ? `By ${authors || "several"} accounts. ` : ""}Where should they go?</span></div>
    <div class="choices">
      ${c.page === "profile" ? `<button class="choice" data-c="profile"><b>Teach Kite my voice</b><span>Use these as your own posts in your profile</span></button>` : ""}
      <button class="choice" data-c="new"><b>Reply to them</b><span>Start a thread: Kite drafts replies, Jev picks the best</span></button>
      ${list.slice(0, 4).map((t) => `<button class="choice" data-c="thread" data-id="${t.id}"><b>Add to a thread</b><span>${esc(t.action)}</span></button>`).join("")}
    </div>
    <div class="row" style="margin-top:14px"><span class="grow"></span><button class="btn quiet" data-close>Cancel</button></div>`, "guide");
  $$(".choice", m.el).forEach((b) => (b.onclick = async () => {
    m.close();
    if (b.dataset.c === "profile") { pendingProfileClip = JSON.stringify(c); return go("settings"); }
    if (b.dataset.c === "thread") { pendingThreadText = { id: b.dataset.id, text: clipAsText(c) }; return go("threads", b.dataset.id); }
    if (!WS.profile) { toast("Add your profile first"); return go("settings"); }
    try {
      const { thread } = await api("/api/thread", { action: `Reply to ${c.posts.length} posts from ${host}`, reason: "Collected with the kite clipper",
        platform: c.platform || WS.platform, profile: WS.profile, goal: WS.goal, digest: WS.digest, context: clipAsText(c), run: null });
      go("threads", thread);
    } catch (e) { toast(e.message); }
  }));
}
function takeIncomingClip() {
  // The clipper's "Send to Kite" opens #clip=<posts>. Read it, then clear it from the address bar.
  if (!location.hash.startsWith("#clip=")) return null;
  let c = null;
  try { c = JSON.parse(decodeURIComponent(location.hash.slice(6))); } catch { toast("Those posts didn't come through. Try Copy in the clipper."); }
  history.replaceState(null, "", `${location.pathname}${location.search}#today`);
  return c?.kite_clip && Array.isArray(c.posts) ? c : null;
}

const incoming = takeIncomingClip();
route();
if (incoming) showClipChooser(incoming);
