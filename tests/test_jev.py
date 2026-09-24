from kite import jev


def test_viral_score_penalizes_bait_and_rehash():
    s = {k: 3.0 for k in jev.POST_WEIGHTS}
    clean = jev.viral_score(s, bait=0.0, breakout=0.5)
    assert jev.viral_score(s, bait=0.8, breakout=0.5) < clean
    assert jev.viral_score(s, bait=0.0, breakout=0.5, rehash=0.9) < clean


def test_mix_is_spread_not_winner_take_all():
    shares = jev.mix_shares({"a": 3.6, "b": 3.1, "c": 3.0, "d": 1.9})
    assert abs(sum(shares.values()) - 1) < 1e-9
    assert shares["a"] > shares["d"] and shares["a"] < 0.5


def test_heuristics_work_without_a_key():
    ctx = {"platform": "x", "profile": "p", "goal": "g"}
    r = jev.score_post(ctx, "Like if you agree! You won't believe this")
    assert r["source"] == "heuristic" and r["bait"] > 0.5
