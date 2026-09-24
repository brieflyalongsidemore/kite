"""Research: free, keyless sources for what people are discussing right now, plus a page reader.
The model picks the URLs it reads, so the reader refuses anything that isn't on the public internet."""

import datetime
import email.utils
import html
import ipaddress
import json
import re
import socket
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

from . import config

UA = {"User-Agent": "Kite/0.1 (personal content research)"}


def available():
    return [k for k in RESEARCH if k != "web" or config.settings()["research"].get("brave_api_key")]


class _SafeRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_SafeRedirects)


def check_public_url(url):
    """Claude chooses which pages to read, so never let it reach this machine or the local network."""
    p = urllib.parse.urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise RuntimeError("Only http(s) URLs can be read.")
    for info in socket.getaddrinfo(p.hostname, None):
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise RuntimeError("That address isn't on the public internet.")


def fetch_text(url, headers=None, limit=2_000_000):
    check_public_url(url)
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    with _opener.open(req, timeout=15) as resp:
        return resp.read(limit).decode(resp.headers.get_content_charset() or "utf-8", errors="replace")


def rss_items(xml_text):
    root = ET.fromstring(xml_text)
    for item in root.iter("item"):
        yield {child.tag.split("}")[-1]: (child.text or "").strip() for child in item}, item


def research_news(query):
    # Google's `when:7d` operator returns nothing in the RSS feed, so filter by date here.
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=14)
    out = []
    for fields, _ in rss_items(fetch_text(f"https://news.google.com/rss/search?q={urllib.parse.quote(query)}&hl=en-US&gl=US&ceid=US:en")):
        try:
            when = email.utils.parsedate_to_datetime(fields.get("pubDate", ""))
        except (TypeError, ValueError):
            continue
        if when >= cutoff:
            out.append({"title": fields.get("title"), "source": fields.get("source"), "date": when.date().isoformat()})
    return sorted(out, key=lambda x: x["date"], reverse=True)[:15]


def research_trends(geo):
    geo = (geo or "US").upper()[:2]
    out = []
    for fields, item in rss_items(fetch_text(f"https://trends.google.com/trending/rss?geo={geo}")):
        news = [n.text for n in item.iter() if n.tag.endswith("news_item_title") and n.text]
        out.append({"search": fields.get("title"), "traffic": fields.get("approx_traffic"), "news": news[:2]})
    return out[:20]


def research_reddit(query):
    # Reddit's JSON API refuses anonymous requests; its search RSS feed still works (top posts this week).
    root = ET.fromstring(fetch_text(f"https://www.reddit.com/search.rss?q={urllib.parse.quote(query)}&sort=top&t=week"))
    ns = {"a": "http://www.w3.org/2005/Atom"}
    out = []
    for e in root.findall("a:entry", ns)[:15]:
        link = e.find("a:link", ns)
        cat = e.find("a:category", ns)
        body = re.sub(r"<[^>]+>", " ", html.unescape(e.findtext("a:content", "", ns)))
        out.append({"title": e.findtext("a:title", "", ns), "subreddit": cat.get("label") if cat is not None else None,
                    "date": e.findtext("a:updated", "", ns)[:10], "text": re.sub(r"\s+", " ", body).strip()[:300],
                    "url": link.get("href") if link is not None else None})
    return out


def research_hackernews(query):
    since = int(time.time()) - 30 * 86400
    d = json.loads(fetch_text(f"https://hn.algolia.com/api/v1/search?query={urllib.parse.quote(query)}&tags=story&numericFilters=created_at_i>{since}"))
    return [{"title": h.get("title"), "points": h.get("points"), "comments": h.get("num_comments"), "date": (h.get("created_at") or "")[:10],
             "url": h.get("url") or f"https://news.ycombinator.com/item?id={h['objectID']}",
             "discussion": f"https://news.ycombinator.com/item?id={h['objectID']}"} for h in d.get("hits", [])[:12]]


def research_bluesky(query):
    # Search is blocked on public.api.bsky.app but open on api.bsky.app.
    d = json.loads(fetch_text(f"https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q={urllib.parse.quote(query)}&sort=top&limit=25"))
    return [{"text": p.get("record", {}).get("text", "")[:300], "author": p.get("author", {}).get("handle"),
             "likes": p.get("likeCount"), "reposts": p.get("repostCount"), "replies": p.get("replyCount")} for p in d.get("posts", [])]


def research_mastodon(query):
    tag = re.sub(r"[^A-Za-z0-9_]", "", query.split()[0] if query.split() else "")
    if not tag:
        raise RuntimeError("Give a hashtag-style keyword, e.g. 'saas'.")
    d = json.loads(fetch_text(f"https://mastodon.social/api/v1/timelines/tag/{tag}?limit=30"))
    posts = [{"text": re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", p.get("content", "")))).strip()[:300],
              "author": p.get("account", {}).get("acct"), "favourites": p.get("favourites_count"), "boosts": p.get("reblogs_count"),
              "replies": p.get("replies_count"), "date": p.get("created_at", "")[:10]} for p in d]
    return sorted(posts, key=lambda p: (p["favourites"] or 0) + 2 * (p["boosts"] or 0), reverse=True)[:15]


def research_web(query):
    key = config.settings()["research"].get("brave_api_key")
    if not key:
        raise RuntimeError("general web search needs a Brave Search key in Settings (free tier at brave.com/search/api); use news, reddit, hackernews, bluesky, mastodon or trends")
    d = json.loads(fetch_text(f"https://api.search.brave.com/res/v1/web/search?q={urllib.parse.quote(query)}&count=10&freshness=pm",
                              {"X-Subscription-Token": key, "Accept": "application/json"}))
    return [{"title": r.get("title"), "url": r.get("url"), "snippet": re.sub(r"<[^>]+>", "", r.get("description", "")), "age": r.get("age")}
            for r in d.get("web", {}).get("results", [])]


RESEARCH = {"news": research_news, "trends": research_trends, "reddit": research_reddit, "hackernews": research_hackernews,
            "bluesky": research_bluesky, "mastodon": research_mastodon, "web": research_web}


def read_page(url):
    raw = fetch_text(url)
    title = re.search(r"<title[^>]*>(.*?)</title>", raw, re.S | re.I)
    body = re.sub(r"<(script|style|noscript|svg|nav|footer|header)\b.*?</\1>", " ", raw, flags=re.S | re.I)
    body = re.sub(r"<(br|p|div|li|h[1-6]|tr)\b[^>]*>", "\n", body, flags=re.I)
    text = html.unescape(re.sub(r"<[^>]+>", " ", body))
    text = re.sub(r"[ \t]+", " ", re.sub(r"\n\s*\n+", "\n", text)).strip()
    return {"title": html.unescape(title.group(1).strip()) if title else "", "text": text[:8000]}
