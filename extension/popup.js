const input = document.getElementById("kite");
const kiteUrl = async () => ((await chrome.storage.local.get("kite")).kite || "http://localhost:8788").replace(/\/+$/, "");

// Ask Kite directly, so the popup is right the moment it opens.
async function check() {
  const base = await kiteUrl();
  let text, on = false;
  try {
    const r = await fetch(`${base}/api/bridge/status`);
    const d = await r.json();
    on = r.ok && d.connected;
    text = on ? "Connected to Kite" : r.ok ? "Kite is running. Connecting…" : `Kite answered ${r.status}. Check the address below.`;
  } catch {
    text = `Can't reach Kite at ${base.replace(/^https?:\/\//, "")}. Is it running?`;
  }
  document.getElementById("dot").classList.toggle("on", on);
  document.getElementById("state").textContent = text;
}

chrome.storage.local.get("kite").then((s) => { input.value = s.kite || ""; });
input.addEventListener("change", async () => {
  await chrome.storage.local.set({ kite: input.value.trim() });
  chrome.runtime.sendMessage("poll").catch(() => {});
  check();
});
chrome.runtime.sendMessage("poll").catch(() => {});
check();
setInterval(check, 2000);
