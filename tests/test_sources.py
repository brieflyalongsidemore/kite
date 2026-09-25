import base64
import json

from kite import sources


def clip(**extra):
    return json.dumps({"kite_clip": 1, "platform": "x", "url": "https://x.com/me",
                       "posts": [{"text": "first post", "likes": 12, "reposts": 2, "replies": 3}, {"text": "  "}, {"text": "second", "likes": "7"}], **extra})


def test_parse_clip_reads_posts_and_numbers():
    c = sources.parse_clip(clip())
    assert c["platform"] == "x" and [p["text"] for p in c["posts"]] == ["first post", "second"]
    assert c["posts"][0]["likes"] == 12 and c["posts"][0]["engagement"] == 12 + 2 * 2 + 3
    assert c["posts"][1]["likes"] is None  # strings aren't trusted as numbers


def test_parse_clip_ignores_ordinary_text():
    assert sources.parse_clip("just my profile page text") is None
    assert sources.parse_clip('{"name": "not a clip"}') is None
    assert sources.parse_clip('{"kite_clip": 1, broken') is None


def test_clip_file_is_read_as_posts():
    f = {"name": "clip.json", "type": "application/json", "data": base64.b64encode(clip().encode()).decode()}
    images, posts, raw = sources.read_files([f])
    assert not images and not raw and len(posts) == 2


def test_own_posts_keeps_mine_and_refuses_feeds():
    mixed = sources.parse_clip(json.dumps({"kite_clip": 1, "platform": "x", "page": "feed", "posts": [
        {"text": "mine", "author": "dev_brok"}, {"text": "theirs", "author": "someone"}]}))
    assert [p["text"] for p in sources.own_posts(mixed, "@dev_brok")] == ["mine"]
    try:
        sources.own_posts(mixed, "")
        raise AssertionError("a feed from several accounts should be refused")
    except RuntimeError as exc:
        assert "several accounts" in str(exc)
    try:
        sources.own_posts(mixed, "nobody")
        raise AssertionError("posts by other people should be refused")
    except RuntimeError as exc:
        assert "@nobody" in str(exc)


def test_cut_posts_are_marked():
    c = sources.parse_clip(json.dumps({"kite_clip": 1, "posts": [{"text": "long post", "cut": True}]}))
    assert c["posts"][0]["text"] == "long post …"


def test_clip_keeps_post_links_but_only_web_links():
    c = sources.parse_clip(json.dumps({"kite_clip": 1, "posts": [
        {"text": "a", "url": "https://x.com/dev_brok/status/123"}, {"text": "b", "url": "javascript:alert(1)"}]}))
    assert [p["url"] for p in c["posts"]] == ["https://x.com/dev_brok/status/123", ""]
