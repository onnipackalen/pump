# How every pump is decided, and how to check it

Pump is "provably fair": you can check every pump result yourself, with
your own tools, after the fact. This page gives the exact recipe.

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
| Draw index | How many draws this balloon has had before this one: 0, 1, 2, ... | `0` |
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
5. **Decide.** The balloon survives if `roll < num`. Otherwise it pops
   (unless a Patch covered this pump).

## Worked example

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

1. After rotating, take the revealed server seed and check that its SHA-256
   matches the hash you were shown while playing.
2. For every pump in the round, run the recipe above and check the roll.
3. Each round records the RTP and the ladder it was played with. Use those
   to get each pump's `num / den`:
   - Pump 1 survives with `RTP_BP / (100 * h_1)`.
   - Pump k (k >= 2) survives with `h_(k-1) / h_k`.
   - Here `h_k` is the k-th ladder step in hundredths (101 means 1.01x).
     Reduce to lowest terms before drawing.
4. A pump saved by a Patch still uses a draw, so the next pump on that
   balloon uses the next draw index.

The verify page in the game does all of this in your browser, using the same
code the server uses.

## Checking without our code

`packages/engine/test/fair/reference/fair_reference.py` is the same recipe
written separately in plain Python, using only Python's standard library.
It doesn't use any of the game's code. The test suite checks that the game
and this script agree on every example.
