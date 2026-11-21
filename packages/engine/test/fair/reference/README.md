# Independent reference for the draw recipe

`fair_reference.py` is a second, separate copy of the provably fair recipe in plain Python (standard library only), written from `docs/fairness.md` and CLAUDE.md alone. It uses no game code.
It checks the worked examples in `docs/fairness.md` (one pump, a round with a Patch save, and two after-round reveals: one after a Patch save, one stopped by the payout cap), then writes `vectors.json` (seed hashes, raw HMAC blocks, draws and reveals, with no randomness), which the engine tests compare against. Each reveal is a balloon as it ended (rung, draw count, top rung, with the round's RTP, ladder, bet and payout cap) and where it would have popped.
Rebuild it from the repo root with `python3 -I packages/engine/test/fair/reference/fair_reference.py`, or add `--check` to fail if the committed `vectors.json` differs.
