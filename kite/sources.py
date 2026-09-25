"""Where a profile comes from: pasted page text, the Kite clipper (web/clipper.js), screenshots, data exports,
Bluesky's free API, or the X API when there's a token. No paid API is required."""

import base64
import json
import re
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request

from . import config

MAX_IMAGES = 8
IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}


def http_json(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read())


def post_entry(text, likes=None, reposts=None, replies=None, quotes=None):
    counted = [x for x in (likes, reposts, replies, quotes) if x is not None]
    engagement = (likes or 0) + 2 * (reposts or 0) + (replies or 0) + 2 * (quotes or 0) if counted else None
    return {"text": text, "likes": likes, "reposts": reposts, "replies": replies, "engagement": engagement}


def fetch_bluesky(handle):
    """Bluesky's public AppView API is free and needs no key."""
    actor = urllib.parse.quote(handle.strip().lstrip("@"))
    base = "https://public.api.bsky.app/xrpc"
    try:
        prof = http_json(f"{base}/app.bsky.actor.getProfile?actor={actor}")
        feed = http_json(f"{base}/app.bsky.feed.getAuthorFeed?actor={actor}&limit=100&filter=posts_no_replies")
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Bluesky returned {exc.code} for {handle}. Check the handle (e.g. name.bsky.social).") from exc
    posts = []
    for item in feed.get("feed", []):
        p = item.get("post", {})
        if item.get("reason") or p.get("author", {}).get("did") != prof.get("did"):
            continue  # skip reposts of other people
        text = (p.get("record") or {}).get("text", "").strip()
        if text:
            posts.append(post_entry(text, p.get("likeCount"), p.get("repostCount"), p.get("replyCount"), p.get("quoteCount")))
    return {"handle": prof.get("handle", handle), "name": prof.get("displayName", ""), "bio": prof.get("description", ""),
            "followers": prof.get("followersCount"), "posts": posts}


def fetch_x(handle):
    """Only with an X API bearer token (X API reads are paid)."""
    token = config.settings()["sources"].get("x_bearer_token")
    handle = handle.strip().lstrip("@")
    auth = {"Authorization": f"Bearer {token}"}
    try:
        user = http_json(f"https://api.x.com/2/users/by/username/{urllib.parse.quote(handle)}?user.fields=description,public_metrics", auth)
        u = user["data"]
        tweets = http_json(f"https://api.x.com/2/users/{u['id']}/tweets?max_results=100&exclude=retweets,replies&tweet.fields=public_metrics,note_tweet", auth)
    except (urllib.error.HTTPError, KeyError) as exc:
        raise RuntimeError("The X API didn't return this profile (X API reads need a paid plan). Paste your profile page instead.") from exc
    posts = [post_entry((t.get("note_tweet") or {}).get("text") or t["text"], (m := t.get("public_metrics", {})).get("like_count"),
                        m.get("retweet_count"), m.get("reply_count"), m.get("quote_count")) for t in tweets.get("data", [])]
    return {"handle": handle, "name": u.get("name", ""), "bio": u.get("description", ""),
            "followers": u.get("public_metrics", {}).get("followers_count"), "posts": posts}


def parse_x_archive(text):
    """X's free "Download an archive" includes data/tweets.js: `window.YTD.tweets.part0 = [...]`."""
    data = json.loads(text[text.index("["):])
    posts = []
    for item in data:
        t = item.get("tweet", item)
        body = t.get("full_text", "")
        if not body or body.startswith("RT @") or t.get("in_reply_to_status_id_str"):
            continue
        body = re.sub(r"\s*https://t\.co/\S+$", "", body).strip()
        when = t.get("created_at", "")
        stamp = time.mktime(time.strptime(when, "%a %b %d %H:%M:%S %z %Y")) if when else 0
        posts.append((stamp, post_entry(body, int(t.get("favorite_count", 0)), int(t.get("retweet_count", 0)))))
    posts.sort(key=lambda x: x[0], reverse=True)
    return [p for _, p in posts[:200]]  # newest 200 original posts


def _count(v):
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 else None


def parse_clip(text):
    """The Kite clipper's block: {"kite_clip": 1, "platform": ..., "url": ..., "posts": [{text, likes, reposts, replies}]}.
    Returns None for anything else, so ordinary pasted text is left alone."""
    text = (text or "").strip()
    if not text.startswith("{") or '"kite_clip"' not in text[:40]:
        return None
    try:
        data = json.loads(text)
    except ValueError:
        return None
    posts = []
    for p in data.get("posts") or []:
        body = str(p.get("text", "")).strip() if isinstance(p, dict) else ""
        if body:
            entry = post_entry(body[:3000] + (" …" if p.get("cut") else ""), _count(p.get("likes")), _count(p.get("reposts")), _count(p.get("replies")))
            entry["author"] = str(p.get("author") or "").lstrip("@").lower()
            link = str(p.get("url") or "")
            entry["url"] = link if re.match(r"https?://[^\s]+$", link) else ""
            posts.append(entry)
    return {"platform": str(data.get("platform") or ""), "url": str(data.get("url") or ""), "page": str(data.get("page") or ""), "posts": posts[:200]}


def own_posts(clip, handle):
    """Keep only the account's own posts from a clip. Raises if the clip is someone else's feed."""
    me = (handle or "").strip().lstrip("@").lower().split("@")[0]
    authors = {p["author"] for p in clip["posts"] if p["author"]}
    if me and authors:
        mine = [p for p in clip["posts"] if p["author"] in (me, "")]
        if mine:
            return mine
        raise RuntimeError(f"None of these posts are by @{me}. Open your own profile and run the clipper there.")
    if clip["page"] == "feed" or len(authors) > 1:
        raise RuntimeError("These posts come from several accounts (a search or a feed), so they can't teach Kite your voice. "
                           "Run the clipper on your own profile, or paste these in a thread as posts to reply to.")
    return clip["posts"]


def read_files(files):
    """Split uploads into images (for the model to look at), structured posts, and raw text."""
    images, posts, raw = [], [], []
    for f in files or []:
        name, mime = f.get("name", "file"), f.get("type", "")
        if mime in IMAGE_TYPES:
            if len(images) < MAX_IMAGES:
                images.append({"type": "image", "source": {"type": "base64", "media_type": mime, "data": f["data"]}})
            continue
        text = base64.b64decode(f.get("data", "")).decode("utf-8", errors="replace")
        if "window.YTD.tweets" in text[:200]:
            posts.extend(parse_x_archive(text))
        elif (clip := parse_clip(text)) is not None:
            posts.extend(clip["posts"])
        else:
            raw.append(f"--- {name} ---\n{text}")
    return images, posts, "\n\n".join(raw)


def digest(src):
    """Compact text of the account's own posts: best performers first."""
    posts = src["posts"]
    ranked = sorted(posts, key=lambda p: p.get("engagement") or 0, reverse=True)
    lines = [f"Handle: {src['handle']}" if src.get("handle") else "Handle: (not given)"]
    if src.get("name"):
        lines.append(f"Name: {src['name']}")
    if src.get("followers") is not None:
        lines.append(f"Followers: {src['followers']:,}")
    if src.get("bio"):
        lines.append(f"Bio: {src['bio']}")
    eng = [p["engagement"] for p in posts if p.get("engagement") is not None]
    if eng:
        lines.append(f"{len(posts)} posts. Median engagement score {statistics.median(eng):.0f} (likes + 2x reposts + replies + 2x quotes).")
        lines.append("\nTOP POSTS:")
        lines += [f"[{p.get('likes', '?')} likes, {p.get('reposts', '?')} reposts] {p['text']}" for p in ranked[:12]]
        if len(ranked) > 12:
            lines.append("\nWEAKEST POSTS:")
            lines += [f"[{p.get('likes', '?')} likes] {p['text']}" for p in ranked[-6:]]
    else:
        lines.append(f"\n{len(posts)} POSTS (no engagement numbers):")
        lines += [f"- {p['text']}" for p in posts[:30]]
    return "\n".join(lines)
