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
  body.innerHTML = `
    <div class="block"><h2><span class="grow">Focus${t.actions.length ? ` · ${doneCount}/${t.actions.length} done` : ""}</span>
      <button class="btn quiet sm" id="seePlan">Full plan →</button></h2>
      <div class="focus" id="focus"></div></div>
    <div class="block" id="deckBlock"><h2><span class="grow">Ready to post</span><span class="pager" id="pager"></span></h2><div class="deck" id="deck"></div></div>
    <div class="block" id="inProgress"></div>
    <div class="block row"><button class="btn ghost" id="newPlan">New plan</button><span class="tiny dim">Current: ${esc(t.run.goal)} · ${new Date(t.run.created * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}</span></div>`;
  $("#seePlan").onclick = () => go("plan", t.run.id);
  $("#newPlan").onclick = () => { go("plan"); setTimeout(() => $("#goal").focus(), 50); };
  const focus = $("#focus");
  const ordered = [...open.slice(0, 3), ...t.actions.filter((a) => a.status === "done" || a.status === "skipped")];
  ordered.forEach((a) => focus.append(actionRow(a, t.run.id, () => loadToday())));
  if (!open.length) focus.insertAdjacentHTML("beforeend", `<div class="alldone">All done. Nice work. <button class="btn quiet sm" id="again">Make the next plan</button></div>`);
  $("#again")?.addEventListener("click", () => go("plan"));
  deckIndex = Math.min(deckIndex, Math.max(0, t.posts.length - 1));
  renderDeck(t.posts, t.run.id);
  if (t.threads.length) {
    $("#inProgress").innerHTML = `<h2>Threads</h2><div class="list">${t.threads.slice(0, 4).map((th) =>
      `<button data-th="${th.id}">${esc(th.action)}<span class="sub">${th.total ? `${th.done}/${th.total} steps` : "just started"}${th.busy ? " · working" : ""}</span></button>`).join("")}</div>`;
    $$("#inProgress [data-th]").forEach((b) => (b.onclick = () => go("threads", b.dataset.th)));
  }
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

function actionRow(a, runId, after) {
  const el = document.createElement("div");
  el.className = `act ${a.status === "done" ? "done" : ""} ${a.status === "skipped" ? "skipped" : ""}`;
  const s = a.scores || {};
  el.innerHTML = `<button class="check" aria-label="Mark done">${CHECK}</button>
    <div><div class="what"></div>${a.reason ? `<div class="why">${esc(a.reason)}</div>` : ""}
      <div class="meta">Jev priority ${Math.round(a.priority || 0)}${a.first != null ? ` · first-move odds ${pct(a.first)}` : ""}${s.effort != null ? ` · effort ${s.effort.toFixed(1)}/4` : ""}${a.risk != null ? ` · risk ${pct(a.risk)}` : ""}</div></div>
    <div class="side">${a.status === "in progress" ? '<span class="chip">in progress</span>' : ""}
      <button class="btn ghost sm work">Work on it →</button>
      <button class="btn quiet sm skip">${a.status === "skipped" ? "Undo skip" : "Skip"}</button></div>`;
  $(".what", el).textContent = a.text;
  const set = async (status) => {
    try { await api("/api/brain/event", { type: "action", action: a.text, status }); } catch (e) { return toast(e.message); }
    if (status === "done") { lift(); toast("Nice. Saved to your brain."); }
    after();
  };
  $(".check", el).onclick = () => set(a.status === "done" ? "todo" : "done");
  $(".skip", el).onclick = () => set(a.status === "skipped" ? "todo" : "skipped");
  $(".work", el).onclick = () => newThread(a, runId);
  return el;
}

function postCard(p, runId, onDone) {
  const el = document.createElement("div");
  el.className = "post";
  const s = p.scores || {};
  el.innerHTML = `${p.kind ? `<div class="kind">${esc(p.kind)}</div>` : ""}<div class="text"></div>
    ${p.reason ? `<div class="why">${esc(p.reason)}</div>` : ""}
    <div class="bars">${Object.entries(DIMS).map(([k, l]) => `<div>${l}<span><b style="width:${((s[k] || 0) / 4) * 100}%"></b></span></div>`).join("")}</div>
    <div class="foot"><span class="score">${Math.round(p.viral)}<small>Jev</small></span>
      <span class="tiny dim grow">${[p.h2h != null ? `head-to-head ${pct(p.h2h)}` : "", `breakout ${pct(p.breakout)}`, `bait ${pct(p.bait)}`, p.rehash ? `rehash ${pct(p.rehash)}` : ""].filter(Boolean).join(" · ")}</span>
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
  el.innerHTML = `
    <h1>${esc(v.meta?.goal || "Plan")}</h1>
    <div class="row small dim">${running ? '<span class="working"><i></i><i></i><i></i></span> Working on it' : v.status === "error" ? "Stopped" : "Done"}
      · ${new Date((v.meta?.created || 0) * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
      · Jev ${v.cost.jevCalls} calls${(v.cost.llm ?? v.cost.claude) ? ` · ≈ $${((v.cost.llm ?? v.cost.claude) + v.cost.jev).toFixed(2)}` : ""}
      <span class="grow"></span>${running ? "" : `<button class="btn quiet sm" id="delRun">Remove</button>`}</div>
    ${v.error ? `<p class="small" style="margin-top:10px"><b>${esc(v.error)}</b></p>` : ""}
    <details class="log block" ${running || wasOpen ? "open" : ""}><summary>${running ? "What Kite is doing" : "How Kite got here"} (${log.length} steps)</summary><div class="logbox"></div></details>
    ${v.mix?.length ? `<div class="block"><h2>Mix</h2><div class="mixbar">${v.mix.map((m) => `<i style="width:${m.share * 100}%" title="${esc(m.kind)}"></i>`).join("")}</div>
      <div class="mixlegend">${v.mix.map((m) => `<div><b>${pct(m.share)}</b><span>${esc(m.kind)}</span></div>`).join("")}</div></div>` : ""}
    ${v.ideas?.length ? `<div class="block"><h2>Ideas</h2><div class="ideas">${v.ideas.slice(0, 8).map((i) => `<div class="idea"><span class="p">${Math.round(i.priority)}</span>
      <div>${esc(i.text)}${i.basis ? `<div class="b">${esc(i.basis)}</div>` : ""}</div></div>`).join("")}</div></div>` : ""}
    ${plan.length ? `<div class="block"><h2>${final.plan ? "Plan" : "Actions so far"}</h2><div class="focus" id="planActs"></div></div>` : ""}
    ${posts.length ? `<div class="block"><h2>${final.posts ? "Posts" : "Best drafts so far"}</h2><div class="stack" id="planPosts"></div></div>` : ""}`;
  const box = $(".logbox", el);
  box.innerHTML = log.map((e) => `<div class="${e.kind}">${esc(logText(e))}</div>`).join("");
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
      <div class="row" style="margin-top:8px"><button class="btn ghost sm" id="tAttach">Attach</button><input type="file" id="tFile" multiple accept="image/*,.txt,.csv,.json,.md" hidden>
        <span class="tiny dim grow" id="tStatus">${th.cost ? `≈ $${th.cost.toFixed(2)} so far · ` : ""}⌘↵ to send</span>
        <button class="btn quiet sm" id="tDelete">Delete</button><button class="btn" id="tSend" ${th.busy ? "disabled" : ""}>Send</button></div>
    </div>`;
  $("#tInput").value = draft;
  const cl = $("#checklist");
  cl.innerHTML = th.checklist.map((c, i) => `<label class="${c.done ? "done" : ""}"><input type="checkbox" data-i="${i}" ${c.done ? "checked" : ""}><span>${esc(c.text)}</span></label>`).join("");
  $$("input", cl).forEach((box) => (box.onchange = async () => {
    const t = await api(`/api/thread/${th.id}/check`, { i: +box.dataset.i, done: box.checked });
    if (box.checked) lift();
    renderThread(t);
  }));
  const chat = $("#chat");
  for (const m of th.display) {
    if (m.role === "user" && !m.hidden) chat.insertAdjacentHTML("beforeend", `<div class="msg user"><div class="who">You</div><div class="body">${esc(m.text)}${m.images ? `\n[${m.images} screenshot${m.images > 1 ? "s" : ""}]` : ""}</div></div>`);
    else if (m.role === "claude") chat.insertAdjacentHTML("beforeend", `<div class="msg"><div class="who">Kite</div><div class="body md">${md(m.text)}</div></div>`);
    else if (m.role === "cards") chat.append(cardsEl(m, th));
  }
  $("#tAttach").onclick = () => $("#tFile").click();
  $("#tFile").onchange = async (e) => { threadFiles = threadFiles.concat(await readFiles(e.target.files)); $("#tStatus").textContent = `${threadFiles.length} attached`; };
  $("#tSend").onclick = () => sendThread(th.id);
  $("#tInput").onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendThread(th.id); };
  $("#tDelete").onclick = async () => { if (!confirm("Delete this thread?")) return; await api(`/api/thread/${th.id}/delete`, {}); go("threads"); };
}

function cardsEl(m, th) {
  const el = document.createElement("div");
  el.className = "msg";
  const head = { replies: "Replies to", posts: "Posts", choice: "Jev's pick" }[m.kind] || "";
  el.innerHTML = `<div class="who">Jev · ${esc(head)}</div>${m.kind === "replies" ? `<p class="small dim" style="margin:0 0 8px">${esc(m.title)}</p>` : m.kind === "choice" ? `<p class="small dim" style="margin:0 0 8px">${esc(m.title)}</p>` : ""}<div class="opts"></div>`;
  const items = [...m.items].sort((a, b) => (b.score ?? b.viral ?? b.p ?? 0) - (a.score ?? a.viral ?? a.p ?? 0));
  items.forEach((it, i) => {
    const o = document.createElement("div");
    o.className = `opt ${i === 0 ? "best" : ""}`;
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
  return el;
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
const radius = (n) => (n.folder === "Log" ? 3 : 4 + Math.min(10, Math.sqrt(n.deg) * 2.2));
function tick() {
  const N = G.nodes, k = G.alpha;
  for (let i = 0; i < N.length; i++) for (let j = i + 1; j < N.length; j++) {
    const a = N[i], b = N[j]; let dx = a.x - b.x, dy = a.y - b.y; const d2 = dx * dx + dy * dy + 0.01;
    if (d2 > 250000) continue;
    const f = (1100 / d2) * k; dx *= f; dy *= f; a.vx += dx; a.vy += dy; b.vx -= dx; b.vy -= dy;
  }
  for (const [ia, ib] of G.edges) {
    const a = G.byId[ia], b = G.byId[ib], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, f = ((d - 75) / d) * 0.06 * k;
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
  const c = $("#graph"), dpr = window.devicePixelRatio || 1, r = c.getBoundingClientRect();
  c.width = r.width * dpr; c.height = r.height * dpr; G.dpr = dpr;
}
window.addEventListener("resize", () => { if (view === "brain") { resize(); draw(); } });
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function draw() {
  const c = $("#graph"), ctx = c.getContext("2d"), fg = css("--fg"), dim = css("--faint"), bg = css("--bg");
  ctx.setTransform(G.dpr, 0, 0, G.dpr, 0, 0); ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height);
  ctx.translate(G.ox, G.oy); ctx.scale(G.scale, G.scale);
  const focus = G.hover || G.sel, near = focus ? G.adj[focus] : null;
  const match = (n) => !G.filter || n.title.toLowerCase().includes(G.filter);
  const lit = (n) => (!focus || n.id === focus || near.has(n.id)) && match(n);
  for (const [ia, ib] of G.edges) {
    const a = G.byId[ia], b = G.byId[ib], on = focus && (ia === focus || ib === focus);
    ctx.strokeStyle = on ? fg : dim; ctx.globalAlpha = on ? 0.9 : focus || G.filter ? 0.1 : 0.35; ctx.lineWidth = 1 / G.scale;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  for (const n of G.nodes) {
    const r = radius(n), on = lit(n);
    ctx.globalAlpha = on ? (n.status === "skipped" ? 0.35 : 1) : 0.12;
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 6.2832);
    if (n.folder === "Actions" && n.status !== "done") { ctx.fillStyle = bg; ctx.fill(); ctx.strokeStyle = fg; ctx.lineWidth = 1.5 / G.scale; ctx.stroke(); }
    else { ctx.fillStyle = n.folder === "Log" ? dim : fg; ctx.fill(); }
    if (n.id === G.sel) { ctx.beginPath(); ctx.arc(n.x, n.y, r + 4, 0, 6.2832); ctx.strokeStyle = fg; ctx.lineWidth = 1 / G.scale; ctx.stroke(); }
    if (on && (n.id === focus || near?.has(n.id) || G.scale > 1.3 || n.deg >= 4 || (G.filter && match(n)))) {
      ctx.fillStyle = fg; ctx.font = `${12 / Math.max(1, G.scale * 0.8)}px system-ui, sans-serif`; ctx.textAlign = "center";
      ctx.fillText(n.title.length > 38 ? n.title.slice(0, 36) + "…" : n.title, n.x, n.y + r + 13 / G.scale);
    }
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
  if (G.drag) { G.drag.x = p.x; G.drag.y = p.y; G.moved = true; draw(); return; }
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
      <textarea id="pPaste" style="margin-top:10px" placeholder="Paste your profile page (Cmd+A, Cmd+C on it)"></textarea>
      <div class="row" style="margin-top:8px"><button class="btn ghost sm" id="pAttach">Add files</button><input type="file" id="pFiles" multiple accept="image/*,.js,.json,.csv,.txt,.md" hidden>
        <span class="tiny dim grow" id="pFileList"></span><button class="btn sm" id="pRead">Read profile</button></div>
      <p class="tiny dim" id="pStatus"></p>
      <label class="field">Your profile (edit freely)</label><textarea id="pText" style="min-height:220px">${esc(WS.profile || "")}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn sm" id="pSave">Save profile</button></div>
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
}
async function refreshHealth() { setHealth(await api("/api/today")); }

route();
