"""HTTP: serves the web app from web/ and a small JSON API. Local only; there is no login."""

import json
import os
import re
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from . import agent, brain, bridge, config, extension, jev, llm, store, threads

WEB = config.ROOT / "web"
MAX_BODY = 40 * 1024 * 1024
# Kite has no login, so it only answers requests addressed to this machine. That blocks DNS rebinding;
# the Origin and Content-Type checks below block other websites posting to it through your browser.
ALLOWED_HOSTS = {"localhost", "127.0.0.1", "::1", "host.docker.internal"} | {
    h.strip() for h in os.environ.get("KITE_ALLOWED_HOSTS", "").split(",") if h.strip()}


def host_ok(value):
    return (urllib.parse.urlsplit(f"//{value}").hostname or "") in ALLOWED_HOSTS


def today():
    """Everything the Today screen needs in one call."""
    ws = store.workspace()
    latest = next((r for r in store.list_runs() if r["plan"]), None)
    run = store.job_or_run(latest["id"]) if latest else None
    final = (run or {}).get("final") or {}
    state = (run or {}).get("postState") or {}
    w_ok, w_info = llm.writer_status()
    j_ok, j_info = jev.status()
    return {
        "profile": bool(ws.get("profile")), "handle": ws.get("handle", ""), "platform": ws.get("platform", "x"), "goal": ws.get("goal", ""),
        "direction": brain.direction_summary(), "activity": brain.activity(),
        "run": {"id": latest["id"], "goal": latest["goal"], "created": latest["created"]} if latest else None,
        "actions": [{**a, "status": brain.action_status(a["text"]) or "todo"} for a in final.get("plan") or []],
        "posts": [p for p in final.get("posts") or [] if not state.get(p["text"])],
        "threads": threads.summaries()[:6],
        "writer": {"ok": w_ok, "info": w_info}, "judge": {"ok": j_ok, "info": j_info},
    }


def test_provider(part):
    """A tiny real request, so Settings can confirm a key works. Costs a fraction of a cent."""
    try:
        if part == "judge":
            data = jev.ask({"text": "The sky is blue."}, {"q": {"type": "noul", "instructions": "Is `text` about the weather or sky?"}})
            return {"ok": True, "message": f"Jev answered ({data['answers']['q']['noul']:.0%} yes)."}
        w = llm.writer()
        step = w.step([w.user("Reply with just: OK")], "Be brief.", {}, w.model)
        return {"ok": True, "message": f"{step.model or w.model} answered: {step.text[:40]!r}"}
    except Exception as exc:
        return {"ok": False, "message": agent.describe_error(exc)}


def brain_event(body):
    kind = body.get("type")
    if kind == "action":
        status = body["status"]
        if status not in ("todo", "in progress", "done", "skipped"):
            raise ValueError("unknown status")
        brain.action_update(body["action"], status=status, history=f"marked {status}" + (f": {body['note']}" if body.get("note") else ""))
        verb = {"done": "Did", "skipped": "Skipped"}.get(status, "Reopened")
        brain.log_event(f"{verb}: [[{brain.action_rel(body['action'])[:-3]}]]")
    elif kind == "posted":
        brain.brain_record_post(body["text"], body.get("kind"), body.get("viral"), body.get("action"))
        if body.get("run"):
            store.set_post_state(body["run"], body["text"], "posted")
    elif kind == "post_skipped":
        brain.log_event(f"Passed on a post idea: {body['text'][:140]!r}")
        if body.get("run"):
            store.set_post_state(body["run"], body["text"], "skipped")
    else:
        raise ValueError("unknown event")
    return {"ok": True}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def log_message(self, fmt, *args):
        if "/api/" not in (self.path or ""):
            super().log_message(fmt, *args)

    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def guard(self, write=False, from_extension=False):
        """True if the request may go ahead; otherwise answers 403 and returns False."""
        host, origin = self.headers.get("Host", ""), self.headers.get("Origin")
        why = None
        if not host_ok(host):
            why = "Kite only answers on localhost."
        elif from_extension:
            if self.headers.get("X-Kite-Bridge") != "1":
                why = "Only the Kite browser extension can use this."
            elif origin and not origin.startswith(("chrome-extension://", "moz-extension://")) and origin not in (f"http://{host}", f"https://{host}"):
                why = "Only the Kite browser extension can use this."
        elif write:
            if origin and origin not in (f"http://{host}", f"https://{host}"):
                why = "Requests from other websites aren't allowed."
            elif "application/json" not in self.headers.get("Content-Type", ""):
                why = "Send JSON."
        if why:
            self.send_json(403, {"error": why})
            return False
        return True

    # ---------------------------------------------------------------- GET
    def do_GET(self):
        path, _, query = self.path.partition("?")
        q = urllib.parse.parse_qs(query)
        if not self.guard():
            return None
        if path == "/kite-extension.zip":
            data = extension.zip_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Disposition", 'attachment; filename="kite-extension.zip"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return None
        if not path.startswith("/api/"):
            return super().do_GET()  # static files from web/ only
        if path == "/api/bridge/next":
            if not self.guard(from_extension=True):
                return None
            return self.send_json(200, bridge.next_task(int(q.get("wait", ["20"])[0] or 20)))
        routes = {
            "/api/bridge/status": bridge.status,
            "/api/today": today,
            "/api/settings": config.public_settings,
            "/api/workspace": store.workspace,
            "/api/runs": store.list_runs,
            "/api/threads": threads.summaries,
            "/api/brain": brain.brain_graph,
            "/api/brain/trash": brain.brain_trash,
        }
        if path in routes:
            return self.send_json(200, routes[path]())
        if path == "/api/brain/note":
            try:
                return self.send_json(200, brain.brain_note(q.get("path", [""])[0]))
            except RuntimeError as exc:
                return self.send_json(404, {"error": str(exc)})
        if m := re.fullmatch(r"/api/(?:job|runs)/([0-9a-f]+)", path):
            view = store.job_or_run(m.group(1), int(q.get("since", ["0"])[0]))
            return self.send_json(200, view) if view else self.send_json(404, {"error": "not found"})
        if m := re.fullmatch(r"/api/thread/([0-9a-f]+)", path):
            th = threads.THREADS.get(m.group(1))
            return self.send_json(200, threads.view(th)) if th else self.send_json(404, {"error": "no such thread"})
        return self.send_json(404, {"error": "not found"})

    # ---------------------------------------------------------------- POST
    def do_POST(self):
        if not self.guard(write=True, from_extension=self.path.startswith("/api/bridge/")):
            return None
        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_BODY:
            return self.send_json(413, {"error": "Upload too large (40 MB max). For an X archive, upload just data/tweets.js."})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self.send_json(400, {"error": "bad JSON"})
        try:
            return self.send_json(200, self.post(self.path, body))
        except (RuntimeError, KeyError, ValueError) as exc:
            return self.send_json(400, {"error": str(exc)})

    def post(self, path, body):
        # No model needed
        if path == "/api/bridge/done":
            return bridge.finish(body)
        if path == "/api/settings":
            return config.save_settings(body)
        if path == "/api/settings/test":
            return test_provider(body.get("part"))
        if path == "/api/workspace":
            return store.save_workspace(body)
        if path == "/api/brain/event":
            return brain_event(body)
        if path == "/api/brain/statuses":
            return {a: brain.action_status(a) for a in body.get("actions", [])}
        if path == "/api/brain/note":
            brain.brain_save(body["path"], body["content"])
            return brain.brain_note(body["path"])
        if path == "/api/brain/delete":
            return brain.brain_delete(body["path"], unlink=body.get("unlink", True))
        if path == "/api/brain/restore":
            return brain.brain_restore(body["file"])
        if m := re.fullmatch(r"/api/runs/([0-9a-f]+)/delete", path):
            store.delete_run(m.group(1))
            return {"ok": True}
        m = re.fullmatch(r"/api/thread/([0-9a-f]+)/(message|check|delete)", path)
        th = threads.THREADS.get(m.group(1)) if m else None
        if m and th is None:
            raise RuntimeError("No such thread.")
        if m and m.group(2) == "check":
            return threads.check(th, int(body.get("i", -1)), body.get("done"))
        if m and m.group(2) == "delete":
            threads.delete(th)
            return {"ok": True}
        # Needs the writer
        ok, why = llm.writer_status()
        if not ok:
            raise RuntimeError(why)
        if m:
            return {"thread": th["id"], "job": threads.send(th, body.get("text", ""), body.get("files"))["id"]}
        if path == "/api/thread":
            th, job = threads.create(body)
            return {"thread": th["id"], "job": job["id"]}
        if path == "/api/profile":
            return {"job": agent.profile_job(body)["id"]}
        if path == "/api/run":
            return {"job": agent.run_job(body)["id"]}
        if path == "/api/brain/reflect":
            return {"job": agent.reflect_job()["id"]}
        raise KeyError("not found")


def serve(host="127.0.0.1", port=8788):
    threads.load_all()
    brain.brain_ready()
    w_ok, w_info = llm.writer_status()
    j_ok, j_info = jev.status()
    print(f"Kite is running at http://{'localhost' if host in ('127.0.0.1', '0.0.0.0') else host}:{port}")
    print(f"  writer: {w_info}")
    print(f"  judge:  {j_info}")
    print(f"  data:   {config.DATA}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()
