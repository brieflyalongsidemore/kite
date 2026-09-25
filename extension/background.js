/* Kite extension: waits for jobs from your local Kite and does them in this browser, where you're logged in.
   - "clip": open a page in a small window, collect its posts with clipper.js, close it, hand the posts back.
   - "reply": open a post and type Kite's reply into its reply box. It never presses send; you do. */

const DEFAULT_KITE = "http://localhost:8788";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kiteUrl = async () => ((await chrome.storage.local.get("kite")).kite || DEFAULT_KITE).replace(/\/+$/, "");
const setState = (connected) => chrome.storage.local.set({ connected, checked: Date.now() });

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    // Long-poll for a while; the alarm below restarts this if the browser put the worker to sleep.
    for (let i = 0; i < 40; i++) {
      const base = await kiteUrl();
      let task;
      try {
        const r = await fetch(`${base}/api/bridge/next?wait=20`, { headers: { "X-Kite-Bridge": "1" } });
        if (!r.ok) throw new Error(`Kite answered ${r.status}`);
        task = await r.json();
        await setState(true);
      } catch {
        await setState(false);
        await sleep(5000);
        continue;
      }
      if (task?.id) await runTask(task, base);
    }
  } finally {
    polling = false;
  }
}
chrome.alarms.create("kite", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(poll);
chrome.runtime.onStartup.addListener(poll);
chrome.runtime.onInstalled.addListener(poll);
chrome.runtime.onMessage.addListener((msg) => { if (msg === "poll") poll(); });
poll();

async function runTask(task, base) {
  let answer;
  try {
    answer = { ok: true, result: task.kind === "clip" ? await clip(task) : task.kind === "reply" ? await reply(task) : null };
  } catch (e) {
    answer = { ok: false, error: String(e?.message || e) };
  }
  await fetch(`${base}/api/bridge/done`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Kite-Bridge": "1" },
    body: JSON.stringify({ id: task.id, ...answer }),
  }).catch(() => {});
}

function loaded(tabId, ms = 30000) {
  return new Promise((resolve, reject) => {
    const done = (fn) => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(watch); fn(); };
    const timer = setTimeout(() => done(() => reject(new Error("the page took too long to load"))), ms);
    const watch = (id, info) => { if (id === tabId && info.status === "complete") done(resolve); };
    chrome.tabs.onUpdated.addListener(watch);
  });
}

async function clip(task) {
  // A small window of its own: pages only load more posts while they're actually on screen.
  const win = await chrome.windows.create({ url: task.url, type: "popup", focused: false, width: 520, height: 900, left: 40, top: 40 });
  const tabId = win.tabs[0].id;
  try {
    await loaded(tabId);
    await sleep(2500);
    await chrome.scripting.executeScript({ target: { tabId }, func: (limit) => { window.__kiteAuto = { limit }; }, args: [task.limit || 25] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["clipper.js"] });
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.__kiteAutoDone });
    if (!result) throw new Error("no posts found on the page");
    return result;
  } finally {
    chrome.windows.remove(win.id).catch(() => {});
  }
}

async function reply(task) {
  const tab = await chrome.tabs.create({ url: task.url, active: true });
  await loaded(tab.id);
  await sleep(2500);
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fillReply, args: [task.text] });
  return result;
}

// Runs inside the post's page. Types the reply into the reply box and shows a note; never clicks send.
async function fillReply(text) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const find = async (sel, ms = 8000) => { for (let t = 0; t < ms; t += 250) { const n = document.querySelector(sel); if (n) return n; await sleep(250); } return null; };
  const note = (message, withCopy) => {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;z-index:2147483647;right:16px;top:16px;width:340px;background:#0a0a0a;color:#f4f4f4;border:1px solid #333;border-radius:14px;padding:14px;font:13px/1.45 -apple-system,system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.4)";
    box.innerHTML = `<div style="font-weight:700;margin-bottom:6px">kite</div><div></div>
      ${withCopy ? '<textarea readonly style="width:100%;height:110px;margin-top:10px;background:#141414;color:#ddd;border:1px solid #333;border-radius:8px;font:12px -apple-system,system-ui,sans-serif"></textarea>' : ""}
      <div style="display:flex;gap:8px;margin-top:10px">${withCopy ? '<button data-copy style="flex:1;border:0;border-radius:999px;padding:7px 12px;background:#f4f4f4;color:#0a0a0a;font-weight:600;cursor:pointer">Copy reply</button>' : ""}
      <button data-x style="border:1px solid #444;border-radius:999px;padding:7px 12px;background:none;color:#f4f4f4;cursor:pointer">Close</button></div>`;
    box.children[1].textContent = message;
    const area = box.querySelector("textarea");
    if (area) area.value = text;
    box.querySelector("[data-copy]")?.addEventListener("click", async (e) => {
      try { await navigator.clipboard.writeText(text); } catch { area.select(); document.execCommand("copy"); }
      e.target.textContent = "Copied";
    });
    box.querySelector("[data-x]").onclick = () => box.remove();
    document.body.append(box);
  };
  const host = location.hostname.replace(/^www\./, "");
  let input = null;
  if (/(^|\.)(x|twitter)\.com$/.test(host)) {
    input = await find('[data-testid="tweetTextarea_0"]', 5000);  // a post's page has an inline reply box
    if (!input) { document.querySelector('article [data-testid="reply"]')?.click(); input = await find('[data-testid="tweetTextarea_0"]'); }
  } else if (host.endsWith("bsky.app")) {
    document.querySelector('[data-testid="replyBtn"]')?.click();
    input = await find('[contenteditable="true"]');
  } else if (host.endsWith("linkedin.com")) {
    document.querySelector('button[aria-label*="omment"]')?.click();
    input = await find('.ql-editor[contenteditable="true"], [contenteditable="true"][role="textbox"]');
  } else if (/threads\.(net|com)$/.test(host)) {
    input = await find('[contenteditable="true"][role="textbox"]', 5000);
  }
  if (input) {
    input.click();
    input.focus();
    document.execCommand("insertText", false, text);
    if ((input.innerText || input.value || "").includes(text.slice(0, 15))) {
      note("Kite typed its reply in. Read it, change anything you like, then press Reply yourself.", false);
      return { ok: true };
    }
  }
  note("Couldn't fill the reply box on this page. Copy the reply and paste it in.", true);
  return { ok: true, manual: true };
}
