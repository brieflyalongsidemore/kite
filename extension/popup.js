const input = document.getElementById("kite");
const show = ({ connected }) => {
  document.getElementById("dot").classList.toggle("on", !!connected);
  document.getElementById("state").textContent = connected ? "Connected to Kite" : "Can't reach Kite. Is it running?";
};
chrome.storage.local.get(["kite", "connected"]).then((s) => { input.value = s.kite || ""; show(s); });
chrome.storage.onChanged.addListener((c) => { if (c.connected) show({ connected: c.connected.newValue }); });
input.addEventListener("change", async () => {
  await chrome.storage.local.set({ kite: input.value.trim() });
  chrome.runtime.sendMessage("poll").catch(() => {});
});
chrome.runtime.sendMessage("poll").catch(() => {});
