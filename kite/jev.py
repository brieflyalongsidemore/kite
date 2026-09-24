"""The judge: Jev, TypeSafe's decision model, via OpenRouter or TypeSafe's own API.

Jev takes a text state plus typed questions (choice, score, noul) and returns calibrated probabilities.
This module holds every rubric Kite asks it. Without a key, crude heuristics stand in so the app still runs.
"""

import datetime
import json
import re
import urllib.error
import urllib.request

from . import config

JEV_PRICE_PER_TOKEN = 0.042 / 1e6  # input tokens; output is free


def enabled():
    return bool(config.settings()["judge"].get("api_key"))


def status():
    j = config.settings()["judge"]
    label = config.JUDGES.get(j["provider"], {}).get("label", j["provider"])
    return (True, f"{j['model']} via {label}") if j.get("api_key") else (False, f"Add your {label} key in Settings (scores use a rough heuristic until then)")


def ask(state, questions):
    """One Jev request. Returns the parsed response with a `cost` estimate."""
    j = config.settings()["judge"]
    req = urllib.request.Request(
        j["url"], data=json.dumps({"model": j["model"], "state": state, "questions": questions}).encode(),
        headers={"Authorization": f"Bearer {j['api_key']}", "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Jev returned {exc.code}: {exc.read().decode(errors='replace')[:300]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Couldn't reach Jev ({exc.reason})") from exc
    usage = data.get("usage") or {}
    data["cost"] = usage.get("cost") if usage.get("cost") is not None else usage.get("input_tokens", 0) * JEV_PRICE_PER_TOKEN
    return data


PLATFORMS = {
    "x": ("X", "X (Twitter): posts up to 280 characters unless it's a long post or a thread; the first line decides everything; replies, reposts and bookmarks drive reach."),
    "linkedin": ("LinkedIn", "LinkedIn: only the first 2-3 lines show before 'see more'; personal stories, lessons and contrarian professional takes perform; comments and dwell time drive reach; 1,300 characters is a sweet spot."),
    "threads": ("Threads", "Threads: short conversational posts up to 500 characters; replies drive reach; casual, less performative than X."),
    "bluesky": ("Bluesky", "Bluesky: posts up to 300 characters; reposts and quote-posts drive reach; audience dislikes growth-hacky or corporate tone."),
    "instagram": ("Instagram", "Instagram: a caption for a carousel, photo or Reel; the first line hooks before 'more'; saves and shares drive reach; carousels teach, Reels entertain."),
    "tiktok": ("TikTok", "TikTok / Reels / Shorts: a video script; the first 2 seconds of spoken or on-screen hook decide retention; watch time, rewatches and shares drive reach."),
    "youtube": ("YouTube", "YouTube: a video title plus thumbnail text (and optionally the opening line of the video); click-through and the curiosity gap drive reach, and the video must deliver."),
}


def platform_of(key):
    return PLATFORMS.get(key, PLATFORMS["x"])


def state(ctx, **extra):
    return {"account": ctx["profile"], "platform": platform_of(ctx["platform"])[1], "goal": ctx["goal"], **extra}


def _scores(answers, dims):
    return {k: round(float(answers[k]["score"]), 2) for k in dims}


def _score_questions(dims):
    return {k: {"type": "score", "instructions": q, "criteria": levels} for k, (q, levels) in dims.items()}


def pick(ctx, options, question, **extra):
    """One choice across options. Returns ({option: probability}, cost)."""
    data = ask(state(ctx, **extra), {"pick": {"type": "choice", "instructions": question,
                                              "criteria": {f"o{i + 1}": o for i, o in enumerate(options)}}})
    probs = data["answers"]["pick"]["probabilities"]
    return {o: probs.get(f"o{i + 1}", 0) for i, o in enumerate(options)}, data["cost"]


# ---------------------------------------------------------------- posts

POST_DIMS = {
    "hook": ("How strongly does the opening of `draft` make someone in the audience described in `account` stop scrolling on the platform in `platform`?",
             ["Scroll right past", "Mildly interesting", "Some people pause", "Strong pull; most would stop", "Impossible not to stop"]),
    "share": ("How likely is someone in that audience to share, repost, save or send `draft` to a friend?",
              ["Nobody would share it", "A rare share", "Some shares", "Many would share it", "People will send this to everyone they know"]),
    "discussion": ("How likely is `draft` to spark comments or replies?",
                   ["No reason to reply", "A few polite replies", "Some real discussion", "Lots of people will want to weigh in", "Comments explode"]),
    "novelty": ("How fresh is the idea or angle in `draft` for that audience?",
                ["Heard it a hundred times", "Familiar", "A somewhat new angle", "Genuinely fresh", "Nobody has said this before"]),
    "clarity": ("How easy is `draft` to understand in one quick read?", ["Confusing", "Takes effort", "Mostly clear", "Clear", "Instantly obvious"]),
    "fit": ("How native is `draft` to the platform in `platform` (format, length, tone of posts that do well there)?",
            ["Wrong for this platform", "Awkward", "Acceptable", "Good fit", "Native to the platform"]),
    "voice": ("How much does `draft` sound like the account described in `account`?",
              ["Nothing like the account", "Off-brand", "Roughly on-brand", "On-brand", "Unmistakably this account"]),
}
POST_WEIGHTS = {"hook": 0.24, "share": 0.20, "discussion": 0.14, "novelty": 0.14, "clarity": 0.10, "fit": 0.10, "voice": 0.08}
EMOTIONS = {"curiosity": "Makes people need to know more", "awe": "Wow, surprise, amazement", "humor": "Funny",
            "outrage": "Anger or indignation", "inspiration": "Motivating, uplifting", "usefulness": "Practical value people want to keep",
            "relatability": "'That's so me' recognition", "fomo": "Fear of missing out", "none": "No strong emotion"}


def viral_score(scores, bait, breakout, rehash=0.0):
    base = sum(POST_WEIGHTS[k] * scores[k] / 4 for k in POST_WEIGHTS) * 100
    return max(0.0, min(100.0, base * (0.85 + 0.3 * breakout) - 30 * bait - 20 * rehash))


def score_post(ctx, text):
    if not enabled():
        return _post_heuristic(ctx, text)
    qs = _score_questions(POST_DIMS)
    qs["emotion"] = {"type": "choice", "instructions": "Which emotion does `draft` mainly trigger?", "criteria": EMOTIONS}
    qs["bait"] = {"type": "noul", "instructions": "Does `draft` rely on engagement bait, misleading or overhyped claims, or rage bait that the platform down-ranks or that would hurt the credibility of the account in `account`?"}
    qs["breakout"] = {"type": "noul", "instructions": "Would `draft` likely reach far more people than a typical post from the account in `account` (10x or more)?"}
    extra = {"draft": text}
    if ctx.get("past"):
        extra["past_posts"] = ctx["past"]
        qs["rehash"] = {"type": "noul", "instructions": "Does `draft` mostly repeat an idea, claim or angle that already appears in `past_posts`?"}
    criteria = ctx.get("criteria") or []
    for i, c in enumerate(criteria):
        qs[f"c{i}"] = {"type": "noul", "instructions": f"About `draft`: {c}"}
    data = ask(state(ctx, **extra), qs)
    a = data["answers"]
    scores = _scores(a, POST_DIMS)
    bait, breakout = float(a["bait"]["noul"]), float(a["breakout"]["noul"])
    rehash = float(a["rehash"]["noul"]) if "rehash" in a else 0.0
    return {"viral": round(viral_score(scores, bait, breakout, rehash), 1), "scores": scores, "emotion": a["emotion"]["choice"],
            "bait": round(bait, 2), "breakout": round(breakout, 2), "rehash": round(rehash, 2),
            "criteria": {c: round(float(a[f"c{i}"]["noul"]), 2) for i, c in enumerate(criteria)}, "source": "jev", "cost": data["cost"]}


def _post_heuristic(ctx, text):
    """Crude stand-in when no Jev key is set. Not a real prediction."""
    first = text.strip().splitlines()[0] if text.strip() else ""
    lo, words = text.lower(), len(text.split())
    limit = {"x": 280, "bluesky": 300, "threads": 500}.get(ctx["platform"], 2200)
    scores = {"hook": min(4, 1 + bool(re.search(r"\d", first)) + (len(first.split()) <= 12) + ("?" in first or ":" in first)),
              "share": min(4, 1 + ("\n" in text) + (" you" in lo)), "discussion": min(4, 1 + text.count("?")),
              "novelty": 2, "clarity": max(0, 4 - max(0, words - 60) / 30), "fit": 3 if len(text) <= limit else 1.5, "voice": 2}
    scores = {k: float(v) for k, v in scores.items()}
    bait = 0.6 if re.search(r"(you won't believe|comment .* below|like if|rt if|follow for)", lo) else 0.1
    return {"viral": round(viral_score(scores, bait, 0.1), 1), "scores": scores, "emotion": "none", "bait": bait,
            "breakout": 0.1, "rehash": 0.0, "criteria": {}, "source": "heuristic", "cost": 0}


# ---------------------------------------------------------------- the content mix

def score_kind(ctx, kind):
    """How well a kind of post would work for this account and goal, judged on its own (0-4)."""
    if not enabled():
        return {"score": 2.0, "cost": 0}
    data = ask(state(ctx, kind=kind), {"fit": {
        "type": "score",
        "instructions": "How well would posts of the kind in `kind` work for the account in `account`, toward the `goal`, on the platform in `platform`?",
        "criteria": ["Would flop", "Weak", "Decent", "Strong", "The account's best bet"]}})
    return {"score": round(float(data["answers"]["fit"]["score"]), 2), "cost": data["cost"]}


def mix_shares(scores):
    """Independent 0-4 scores -> a mix. Squaring favors strong kinds without letting one take everything
    (a single "which is best" question would put ~99% on one kind)."""
    weights = {k: (v / 4) ** 2 + 0.01 for k, v in scores.items()}
    total = sum(weights.values())
    return {k: w / total for k, w in weights.items()}


# ---------------------------------------------------------------- ideas

IDEA_DIMS = {
    "interest": ("How much would the audience of the account in `account` care about `idea`?",
                 ["Not at all", "A little", "Moderately", "A lot", "They'd stop everything to read it"]),
    "timing": ("Given `basis` and `today`, how right is the moment for `idea`? Evergreen ideas that are always relevant can score high.",
               ["Stale", "Off-moment", "Fine anytime", "Good moment", "Perfect timing"]),
    "authority": ("How credible would the account in `account` be saying `idea`?",
                  ["No standing at all", "Weak", "Some", "Strong", "The perfect person to say this"]),
    "debate": ("How much would a post about `idea` make people want to reply, agree or push back?",
               ["Nothing to say", "A few nods", "Some discussion", "Strong opinions", "Everyone has a take"]),
    "fresh": ("How new would `idea` feel to this audience?",
              ["Heard it a hundred times", "Familiar", "Some new angle", "Genuinely fresh", "Nobody has said this"]),
}


def score_idea(ctx, item):
    idea, basis = item
    if not enabled():
        return {"priority": 50.0, "scores": {k: 2.0 for k in IDEA_DIMS}, "basis": basis, "source": "heuristic", "cost": 0}
    data = ask(state(ctx, idea=idea, basis=basis or "(not given)", today=datetime.date.today().isoformat()), _score_questions(IDEA_DIMS))
    s = _scores(data["answers"], IDEA_DIMS)
    n = {k: v / 4 for k, v in s.items()}
    priority = 100 * n["interest"] * (0.5 + 0.5 * n["timing"]) * (0.5 + 0.5 * n["authority"]) * (0.7 + 0.3 * n["debate"]) * (0.4 + 0.6 * n["fresh"])
    return {"priority": round(priority, 1), "scores": s, "basis": basis, "source": "jev", "cost": data["cost"]}


# ---------------------------------------------------------------- growth actions

ACTION_DIMS = {
    "impact": ("How much would doing `action` move the account toward `goal` within the next month?",
               ["No measurable effect", "Small bump", "Noticeable growth", "Big step forward", "Could change the account's trajectory"]),
    "effort": ("How much time and effort does `action` take for the person running the account in `account`?",
               ["Under 15 minutes", "About an hour", "A few hours", "Days of work", "Weeks of work"]),
    "fit": ("How naturally does `action` fit the account's niche, voice and strengths described in `account`?",
            ["Completely off-brand", "Awkward", "Plausible", "Natural fit", "Exactly what this account should do"]),
    "odds": ("How likely is `action` to actually pay off if done well, rather than being ignored?",
             ["Almost never works", "Long shot", "Coin flip", "Usually works", "Nearly always works"]),
}


def score_action(ctx, action):
    """Priority rewards expected payoff per unit of effort, like picking the month's move in a money race."""
    if not enabled():
        return {"priority": 50.0, "scores": {k: 2.0 for k in ACTION_DIMS}, "risk": 0.1, "source": "heuristic", "cost": 0}
    qs = _score_questions(ACTION_DIMS)
    qs["risk"] = {"type": "noul", "instructions": "Could `action` backfire: cost followers, look spammy or desperate, break the platform's rules, or hurt the account's reputation?"}
    data = ask(state(ctx, action=action), qs)
    s = _scores(data["answers"], ACTION_DIMS)
    risk = float(data["answers"]["risk"]["noul"])
    expected = (s["impact"] / 4) * (0.4 + 0.6 * s["odds"] / 4) * (0.6 + 0.4 * s["fit"] / 4) * (1 - 0.6 * risk)
    priority = 100 * expected / (0.55 + 0.45 * s["effort"] / 4)
    return {"priority": round(min(100, priority), 1), "scores": s, "risk": round(risk, 2), "source": "jev", "cost": data["cost"]}


# ---------------------------------------------------------------- replies

REPLY_DIMS = {
    "value": ("How much does `reply` add something specific and useful to the conversation in `target_post`?",
              ["Nothing", "Generic", "Some substance", "Clearly useful", "The best reply in the thread"]),
    "standout": ("How likely is `reply` to get likes from other readers so it ranks near the top of the replies?",
                 ["Buried", "Unlikely", "Maybe", "Likely", "Top reply"]),
    "voice": ("How much does `reply` sound like the account described in `account`?",
              ["Nothing like it", "Off-brand", "Roughly", "On-brand", "Unmistakably this account"]),
}


def score_reply(ctx, pair):
    target, reply = pair
    if not enabled():
        return {"score": 50.0, "scores": {k: 2.0 for k in REPLY_DIMS}, "author": 0.3, "follow": 0.2, "spam": 0.1, "source": "heuristic", "cost": 0}
    qs = _score_questions(REPLY_DIMS)
    qs["author"] = {"type": "noul", "instructions": "Would the author of `target_post` likely like or answer `reply`?"}
    qs["follow"] = {"type": "noul", "instructions": "Would a reader who likes `reply` plausibly visit the profile of the account in `account`?"}
    qs["spam"] = {"type": "noul", "instructions": "Does `reply` read as self-promotion, generic flattery or engagement farming?"}
    data = ask(state(ctx, target_post=target, reply=reply), qs)
    a = data["answers"]
    s = _scores(a, REPLY_DIMS)
    author, follow, spam = (float(a[k]["noul"]) for k in ("author", "follow", "spam"))
    base = (0.45 * s["value"] + 0.35 * s["standout"] + 0.2 * s["voice"]) / 4
    score = max(0.0, min(100.0, 100 * base * (0.7 + 0.3 * author) * (0.8 + 0.2 * follow) - 40 * spam))
    return {"score": round(score, 1), "scores": s, "author": round(author, 2), "follow": round(follow, 2), "spam": round(spam, 2),
            "source": "jev", "cost": data["cost"]}
