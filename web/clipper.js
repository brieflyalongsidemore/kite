/* Kite clipper: collects the posts on the page you're looking at, scrolling to load more, and hands them to Kite.
   No API, no login: it only reads what your browser already shows you. Two ways it runs:
   - as a bookmarklet you click (Settings turns this file into one), with a small panel;
   - quietly, when the Kite browser extension sets window.__kiteAuto and awaits window.__kiteAutoDone.
   extension/clipper.js is a copy of this file (a test keeps them identical). */
(() => {
  const AUTO = window.__kiteAuto;
  if (window.__kiteClip && !AUTO) return;
  const KITE = "__KITE_ORIGIN__";  // Kite fills in its own address when it builds the bookmark
  const host = location.hostname.replace(/^www\./, "");
  const num = (s) => {
    const m = String(s || "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([KkMm])?/);
    return m ? Math.round(parseFloat(m[1]) * (m[2] ? (/k/i.test(m[2]) ? 1e3 : 1e6) : 1)) : null;
  };
  const label = (el, sel) => { const n = el.querySelector(sel); return n ? num(n.getAttribute("aria-label") || n.textContent) : null; };
  // innerText puts inline links and @mentions on their own lines; join them back into the sentence.
  const href = (a) => (a?.href && /^https?:/.test(a.href) ? a.href.split("?")[0] : undefined);
  const text = (n) => (n ? (n.innerText || n.textContent || "").replace(/\n(@[\w.]+|#\w+|https?:\/\/\S+)\n/g, " $1 ").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : "");
  // Per-site hints; anything else falls back to <article> elements.
  const SITES = [
    { hosts: ["x.com", "twitter.com"], platform: "x", item: 'article[data-testid="tweet"]',
      text: (el) => [...el.querySelectorAll('[data-testid="tweetText"]')].find((n) => !n.closest('div[role="link"]')),
      author: (el) => (el.querySelector('[data-testid="User-Name"] a[href^="/"]')?.getAttribute("href") || "").slice(1).split("/")[0],
      cut: (el) => !!el.querySelector('[data-testid="tweet-text-show-more-link"]'),
      link: (el) => href([...el.querySelectorAll('a[href*="/status/"]')].find((a) => a.querySelector("time") && !a.closest('div[role="link"]'))),
      profile: () => !/^\/(search|home|explore|notifications|messages|i|hashtag|settings)(\/|$)/.test(location.pathname),
      skip: (el) => /repost|retweet/i.test(text(el.querySelector('[data-testid="socialContext"]'))),
      metrics: (el) => ({ replies: label(el, '[data-testid="reply"]'), reposts: label(el, '[data-testid="retweet"],[data-testid="unretweet"]'), likes: label(el, '[data-testid="like"],[data-testid="unlike"]') }) },
    { hosts: ["bsky.app"], platform: "bluesky", item: '[data-testid^="feedItem-by-"]', text: '[data-testid="postText"]',
      author: (el) => el.dataset.testid.replace("feedItem-by-", ""), profile: () => location.pathname.startsWith("/profile/"),
      link: (el) => href(el.querySelector('a[href*="/post/"]')),
      skip: (el) => /reposted by/i.test(text(el).slice(0, 80)),
      metrics: (el) => ({ replies: label(el, '[data-testid="replyBtn"]'), reposts: label(el, '[data-testid="repostCount"]'), likes: label(el, '[data-testid="likeCount"]') }) },
    { hosts: ["linkedin.com"], platform: "linkedin", item: ".feed-shared-update-v2", text: ".update-components-text, .feed-shared-inline-show-more-text",
      link: (el) => { const urn = el.closest("[data-urn]")?.dataset.urn || el.dataset.urn; return urn ? `https://www.linkedin.com/feed/update/${urn}/` : undefined; },
      skip: (el) => /reposted this/i.test(text(el.querySelector(".update-components-header"))),
      metrics: (el) => ({ likes: num(text(el.querySelector(".social-details-social-counts__reactions-count"))), replies: num(text(el.querySelector(".social-details-social-counts__comments"))) }) },
    { hosts: ["threads.net", "threads.com"], platform: "threads", item: "div[data-pressable-container]", text: 'div[dir="auto"] span, span[dir="auto"]',
      link: (el) => href(el.querySelector('a[href*="/post/"]')) },
    { hosts: ["reddit.com"], platform: "reddit", item: "shreddit-post, article", text: '[slot="title"], h3, [slot="text-body"]',
      link: (el) => (el.getAttribute("permalink") ? `https://www.reddit.com${el.getAttribute("permalink")}` : href(el.querySelector('a[href*="/comments/"]'))),
      metrics: (el) => ({ likes: num(el.getAttribute("score")), replies: num(el.getAttribute("comment-count")) }) },
  ];
  const site = SITES.find((s) => s.hosts.some((h) => host === h || host.endsWith(`.${h}`))) ||
    (document.querySelector(".status__content") ? { platform: "mastodon", item: ".status", text: ".status__content", skip: (el) => !!el.closest(".status__wrapper-reblog, .status--reblog"), link: (el) => href(el.querySelector("a.status__relative-time")) } : null) ||
    { platform: "", item: "article", text: null };

  const posts = new Map();
  const collect = () => {
    for (const el of document.querySelectorAll(site.item)) {
      if (site.skip?.(el)) continue;
      const body = typeof site.text === "function" ? text(site.text(el))
        : site.text ? [...el.querySelectorAll(site.text)].map(text).filter(Boolean).filter((t, i, a) => a.indexOf(t) === i).join("\n") : text(el);
      if (!body || body.length < 2 || posts.has(body)) continue;
      const author = site.author?.(el) || undefined, cut = site.cut?.(el) || undefined;
      const url = site.link ? site.link(el) : href(el.querySelector("a time")?.closest("a"));
      posts.set(body, { text: body.slice(0, 3000), url, author, cut, ...(site.metrics ? site.metrics(el) : {}) });
    }
  };

  const makeClip = (max) => {
    const list = [...posts.values()].slice(0, max), onProfile = site.profile ? site.profile() : true;
    const authors = new Set(list.map((p) => p.author).filter(Boolean));
    return { kite_clip: 1, platform: site.platform, url: location.href, page: onProfile && authors.size <= 1 ? "profile" : "feed", posts: list, authors: authors.size };
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (AUTO) {  // the extension: no panel, just collect and hand back
    window.__kiteAutoDone = (async () => {
      const max = Math.min(60, AUTO.limit || 25);
      let still = 0;
      for (let round = 0; round < 25 && posts.size < max && still < 3; round++) {
        const before = posts.size;
        collect();
        still = posts.size === before ? still + 1 : 0;
        window.scrollBy(0, window.innerHeight * 0.9);
        await sleep(1200);
      }
      collect();
      const clip = makeClip(max);
      delete clip.authors;
      return clip;
    })();
    return;
  }

  // A small panel so you can see progress and stop whenever you like.
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;width:320px;background:#0a0a0a;color:#f4f4f4;border:1px solid #333;border-radius:14px;padding:14px;font:13px/1.45 -apple-system,system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.4)";
  box.innerHTML = `<div style="font-weight:700;margin-bottom:6px">kite clipper</div><div id="kc-msg">Collecting posts…</div>
    <textarea id="kc-out" readonly style="display:none;width:100%;height:90px;margin-top:10px;background:#141414;color:#ddd;border:1px solid #333;border-radius:8px;font:11px ui-monospace,monospace"></textarea>
    <div style="display:flex;gap:8px;margin-top:10px"><button id="kc-act" style="flex:1;border:0;border-radius:999px;padding:7px 12px;background:#f4f4f4;color:#0a0a0a;font-weight:600;cursor:pointer">Stop here</button>
    <button id="kc-copy" style="display:none;border:1px solid #444;border-radius:999px;padding:7px 12px;background:none;color:#f4f4f4;cursor:pointer">Copy</button>
    <button id="kc-x" style="border:1px solid #444;border-radius:999px;padding:7px 12px;background:none;color:#f4f4f4;cursor:pointer">Close</button></div>`;
  document.body.append(box);
  window.__kiteClip = box;
  const msg = box.querySelector("#kc-msg"), out = box.querySelector("#kc-out"), act = box.querySelector("#kc-act"), copyBtn = box.querySelector("#kc-copy");
  let running = true;
  const finish = () => {
    running = false;
    const { authors, ...clip } = makeClip(200), list = clip.posts;
    let json = JSON.stringify(clip);
    while (json.length > 1_200_000 && clip.posts.length > 10) { clip.posts.length = Math.floor(clip.posts.length * 0.8); json = JSON.stringify(clip); }  // keep the link a sane size
    const cut = list.filter((p) => p.cut).length;
    msg.textContent = clip.page === "profile"
      ? `${clip.posts.length} posts ready${cut ? ` (${cut} cut short by the site)` : ""}.`
      : `${clip.posts.length} posts from ${authors || "several"} accounts, ready to reply to.`;
    const copy = async (btn) => {
      try { await navigator.clipboard.writeText(json); }
      catch { out.value = json; out.style.display = "block"; out.select(); document.execCommand("copy"); }
      btn.textContent = "Copied";
      msg.textContent += " Paste it into Kite.";
    };
    const canSend = !KITE.startsWith("__");
    act.textContent = canSend ? "Send to Kite" : "Copy for Kite";
    act.onclick = () => {
      if (!canSend) return copy(act);
      const tab = window.open(`${KITE}/#clip=${encodeURIComponent(json)}`, "_blank");
      msg.textContent = tab ? "Sent. Pick where the posts go in the Kite tab." : "Your browser blocked the new tab. Use Copy instead.";
    };
    copyBtn.style.display = canSend ? "block" : "none";
    copyBtn.onclick = () => copy(copyBtn);
  };
  act.onclick = finish;
  box.querySelector("#kc-x").onclick = () => { running = false; box.remove(); delete window.__kiteClip; };

  (async () => {
    let still = 0;
    for (let round = 0; running && round < 40 && posts.size < 200 && still < 3; round++) {
      const before = posts.size;
      collect();
      msg.textContent = `Collecting posts… ${posts.size} so far`;
      still = posts.size === before ? still + 1 : 0;
      window.scrollBy(0, window.innerHeight * 0.9);
      await sleep(1300);
    }
    collect();
    if (running) finish();
  })();
})();
