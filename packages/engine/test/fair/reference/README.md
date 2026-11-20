# Independent reference for the draw recipe

`fair_reference.py` is a second, separate copy of the provably fair recipe in plain Python (standard library only), written from `docs/fairness.md` and CLAUDE.md alone. It uses no game code.
It checks the worked example in `docs/fairness.md`, then writes `vectors.json` (seed hashes, raw HMAC blocks and draws, with no randomness), which the engine tests compare against.
Rebuild it from the repo root with `python3 -I packages/engine/test/fair/reference/fair_reference.py`, or add `--check` to fail if the committed `vectors.json` differs.
