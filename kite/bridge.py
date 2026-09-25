"""The bridge to the Kite browser extension (extension/). The agent asks for posts or a reply draft, and the
extension does it in the person's own browser, with their session, on their screen, then reports back.

The extension long-polls /api/bridge/next and answers on /api/bridge/done. Nothing is ever posted: a reply
is only typed into the post's reply box, and the person presses send."""

import threading
import time
import urllib.parse
import uuid

HOSTS = ("x.com", "twitter.com", "bsky.app", "linkedin.com", "threads.net", "threads.com", "reddit.com")
SEARCH = {
    "x": "https://x.com/search?q={q}&f=live",
    "bluesky": "https://bsky.app/search?q={q}",
    "linkedin": "https://www.linkedin.com/search/results/content/?keywords={q}&sortBy=%22date_posted%22",
    "threads": "https://www.threads.net/search?q={q}&serp_type=default",
    "reddit": "https://www.reddit.com/search/?q={q}&sort=new",
}
SEEN_FOR = 45  # seconds without a poll before the extension counts as gone

_tasks = {}
_cond = threading.Condition()
_seen = 0.0


def connected():
    return time.time() - _seen < SEEN_FOR


def status():
    return {"connected": connected(), "seen": _seen or None}


def allowed(url):
    """Only https pages on the social sites the extension knows how to read."""
    p = urllib.parse.urlparse(url or "")
    host = (p.hostname or "").removeprefix("www.")
    return p.scheme == "https" and any(host == h or host.endswith(f".{h}") for h in HOSTS)


def search_url(platform, query):
    template = SEARCH.get(platform)
    return template.format(q=urllib.parse.quote(query)) if template and query else ""


def run(kind, timeout, **task):
    """Queue a task for the extension and wait for its answer. Raises RuntimeError on failure or timeout."""
    if not connected():
        raise RuntimeError("the Kite browser extension isn't connected")
    tid = uuid.uuid4().hex[:12]
    deadline = time.time() + timeout
    with _cond:
        _tasks[tid] = {"id": tid, "kind": kind, "state": "queued", "created": time.time(), **task}
        _cond.notify_all()
        while _tasks[tid]["state"] != "done":
            left = deadline - time.time()
            if left <= 0:
                _tasks.pop(tid, None)
                raise RuntimeError("the browser didn't answer in time")
            _cond.wait(left)
        done = _tasks.pop(tid)
    if not done.get("ok"):
        raise RuntimeError(done.get("error") or "the browser couldn't do it")
    return done.get("result")


def next_task(wait=20):
    """Long-poll from the extension: hand over the oldest queued task, or {} after `wait` seconds."""
    global _seen
    deadline = time.time() + max(0, min(25, wait))
    with _cond:
        while True:
            _seen = time.time()
            queued = sorted((t for t in _tasks.values() if t["state"] == "queued"), key=lambda t: t["created"])
            if queued:
                t = queued[0]
                t["state"] = "taken"
                return {k: t[k] for k in ("id", "kind", "url", "text", "limit") if k in t}
            left = deadline - time.time()
            if left <= 0:
                return {}
            _cond.wait(min(left, 5))


def finish(body):
    with _cond:
        t = _tasks.get(str(body.get("id", "")))
        if not t or t["state"] != "taken":
            raise RuntimeError("no such task")
        t.update(state="done", ok=bool(body.get("ok")), result=body.get("result"), error=str(body.get("error") or "")[:300])
        _cond.notify_all()
    return {"ok": True}
