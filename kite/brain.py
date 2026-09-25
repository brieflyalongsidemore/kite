"""The brain: a local, Obsidian-compatible vault of short linked markdown notes (data/brain/memories/).

The writer reads and writes it through Anthropic's memory tool (exposed as a plain function to other
providers). Kite also records facts itself (profile, runs, plan decisions, checklist ticks, posts), so
nothing depends on the model remembering. Open the folder in Obsidian to browse it there too.
"""

import datetime
import json
import os
import re
import threading
import time
import uuid

from .config import DATA
from .jev import platform_of

try:
    from anthropic.lib.tools import BetaLocalFilesystemMemoryTool
except ImportError:  # not re-exported in every SDK version
    try:
        from anthropic.lib.tools._beta_builtin_memory_tool import BetaLocalFilesystemMemoryTool
    except ImportError:
        BetaLocalFilesystemMemoryTool = None

BRAIN_BASE = DATA / "brain"
BRAIN = BRAIN_BASE / "memories"
BRAIN_LOCK = threading.Lock()

BRAIN_GUIDE = """The person's brain lives in /memories (the memory tool): an Obsidian vault of short, linked markdown notes.
- Me: who they are, voice, niche. Direction: where they're heading, current goal, momentum, what to focus on.
- Log/<date>: what happened each day. Actions/<name>: each plan item with its status (todo, in progress, done, skipped) and history.
- Runs/<...>: past planning runs. Posts/<...>: what they actually published, and how it did if they told you.
- Add notes of your own when useful (Learnings, Audience, Ideas, People...) and link them with [[Note name]].
The app records runs, plan decisions, checklist ticks and posts automatically. A snapshot is in the first message; view notes for detail.
Use it: don't re-suggest what they already did or deliberately skipped unless you have a reason; build on what worked; move them in their direction.
Update it when you learn something durable (a preference, a result, a decision, a change of direction). Keep notes short, link generously, never store secrets."""

SEED_NOTES = {
    "Index.md": "# Index\n\nThis is your brain. The app and Claude keep it up to date; edit anything.\n\n- [[Me]]: who you are and how you sound\n- [[Direction]]: where you're heading and how it's going\n- Log/: one note per day of what you did and skipped\n- Actions/: every plan item and its status\n- Runs/ and Posts/: planning runs and what you published\n",
    "Me.md": "# Me\n\nFilled in when you read your profile. See [[Direction]].\n",
    "Direction.md": "# Direction\n\nWhere you're heading. Claude updates this on Reflect; edit freely. See [[Me]].\n\n## Goals over time\n",
}


def brain_ready():
    BRAIN.mkdir(parents=True, exist_ok=True)
    for name, text in SEED_NOTES.items():
        if not (BRAIN / name).exists():
            (BRAIN / name).write_text(text)


def memory_tool():
    brain_ready()
    return BetaLocalFilesystemMemoryTool(base_path=str(BRAIN_BASE)) if BetaLocalFilesystemMemoryTool else None


def brain_file(rel):
    """Resolve a vault-relative path, refusing anything outside the vault or not markdown."""
    rel = rel.strip().lstrip("/")
    if rel.startswith("memories/"):
        rel = rel[len("memories/"):]
    if not rel.endswith(".md"):
        rel += ".md"
    path = (BRAIN / rel).resolve()
    if not str(path).startswith(str(BRAIN.resolve()) + os.sep):
        raise RuntimeError("That path is outside the brain.")
    return path


def slug(text, n=60):
    s = re.sub(r"[^\w\s-]", "", text).strip()
    s = re.sub(r"\s+", " ", s)
    return (s[:n].rsplit(" ", 1)[0] if len(s) > n else s) or "untitled"


def now_str():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M")


def brain_append(rel, line, header=""):
    with BRAIN_LOCK:
        brain_ready()
        path = brain_file(rel)
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text(header)
        with path.open("a") as f:
            f.write(line.rstrip("\n") + "\n")


def log_event(text):
    day = datetime.date.today().isoformat()
    brain_append(f"Log/{day}.md", f"- {datetime.datetime.now():%H:%M} {text}", header=f"# {day}\n\nWhat happened today. See [[Direction]].\n\n")


def replace_section(text, heading, body):
    """Replace (or add) a `## heading` section, leaving the rest of the note alone."""
    block = f"## {heading}\n{body.strip()}\n"
    pattern = re.compile(rf"^## {re.escape(heading)}\n.*?(?=^## |\Z)", re.S | re.M)
    return pattern.sub(block + "\n", text, count=1) if pattern.search(text) else text.rstrip() + "\n\n" + block


def action_rel(action):
    return f"Actions/{slug(action)}.md"


def action_update(action, status=None, history=None, **fields):
    """Create or update an action note: status in frontmatter, one history line per event."""
    with BRAIN_LOCK:
        brain_ready()
        path = brain_file(action_rel(action))
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            text = path.read_text()
        else:
            text = f"---\nstatus: todo\n---\n# {action}\n\nToward [[Direction]].\n\n## History\n"
        meta = dict(re.findall(r"^(\w+): (.*)$", text.split("---", 2)[1], re.M)) if text.startswith("---") else {}
        if status:
            meta["status"] = status
        meta.update({k: str(v) for k, v in fields.items() if v is not None})
        meta["updated"] = datetime.date.today().isoformat()
        body = text.split("---", 2)[2] if text.startswith("---") else "\n" + text
        if history:
            body = body.rstrip() + f"\n- {now_str()} {history}\n"
        path.write_text("---\n" + "".join(f"{k}: {v}\n" for k, v in meta.items()) + "---" + body)


def action_status(action):
    try:
        text = brain_file(action_rel(action)).read_text()
    except (OSError, RuntimeError):
        return None
    m = re.search(r"^status: (.*)$", text, re.M)
    return m.group(1).strip() if m else None


def brain_record_profile(profile, platform, handle):
    with BRAIN_LOCK:
        brain_ready()
        path = BRAIN / "Me.md"
        text = replace_section(path.read_text(), "Profile", f"{profile}\n\n_{platform_of(platform)[0]}{' · ' + handle if handle else ''} · read {now_str()}_")
        path.write_text(text)
    log_event(f"Read my {platform_of(platform)[0]} profile into [[Me]]")


def brain_record_run(ctx, job):
    final = job.get("final")
    if not final:
        return
    day = datetime.date.today().isoformat()
    rel = f"Runs/{day} {slug(ctx['goal'], 40)}.md"
    lines = [f"# Plan for: {ctx['goal']}", "", f"_{now_str()} · {platform_of(ctx['platform'])[0]}_ · toward [[Direction]] · about [[Me]]", ""]
    if job["mix"]:
        lines += ["## Mix (Jev)"] + [f"- {round(m['share'] * 100)}% {m['kind']}" for m in job["mix"]] + [""]
    ideas = sorted(job["ideas"].items(), key=lambda kv: -kv[1]["priority"])[:6]
    if ideas:
        lines += ["## Top ideas (Jev)"] + [f"- {t} ({r.get('basis') or 'no basis'})" for t, r in ideas] + [""]
    lines += ["## Plan"]
    for i, a in enumerate(final["plan"], 1):
        lines.append(f"{i}. [[{action_rel(a['text'])[:-3]}|{a['text']}]]: {a.get('reason', '')}")
    lines += ["", "## Posts"] + [f"- ({p.get('kind') or 'post'}, Jev {round(p['viral'])}) {p['text']!r}" for p in final["posts"]]
    with BRAIN_LOCK:
        brain_ready()
        path = brain_file(rel)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(lines) + "\n")
    for a in final["plan"]:
        action_update(a["text"], status=None if action_status(a["text"]) else "todo", history=f"in the plan from [[{rel[:-3]}]]",
                      jev_priority=round(a.get("priority", 0)), first_move_odds=a.get("first"))
    brain_append("Direction.md", f"- {day}: {ctx['goal']} ([[{rel[:-3]}]])")
    log_event(f"Planned for \"{ctx['goal']}\" → [[{rel[:-3]}]]")


def brain_record_post(text, kind=None, viral=None, action=None):
    day = datetime.date.today().isoformat()
    rel = f"Posts/{day} {slug(text, 40)}.md"
    body = [f"# {slug(text, 60)}", "", f"_Published {now_str()}{' · ' + kind if kind else ''}{f' · Jev {round(viral)}' if viral is not None else ''}_"]
    if action:
        body.append(f"From [[{action_rel(action)[:-3]}]]")
    body += ["", text, "", "## Results", "(add likes, replies, follows when you know them)", ""]
    with BRAIN_LOCK:
        brain_ready()
        path = brain_file(rel)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(body))
    log_event(f"Posted [[{rel[:-3]}]]")
    if action:
        action_update(action, history=f"posted [[{rel[:-3]}]]")


def brain_snapshot(days=7, limit=6000):
    """What the brain knows right now, for the first message of a run or thread."""
    brain_ready()
    parts = []
    direction = (BRAIN / "Direction.md").read_text()
    parts.append(direction.strip())
    actions = []
    for p in sorted((BRAIN / "Actions").glob("*.md")) if (BRAIN / "Actions").exists() else []:
        t = p.read_text()
        status = re.search(r"^status: (.*)$", t, re.M)
        title = re.search(r"^# (.*)$", t, re.M)
        actions.append(f"- [{status.group(1) if status else '?'}] {title.group(1) if title else p.stem}")
    if actions:
        parts.append("ACTIONS SO FAR:\n" + "\n".join(actions[-25:]))
    logs = sorted((BRAIN / "Log").glob("*.md"))[-days:] if (BRAIN / "Log").exists() else []
    entries = []
    for p in logs:
        body = p.read_text().split("\n\n", 2)[-1].strip()
        if body:
            entries.append(f"{p.stem}:\n{body}")
    if entries:
        parts.append("RECENT LOG:\n" + "\n".join(entries))
    text = "\n\n".join(parts)
    return text[-limit:] if len(text) > limit else text


def brain_graph():
    brain_ready()
    notes = {p.relative_to(BRAIN).with_suffix("").as_posix(): p for p in BRAIN.rglob("*.md")}
    by_name = {}
    for nid in notes:
        by_name.setdefault(nid.rsplit("/", 1)[-1].lower(), nid)
    edges = set()
    info = {}
    for nid, p in notes.items():
        text = p.read_text(errors="replace")
        status = re.search(r"^status: (.*)$", text, re.M)
        info[nid] = {"id": nid, "title": nid.rsplit("/", 1)[-1], "folder": nid.split("/")[0] if "/" in nid else "",
                     "status": status.group(1).strip() if status else None, "size": len(text)}
        for m in re.finditer(r"\[\[([^\]|#]+)", text):
            target = m.group(1).strip()
            tid = target if target in notes else by_name.get(target.rsplit("/", 1)[-1].lower())
            if tid and tid != nid:
                edges.add(tuple(sorted((nid, tid))))
    return {"nodes": list(info.values()), "edges": [list(e) for e in edges], "path": str(BRAIN), "stats": brain_stats(notes, info)}


def brain_stats(notes, info):
    """Numbers for the brain's share card: what it holds, and how much it recorded each day."""
    days = [{"day": nid[4:], "events": sum(line.startswith("- ") for line in p.read_text(errors="replace").splitlines())}
            for nid, p in sorted(notes.items()) if nid.startswith("Log/")]
    in_folder = lambda f: [n for n in info.values() if n["folder"] == f]  # noqa: E731
    actions = in_folder("Actions")
    learn = notes.get("Learnings")
    learnings = [line[2:].strip() for line in learn.read_text(errors="replace").splitlines() if line.startswith("- ")][:3] if learn else []
    return {"notes": len(notes), "days": days, "actions": len(actions), "done": sum(a["status"] == "done" for a in actions),
            "skipped": sum(a["status"] == "skipped" for a in actions), "posts": len(in_folder("Posts")), "runs": len(in_folder("Runs")),
            "learnings": learnings}


def brain_note(rel):
    path = brain_file(rel)
    if not path.exists():
        raise RuntimeError("No such note.")
    nid = path.relative_to(BRAIN.resolve()).with_suffix("").as_posix()
    name = nid.rsplit("/", 1)[-1].lower()
    backlinks = []
    for p in BRAIN.rglob("*.md"):
        other = p.relative_to(BRAIN).with_suffix("").as_posix()
        if other != nid and any(t.strip() in (nid,) or t.strip().rsplit("/", 1)[-1].lower() == name
                                for t in re.findall(r"\[\[([^\]|#]+)", p.read_text(errors="replace"))):
            backlinks.append(other)
    return {"id": nid, "content": path.read_text(errors="replace"), "backlinks": sorted(backlinks)}


def brain_save(rel, content):
    with BRAIN_LOCK:
        path = brain_file(rel)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)


BRAIN_TRASH = BRAIN_BASE / "trash"
WIKILINK = re.compile(r"\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]")


def brain_delete(rel, unlink=True):
    """Move a note to the brain's trash (recoverable) and, by default, turn links to it into plain text."""
    with BRAIN_LOCK:
        path = brain_file(rel)
        if not path.exists():
            raise RuntimeError("No such note.")
        nid = path.relative_to(BRAIN.resolve()).with_suffix("").as_posix()
        name = nid.rsplit("/", 1)[-1].lower()
        BRAIN_TRASH.mkdir(parents=True, exist_ok=True)
        dest = BRAIN_TRASH / f"{datetime.datetime.now():%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:6]}.md"
        path.replace(dest)
        index = BRAIN_TRASH / "index.json"
        entries = json.loads(index.read_text()) if index.exists() else {}
        entries[dest.name] = {"id": nid, "deleted": time.time()}
        index.write_text(json.dumps(entries))
        unlinked = 0
        if unlink:
            def plain(m):
                target = m.group(1).strip()
                if target == nid or target.rsplit("/", 1)[-1].lower() == name:
                    return (m.group(3) or target.rsplit("/", 1)[-1]).strip()
                return m.group(0)
            for p in BRAIN.rglob("*.md"):
                text = p.read_text(errors="replace")
                new = WIKILINK.sub(plain, text)
                if new != text:
                    p.write_text(new)
                    unlinked += 1
        parent = path.parent  # tidy up folders the delete emptied
        while parent != BRAIN.resolve() and parent.exists() and not any(parent.iterdir()):
            parent.rmdir()
            parent = parent.parent
    return {"ok": True, "id": nid, "unlinked": unlinked}


def brain_trash():
    index = BRAIN_TRASH / "index.json"
    entries = json.loads(index.read_text()) if index.exists() else {}
    return sorted(({"file": f, **e} for f, e in entries.items() if (BRAIN_TRASH / f).exists()), key=lambda e: -e["deleted"])


def brain_restore(file):
    with BRAIN_LOCK:
        index = BRAIN_TRASH / "index.json"
        entries = json.loads(index.read_text()) if index.exists() else {}
        if file not in entries or not (BRAIN_TRASH / file).exists():
            raise RuntimeError("Not in the trash.")
        nid = entries[file]["id"]
        target = brain_file(nid)
        if target.exists():
            raise RuntimeError("A note with that name exists again; rename it first.")
        target.parent.mkdir(parents=True, exist_ok=True)
        (BRAIN_TRASH / file).replace(target)
        del entries[file]
        index.write_text(json.dumps(entries))
    return {"ok": True, "id": nid}


def activity(days=14):
    """Which recent days had real progress (done, posted), for the streak on Today."""
    out = []
    for i in range(days - 1, -1, -1):
        day = (datetime.date.today() - datetime.timedelta(days=i)).isoformat()
        p = BRAIN / "Log" / f"{day}.md"
        text = p.read_text(errors="replace") if p.exists() else ""
        out.append({"day": day, "done": len(re.findall(r"\] (Did|Done|Posted)\b|\d (Did|Done|Posted)\b", text))})
    streak = 0
    for d in reversed(out):
        if d["done"]:
            streak += 1
        elif d["day"] != datetime.date.today().isoformat():
            break
    return {"days": out, "streak": streak}


def direction_summary():
    """One short paragraph for the top of Today: the first paragraph of Direction's first section
    (Reflect writes "Where you're actually heading" first), else the first plain paragraph."""
    brain_ready()
    text = (BRAIN / "Direction.md").read_text(errors="replace")
    sections = re.split(r"^## .*$", text, flags=re.M)
    candidates = sections[1:2] + sections[:1] if len(sections) > 1 else sections
    for chunk in candidates:
        for block in re.split(r"\n\s*\n", chunk):
            b = " ".join(line.strip() for line in block.strip().splitlines())
            if b and not b.startswith(("#", "- ", "* ", "Where you're heading", "Updated:", "_")):
                b = re.sub(r"\[\[([^\]|]+)\|?([^\]]*)\]\]", lambda m: m.group(2) or m.group(1).split("/")[-1], b)
                return b if len(b) <= 320 else b[:317].rsplit(" ", 1)[0] + "…"
    return ""
