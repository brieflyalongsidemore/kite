import pathlib
import threading
import time

from kite import bridge, server

ROOT = pathlib.Path(__file__).resolve().parent.parent


def test_extension_ships_the_same_clipper():
    assert (ROOT / "extension/clipper.js").read_text() == (ROOT / "web/clipper.js").read_text(), \
        "extension/clipper.js must be a copy of web/clipper.js: cp web/clipper.js extension/clipper.js"


def test_only_known_social_sites_over_https():
    assert bridge.allowed("https://x.com/dev_brok/status/1")
    assert bridge.allowed("https://www.linkedin.com/feed/update/urn:li:activity:1/")
    assert not bridge.allowed("http://x.com/a")
    assert not bridge.allowed("https://evil.example/x.com")
    assert not bridge.allowed("https://x.com.evil.example/")
    assert bridge.search_url("x", 'claude "code"').startswith("https://x.com/search?q=claude%20%22code%22")
    assert bridge.search_url("instagram", "anything") == ""


def test_task_round_trip_and_timeout():
    bridge.next_task(wait=0)  # the extension checks in
    out = {}

    def agent():
        out["result"] = bridge.run("clip", 5, url="https://x.com/search?q=a", limit=10)

    t = threading.Thread(target=agent)
    t.start()
    task = {}
    for _ in range(50):
        task = bridge.next_task(wait=0)
        if task:
            break
        time.sleep(0.02)
    assert task["kind"] == "clip" and task["limit"] == 10
    bridge.finish({"id": task["id"], "ok": True, "result": {"posts": []}})
    t.join(2)
    assert out["result"] == {"posts": []}
    bridge.next_task(wait=0)
    try:
        bridge.run("reply", 0.2, url="https://x.com/a/status/1", text="hi")
        raise AssertionError("an unanswered task should time out")
    except RuntimeError as exc:
        assert "in time" in str(exc)


def test_only_local_hosts_are_answered():
    assert server.host_ok("localhost:8788") and server.host_ok("127.0.0.1:8788") and server.host_ok("[::1]:8788")
    assert not server.host_ok("evil.example:8788") and not server.host_ok("")


def test_extension_zip_has_everything_chrome_needs():
    import io
    import json
    import zipfile

    from kite import extension

    z = zipfile.ZipFile(io.BytesIO(extension.zip_bytes()))
    names = set(z.namelist())
    for f in ("manifest.json", "background.js", "clipper.js", "popup.html", "popup.js"):
        assert f"kite-extension/{f}" in names
    manifest = json.loads(z.read("kite-extension/manifest.json"))
    assert manifest["manifest_version"] == 3 and manifest["background"]["service_worker"] == "background.js"
