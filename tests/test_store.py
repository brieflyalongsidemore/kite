import time

from kite import store


def test_runs_survive_a_restart():
    job = store.new_job("run")
    job["meta"] = {"goal": "Launch", "platform": "x", "created": time.time()}
    store.save_run(job)  # still "running" on disk
    store.JOBS.clear()  # simulate a restart
    run = store.job_or_run(job["id"])
    assert run["status"] == "error" and "restarted" in run["error"]
    assert store.list_runs()[0]["goal"] == "Launch"
    store.set_post_state(job["id"], "a post", "posted")
    assert store.load_run(job["id"])["postState"]["a post"] == "posted"
    store.delete_run(job["id"])
    assert not store.list_runs()


def test_ids_are_validated():
    assert store.load_run("../../etc") is None
