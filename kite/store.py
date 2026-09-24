"""Background jobs, and everything saved under the data folder: runs, the workspace, threads."""

import json
import re
import threading
import time
import uuid

from .config import DATA

RUNS = DATA / "runs"
THREADS_DIR = DATA / "threads"
WORKSPACE = DATA / "workspace.json"
WORKSPACE_KEYS = ("platform", "handle", "profile", "digest", "top", "goal", "lastRun")
JOBS = {}
_ws_lock = threading.Lock()


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data))
    tmp.replace(path)  # atomic: a crash mid-write never leaves half a file


def read_json(path, default=None):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def valid_id(value):
    return bool(re.fullmatch(r"[0-9a-f]{6,32}", value or ""))


# ---------------------------------------------------------------- jobs

def new_job(kind):
    job = {"id": uuid.uuid4().hex[:10], "kind": kind, "status": "running", "started": time.time(), "log": [],
           "drafts": {}, "actions": {}, "ideas": {}, "mix": [], "h2h": {}, "final": None, "error": None,
           "profile": None, "digest": None, "top": None, "baseline": None, "meta": {}, "postState": {},
           "jevCalls": 0, "jevCost": 0.0, "llmTokens": 0, "llmCost": 0.0}
    JOBS[job["id"]] = job
    return job


def logger(job):
    def log(kind, text, **kw):
        job["log"].append({"t": round(time.time() - job["started"], 1), "kind": kind, "text": text, **kw})
    return log


def count_jev(job, result):
    job["jevCalls"] += 1
    job["jevCost"] += result.get("cost", 0) or 0


def count_llm(job):
    def usage(step):
        job["llmTokens"] += step.input_tokens + step.output_tokens
        job["llmCost"] += step.cost or 0
    return usage


def start(job, fn, describe_error, after=None):
    def wrapped():
        try:
            fn()
            job["status"] = "done"
        except Exception as exc:
            job["error"] = describe_error(exc)
            job["status"] = "error"
        finally:
            if after:
                after()
    threading.Thread(target=wrapped, daemon=True).start()


def job_view(job, since=0):
    posts = sorted(job["drafts"].items(), key=lambda kv: kv[1]["viral"], reverse=True)
    acts = sorted(job["actions"].items(), key=lambda kv: kv[1]["priority"], reverse=True)
    ideas = sorted(job["ideas"].items(), key=lambda kv: kv[1]["priority"], reverse=True)
    return {
        "id": job["id"], "kind": job["kind"], "meta": job.get("meta", {}), "status": job["status"], "error": job["error"],
        "log": job["log"][since:], "next": len(job["log"]),
        "profile": job["profile"], "digest": job["digest"], "top": job["top"], "baseline": job["baseline"],
        "final": job["final"], "postState": job.get("postState", {}),
        "drafts": [{"text": t, "h2h": job["h2h"].get(t), **r} for t, r in posts[:20]],
        "actions": [{"text": t, **r} for t, r in acts[:15]],
        "ideas": [{"text": t, **r} for t, r in ideas[:15]],
        "mix": job["mix"],
        "cost": {"jevCalls": job["jevCalls"], "jev": job["jevCost"], "llmTokens": job["llmTokens"], "llm": job["llmCost"]},
    }


# ---------------------------------------------------------------- runs

def save_run(job):
    view = job_view(job)
    view["saved"] = time.time()
    write_json(RUNS / f"{job['id']}.json", view)


def load_run(rid):
    return read_json(RUNS / f"{rid}.json") if valid_id(rid) else None


def job_or_run(rid, since=0):
    """A live job, or the saved run if the server restarted since."""
    job = JOBS.get(rid)
    if job:
        return job_view(job, since)
    run = load_run(rid)
    if run is None:
        return None
    if run.get("status") == "running":
        run.update(status="error", error="Kite restarted during this run; showing what it saved.")
    return {**run, "log": run.get("log", [])[since:], "next": len(run.get("log", []))}


def list_runs():
    out = []
    for p in RUNS.glob("*.json") if RUNS.exists() else []:
        r = read_json(p)
        if not r:
            continue
        meta, final = r.get("meta", {}), r.get("final") or {}
        status = r.get("status")
        if status == "running" and r.get("id") not in JOBS:
            status = "error"
        out.append({"id": r.get("id", p.stem), "goal": meta.get("goal", ""), "platform": meta.get("platform", ""),
                    "created": meta.get("created", r.get("saved", 0)), "status": status,
                    "plan": len(final.get("plan") or []), "posts": len(final.get("posts") or [])})
    return sorted(out, key=lambda r: -(r["created"] or 0))


def delete_run(rid):
    if load_run(rid) is None:
        raise RuntimeError("No such run.")
    (RUNS / "trash").mkdir(parents=True, exist_ok=True)
    (RUNS / f"{rid}.json").replace(RUNS / "trash" / f"{rid}.json")  # recoverable


def set_post_state(rid, text, state):
    """Remember that a run's post was published or skipped, so Today stops offering it."""
    job = JOBS.get(rid)
    if job:
        job["postState"][text] = state
        save_run(job)
        return
    run = load_run(rid)
    if run:
        run.setdefault("postState", {})[text] = state
        write_json(RUNS / f"{rid}.json", run)


# ---------------------------------------------------------------- workspace

def workspace():
    return read_json(WORKSPACE, {})


def save_workspace(update):
    with _ws_lock:
        ws = workspace()
        ws.update({k: v for k, v in (update or {}).items() if k in WORKSPACE_KEYS and v is not None})
        ws["updated"] = time.time()
        write_json(WORKSPACE, ws)
    return ws
