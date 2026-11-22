# How every pump is decided, and how to check it

Pump is "provably fair": you can check every pump result yourself, with
your own tools, after the fact. That includes the "would have popped" the
game shows after a round. This page gives the exact recipe.

## The idea in one paragraph

Before you play, the server picks a secret code (the **server seed**) and
shows you only its fingerprint (the **hash**). You pick your own code (the
**client seed**). Each round also has a counter (the **nonce**). A pump's
result is mixed from all of these. The server can't change its seed after
showing you the hash, and it didn't know your client seed when it picked
its own. When you switch to a new server seed, the old one is shown in full.
Then you can recompute every pump you played with it.

## The inputs

| Input | What it is | Example |
|---|---|---|
| Server seed | 64 lowercase hex characters. Secret until you rotate. | `a4d93ce3d9f9e3f860e6275882ff4ecdfdb3adc0e87e99e1bc07b8ab1beeff14` |
| Server seed hash | SHA-256 of those 64 characters, as lowercase hex. Shown from the start. | `947d192d090f6845f059ae8e45b1d90105b3a34cfdcf209e7369fda4b5d60071` |
| Client seed | 1 to 64 characters from `A-Z a-z 0-9 _ -`. Yours to edit between rounds. | `myseed` |
| Nonce | Round counter for this server seed: 0, 1, 2, ... Never resets while the server seed is active. | `5` |
| Balloon index | Which balloon: 0, 1 or 2. | `0` |
| Draw index | How many draws this balloon has had before this one: 0, 1, 2, ... A pump saved by a Patch counts as a draw. After the round, the reveal carries on the same count. | `0` |
| Block | Starts at 0. Only goes up in the rare case described in step 4. | `0` |

## The recipe for one pump

1. **Build the message.** Join the parts with colons:
   `clientSeed:nonce:balloonIndex:drawIndex:block`.
   Numbers are plain decimal, no leading zeros. Example: `myseed:5:0:0:0`.
   The client seed can't contain a colon, so two different draws can never
   share a message.
2. **Mix it.** Compute HMAC-SHA256 with the server seed's 64 characters
   (as ASCII text) as the key and the message (as ASCII text) as the data.
   You get 32 bytes.
3. **Cut it into numbers.** Read the 32 bytes as 8 whole numbers of 4 bytes
   each, big-endian (the first byte is the biggest part). Each is between
   0 and 4,294,967,295.
4. **Turn a number into a roll.** The game gives the pump's survival chance
   as a fraction `num / den` in lowest terms, for example 97/101.
   - Work out `limit = 4,294,967,296 - (4,294,967,296 mod den)`.
   - Take the first of the 8 numbers that is below `limit`.
     `roll = that number mod den`.
   - If all 8 are at or above `limit` (this almost never happens), build the
     message again with block 1, then block 2, and so on, and keep going.
     (The game's code stops with an error after 1024 blocks, treating that
     as broken input. Real HMAC output never gets there: the chance is
     below 2^-8192.)
5. **Decide.** The balloon survives if `roll < num`. Otherwise it pops
   (unless a Patch covered this pump: see step 4 of "Checking a whole
   round").

## Worked example: one pump

Server seed `a4d93ce3...beeff14` (full value in the table above), client
seed `myseed`, nonce 5, balloon 0, draw 0. Easy difficulty, first pump, RTP
97%. Survival chance is 9700 / 10100, which is 97/101 in lowest terms.

- Message: `myseed:5:0:0:0`
- HMAC-SHA256: `c52f148266db67d40e90cea0680eb6be927163f2e35acd8df0df73aff0921b4a`
- The 8 numbers: 3308196994, 1725654996, 244371104, 1745794750,
  2456904690, 3814378893, 4041175983, 4036107082
- `4,294,967,296 mod 101 = 68`, so `limit = 4,294,967,228`
- The first number, 3308196994, is below the limit.
  `3308196994 mod 101 = 69`, so the roll is 69.
- 69 < 97, so the balloon survives.

## Why the roll is exactly fair

4,294,967,296 doesn't divide evenly by 101. There are 68 left over. If we
used every number, rolls 0 to 67 would come up one extra time each out of
about 42.5 million. That's a tiny bias, but it's not exact. So the top 68
numbers are skipped. What's left splits into exactly 42,524,428 copies of
every roll from 0 to 100, so every roll has exactly the same chance. No
decimals are used anywhere.

## Checking a whole round

A balloon's **rung** is how many ladder steps it has climbed: 0 before its
first pump, 1 after one pump that survived, and so on. Every pump tries to
move the balloon up one rung.

1. After rotating, take the revealed server seed and check that its SHA-256
   matches the hash you were shown while playing.
2. For every pump in the round, run the recipe above and check the roll.
3. Each round records the RTP and the ladder it was played with. Use those
   to get each pump's `num / den`. Here `k` is the rung the pump is trying
   to reach: the balloon's rung just before the pump, plus 1. It is **not**
   how many times the pump button was pressed (see step 4).
   - A pump to rung 1 survives with `RTP_BP / (100 * h_1)`.
   - A pump to rung k (k >= 2) survives with `h_(k-1) / h_k`.
   - Here `h_k` is the k-th ladder step in hundredths (101 means 1.01x).
     Reduce to lowest terms before drawing.
4. A Patch covers one pump and is used up either way. If that pump's roll
   is `>= num`, the balloon would have popped. The Patch saves it, and it
   stays on the same rung. That pump still used a draw, so the next pump on
   that balloon uses the next draw index. But the next pump tries for the
   same rung again, so it uses the **same** `num / den` again. A quick
   check: a pump's draw index is the balloon's rung just before it, plus
   the number of Patch saves on that balloon so far.
5. For every balloon that cashed out below its top rung, work out where it
   would have popped (see "After the round" below) and check that it
   matches what the game showed.

The verify page in the game does all of this in your browser, the reveal
included, using the same code the server uses. It takes the hash, client
seed and nonce from the copy your browser saved when each round started, not
from the server's record. It tells you if the record names other ones, sends
them in a form the game never sends, or is the record of another round.
That copy is what the game's Provably fair
panel showed you before the round, so check that the panel shows your own
client seed. Your browser sends the same three values with the bet, and the
game's server refuses a bet on any other seeds (when another tab has played
a round or changed a seed, say), so an honest round matches the copy, apart
from the rare cases under Known issues in the README.
If the answer to a bet never arrives, your browser still keeps what it
showed: under the round's id if it finds that round in play, and otherwise
as a copy the page finds by the round's server seed hash and nonce. A bet
the server refused, with no round in its answer, made no round if the
server is honest. So it is kept only if a round for the same bets turns up
in play: under that round's id if it has no copy yet, and otherwise as a
copy the page finds by server seed hash and nonce. On
another device, or after you clear your browser's data, it has no copy. It
then uses the server's record and says so, and it can't catch a server that
changed those three. It also has no copy if the server
gave the round another id in its answers while you played it. Then the page
looks for a copy saved with the same server seed hash and nonce under
another id (one server seed and nonce belong to one round only), and tells
you if that copy is another round's, or names another client seed. It can't
catch a server that also moved the round to a server seed or nonce this
browser has no copy for. So if you played a round in this browser not long ago and the page
says it has no copy, take that as a warning sign. A round started by an older
version of the game has a copy of the hash only: its client seed and nonce
come from the server's record, and the page says so. Check them against what
you saw while playing.

## Worked example: a round with a Patch save

Same server seed and client seed as above, nonce 3, balloon 0. Easy
difficulty, RTP 97%. The round's ladder starts 101, 111, 123 (1.01x, 1.11x,
1.23x). That is the ladder saved with this round. The game's ladders can be
tuned later, and a round is always checked with its own saved copy, so your
own rounds may show other multipliers. In every draw below the first of the
8 numbers is below the limit, so only that one is shown.

1. **First press.** Rung 0, trying for rung 1. Draw index 0. Survival chance
   9700 / 10100, which is 97/101. `limit = 4,294,967,228`, as above.
   - Message `myseed:3:0:0:0`. HMAC-SHA256:
     `0d996f9b5485bb7ee9fd02bbc7b611e6c4bba56d68d49e6fe48b16a77d78bc38`
   - First number 228159387. `228159387 mod 101 = 84`.
   - 84 < 97, so the balloon survives. It is now on rung 1.
2. **Second press, with a Patch.** Rung 1, trying for rung 2. Draw index 1.
   Survival chance 101/111 (already in lowest terms).
   `4,294,967,296 mod 111 = 7`, so `limit = 4,294,967,289`.
   - Message `myseed:3:0:1:0`. HMAC-SHA256:
     `250c6ed4e5f5c47f46865d9c4bc3689f2adab0170490d8fb7c6f2f008b3bb63a`
   - First number 621571796. `621571796 mod 111 = 101`.
   - 101 is not below 101, so the balloon would pop. The Patch saves it. It
     stays on rung 1, and the Patch is used up.
3. **Third press.** Still on rung 1, still trying for rung 2, so the chance
   is 101/111 **again**, with the next draw index, 2.
   - Message `myseed:3:0:2:0`. HMAC-SHA256:
     `1db1b8b7c3af1cb03d2652fe2af62df8769465f6ad259803f7328bfec0f2e3da`
   - First number 498186423. `498186423 mod 111 = 108`.
   - 108 is not below 101, and no Patch covers this pump, so the balloon
     pops.

A common mistake on the third press is to count presses and use the rung 3
chance, 111/123 (37/41 in lowest terms). That gives
`498186423 mod 41 = 15`, which would survive, and an honest round would
look wrong. Press count and rung stop matching at the first Patch save, so
always work from the rung.

## After the round: where a cashed-out balloon would have popped

When a round is over, the game shows, for each balloon you cashed out below
its top, where it would have popped if you had kept pumping. This is not a
guess and not a new kind of random number. It is the same recipe, carried on
as if you had kept pressing Pump with no Patch.

- It is worked out only when the **whole round** is over: every balloon has
  popped, cashed out or reached its top. While any balloon is still in play,
  nothing about a pump you did not make is worked out or sent to you.
- It decides nothing and moves no money. Your balloon was already cashed out
  and paid.
- A balloon that popped, reached its top, or was never pumped has no
  reveal. A balloon cashed out by the 24-hour rule gets one like any other.
- Like every pump, you can check it once you rotate the server seed.

Start from how the balloon ended:

- `r`: its rung when it cashed out (always 1 or more).
- `d`: its draw count, the draws it used. Patch saves count, so `d` is `r`
  plus the number of Patch saves.
- `T`: its top rung. That is the highest rung `k` where
  `bet * h_k <= cap * 100` (bet and cap in cents, `h_k` in hundredths), so
  its payout fits under the cap. `cap` is the payout cap saved with the
  round (10,000,000 cents, $100,000, for every round so far). Rungs above
  `T` are locked for that bet.

Then:

1. Run the recipe for one pump with draw index `d`, trying for rung `r + 1`.
   Its chance is `h_r / h_(r+1)` in lowest terms (step 3 of "Checking a
   whole round"). `r + 1` is at least 2, so the RTP never comes into a
   reveal: the same end gives the same reveal at any RTP.
2. If `roll >= num`, stop. It would have popped on that pump. The highest
   rung it would have reached is `r`.
3. Otherwise it would have reached rung `r + 1`. If that is `T`, stop: it
   would have reached the top. If not, add 1 to `r` and 1 to `d` and go back
   to step 1.

There is no Patch, so every reveal draw either moves the balloon up a rung
or ends it. A reveal makes at most `T - r` draws, and never one past the top.

**Start at the draw count, not the rung.** After a Patch save they differ.
Starting at the rung reads again a draw that already decided a real pump.

## Worked example: a reveal after a Patch save

Same server seed and client seed as above, nonce 338, balloon 0, bet $10.
Easy, RTP 97%. The round's saved Easy ladder starts 101, 111, 123, 137
(1.01x, 1.11x, 1.23x, 1.37x) and has 24 rungs, up to 25.00x. Even a $1,000
bet pays only $25,000 there, so every bet can reach rung 24: `T = 24`.

The round as played:

1. **First press.** Rung 0, trying for rung 1. Draw index 0, chance 97/101.
   - Message `myseed:338:0:0:0`. HMAC-SHA256:
     `3a2862591d89f50da9c196812b8a30bcb319fb25d5cfff6eacce12c7be212be7`
   - First number 975725145. `975725145 mod 101 = 0`.
   - 0 < 97, so it survives. Rung 1 (1.01x).
2. **Second press, with a Patch.** Rung 1, trying for rung 2. Draw index 1,
   chance 101/111.
   - Message `myseed:338:0:1:0`. HMAC-SHA256:
     `665a5377d2cdc4b811064ffd338c052da8ec642cc175af6ee561cf5358efae94`
   - First number 1717195639. `1717195639 mod 111 = 109`.
   - 109 is not below 101, so it would pop. The Patch saves it. Still rung 1.
3. **Cash out** at 1.01x. So `r = 1` and `d = 2`.

The reveal, once the round is over:

1. Draw index 2, trying for rung 2. Chance 101/111, `limit = 4,294,967,289`.
   - Message `myseed:338:0:2:0`. HMAC-SHA256:
     `094c68969e8236de34b8ec35cf340f7b67088600e7573522ea18e76dd18d84e1`
   - First number 156002454. `156002454 mod 111 = 57`.
   - 57 < 101: it would have reached rung 2 (1.11x).
2. Draw index 3, trying for rung 3. Chance 111/123, which is 37/41.
   `4,294,967,296 mod 41 = 37`, so `limit = 4,294,967,259`.
   - Message `myseed:338:0:3:0`. HMAC-SHA256:
     `8c4a0c226dda3f5812e5457950c9626cadce3a3f1e614a9c9118a4b7f442ae94`
   - First number 2353663010. `2353663010 mod 41 = 36`.
   - 36 < 37: it would have reached rung 3 (1.23x).
3. Draw index 4, trying for rung 4. Chance 123/137 (already in lowest
   terms). `4,294,967,296 mod 137 = 34`, so `limit = 4,294,967,262`.
   - Message `myseed:338:0:4:0`. HMAC-SHA256:
     `173be6f15d2b707b42f456f6b07c38d36bb7a894abc0095e254864e5b95cdae0`
   - First number 389801713. `389801713 mod 137 = 134`.
   - 134 is not below 123: it would have popped.

So it would have reached 1.23x (rung 3), then popped. Three draws.

The common mistake is to start at draw index 1, the rung. That reads
`myseed:338:0:1:0` again: roll 109, the draw the Patch already used. It
would show an instant pop, and an honest reveal would look wrong.

## Worked example: a reveal stopped by the payout cap

Same seeds, nonce 83, balloon 0. Expert, RTP 97%, bet $1,000 (100,000
cents). The round's saved Expert ladder starts 150, 255, 465, 920, 2000,
4750, 12500 (1.50x up to 47.50x, then 125.00x) and goes on up to 5,000x.

The top rung: $1,000 at 47.50x pays $47,500, which fits under $100,000. At
125.00x it would pay $125,000, which does not. In the integers:
`100000 * 4750 = 475,000,000` is at most `1,000,000,000`, but
`100000 * 12500 = 1,250,000,000` is not. So `T = 6`, and rung 7 and above
are locked for this bet.

The five real pumps, draw indexes 0 to 4, all survive (chance, roll):
97/150 roll 10, 10/17 roll 0, 17/31 roll 10, 93/184 roll 41, 23/50 roll 20.
The player cashes out on rung 5 (20.00x, $20,000). So `r = 5` and `d = 5`.

The reveal, once the round is over:

1. Draw index 5, trying for rung 6. Chance 2000/4750, which is 8/19.
   `4,294,967,296 mod 19 = 6`, so `limit = 4,294,967,290`.
   - Message `myseed:83:0:5:0`. HMAC-SHA256:
     `be21d63ec5d65d703055b4b6c8f72e0b67bad2b5436ea4630dacd2349392107c`
   - First number 3189888574. `3189888574 mod 19 = 6`.
   - 6 < 8: it would have reached rung 6. That is `T`, so stop.

So it would have reached the top, 47.50x. One draw, and no more: the ladder
goes higher, but this bet can never climb past rung 6.

## Checking without our code

`packages/engine/test/fair/reference/fair_reference.py` is the same recipe
written separately in plain Python, using only Python's standard library.
It doesn't use any of the game's code. The test suite checks that the game
and this script agree on every example, reveals included.
