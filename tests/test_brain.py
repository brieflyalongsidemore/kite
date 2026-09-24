import pytest

from kite import brain


def test_record_and_snapshot():
    brain.brain_record_profile("Niche: coding agents.", "x", "@me")
    job = {"final": {"plan": [{"text": "Reply to 15 posts daily", "reason": "reach", "priority": 24, "first": 0.6}], "posts": []},
           "mix": [], "ideas": {}}
    brain.brain_record_run({"goal": "Reach 100 followers", "platform": "x"}, job)
    brain.action_update("Reply to 15 posts daily", status="done", history="marked done")
    brain.log_event("Did: [[Actions/Reply to 15 posts daily]]")
    snap = brain.brain_snapshot()
    assert "[done] Reply to 15 posts daily" in snap and "Reach 100 followers" in snap
    assert brain.activity()["days"][-1]["done"] >= 1
    g = brain.brain_graph()
    assert any(n["id"] == "Direction" for n in g["nodes"]) and g["edges"]


def test_delete_unlinks_and_restores():
    brain.brain_save("Learnings", "# Learnings\nSee [[Direction]].")
    brain.brain_save("Ideas/One", "From [[Learnings|what I learned]].")
    out = brain.brain_delete("Learnings")
    assert out["unlinked"] == 1
    assert "what I learned" in (brain.BRAIN / "Ideas" / "One.md").read_text()
    item = brain.brain_trash()[0]
    assert brain.brain_restore(item["file"])["id"] == "Learnings"


@pytest.mark.parametrize("bad", ["../../etc/passwd", "../settings"])
def test_paths_stay_inside_the_brain(bad):
    with pytest.raises(RuntimeError):
        brain.brain_note(bad)
