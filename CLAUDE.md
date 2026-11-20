# Pump: project spec

Requirements live in docs/brief.pdf (not committed). This file records decisions already made. If you think one is wrong, stop and say so rather than working around it.

## What reviewers weigh, in order
1. The math is exactly right and provable.
2. The wallet can never double-pay or drift from its ledger.
3. Players can verify every round.
4. Structure: a pure engine with a service layer around it. They read the engine first.
5. Feel, after correctness.
They will change RTP to 94% and 99% and rerun everything, then send bugs for a 48-hour fix round. Nothing may hard-code 97.

## Math (locked)
- R is the RTP, one integer config value in basis points (RTP_BP = 9700). Everything derives from it.
- Each difficulty is a ladder of multipliers m_1 < m_2 < ... < m_n, stored as integer hundredths h_k. Ladders are pure config; adding a difficulty must need no engine change.
- Every cash-out point must return exactly R, so survival to rung k is S_k = R / m_k. That forces:
    survive pump 1 with probability     R / m_1          = RTP_BP / (100 * h_1)
    survive pump k >= 2 with probability m_(k-1) / m_k    = h_(k-1) / h_k
  The whole house edge sits in pump 1 and later pumps are fair. Changing RTP only changes pump 1.
- Pop chance must rise with every pump. Test p_1 <= p_2 <= ... at 9400, 9700 and 9900. Refuse to boot if R / m_1 >= 1.
- Probabilities are exact fractions. A pump is resolved by comparing a uniform integer in [0, denominator) with the numerator. The integer comes from unbiased rejection sampling. No floating point in any outcome or money path.
- No cash-out before the first pump (it would return 100%).
- Patch: available before any pump after the first. It covers exactly that one pump and is spent whether or not the pump pops. If the pump would have popped, the balloon survives at its current rung and the next pump is a fresh draw. Price for pump k on bet B, in cents:
    price_k = ceil( p_k * B * m_(k-1) / R )
  That makes the Patch itself return exactly R.
- Rounding always favours the house: payouts floor to the cent, Patch prices ceil to the cent. RTP can land just under R, never over. This must hold for every legal bet, not only round ones.
- Money is integer cents everywhere. Bets are 10 to 100000 cents per balloon.
- Max payout is 10,000,000 cents per balloon, handled in the open: for a given bet, rungs where bet * m_k exceeds the cap are locked, the highest reachable rung becomes that balloon's top, and the UI shows this before the round starts. RTP is unaffected because every rung returns R on its own.
- Reaching the top reachable rung cashes out automatically.

## Provably fair (locked)
- Per player: an active server seed (only its SHA-256 hash is shown), a client seed the player can edit, and a nonce that increments once per round.
- Draw bytes = HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}:${balloonIndex}:${drawIndex}`), extended with a block counter if rejection sampling runs out of bytes. drawIndex counts draws on that balloon, so a balloon's outcomes don't depend on click order.
- A draw is computed only when the player pumps. No response may contain a future outcome or an unrevealed server seed.
- The server seed is revealed only when the player rotates to a new one. Seeds can't change mid-round. A round becomes verifiable once its seed is revealed.
- The verify page recomputes rounds in the browser using the same engine package.

## Wallet (locked)
- Append-only ledger: bet, patch, payout, refund, and the opening 1,000,000-cent grant. Database triggers reject UPDATE and DELETE on it.
- Balance is a stored column changed only in the same transaction as its ledger row, guarded so it can't go negative. Invariant: balance == sum(ledger) at all times.
- SQLite, a single server process, every state change in one synchronous immediate transaction with no await inside it.
- One active round per player, enforced by a partial unique index.
- Every mutating request carries a client idempotency key; a repeat returns the stored original response.
- Pump and cash-out on the same balloon are conditional on the balloon's current state; the loser gets a 409.
- Patch + pump is one atomic request: charge and draw together.
- Abandoned rounds: after 24h idle, pumped balloons cash out at their current multiplier and unpumped bets are refunded, applied lazily on the player's next request and by a periodic sweep.
- Players are anonymous: created on first visit, identified by an httpOnly cookie.

## Structure
- PumpEngine.ts has zero I/O: no database, HTTP, clock or crypto. Randomness is passed in. Same input, same output.
- apps/server wraps it as routes -> services -> repositories. Game rules never live in the server.
- No `any`. Validate every request body at the boundary.
- Comment the engine so someone reading it top to bottom can follow the math.

## Working rules
- Small commits, plain messages, never squash or rewrite history.
- Tests read RTP from config; anything parametrised runs at 9400, 9700 and 9900.
- At the end of each session, append to docs/worklog.md: what was built, anything that turned out wrong, and how it was caught.
