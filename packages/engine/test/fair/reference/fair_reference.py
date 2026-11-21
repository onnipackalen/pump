#!/usr/bin/env python3
"""Independent reference for Pump's provably fair draw recipe.

This file is written only from two places: the "Provably fair" section of
CLAUDE.md and docs/fairness.md. It does not import, read or copy any of the
game's code. Its job is to be a second, separate implementation of the same
recipe, so the TypeScript engine can be checked against it.

It covers one pump, and the after-round reveal: where a balloon cashed out
below its top would have popped (docs/fairness.md, "After the round"). The
reveal code below was written from that section's wording alone.

How to run it (from the repository root):

    python3 -I packages/engine/test/fair/reference/fair_reference.py
        Rebuilds vectors.json next to this file.

    python3 -I packages/engine/test/fair/reference/fair_reference.py --check
        Rebuilds the vectors in memory only, and exits with status 1 if the
        committed vectors.json is different. Use this to prove the file is
        exactly what this script makes.

The script uses only Python's standard library, and no randomness at all:
every seed in the vectors comes from SHA-256 of a fixed label, so every run
writes the same bytes.

Every number here is a Python int, which is exact at any size. There is no
floating point anywhere in this file.
"""

import argparse
import hashlib
import hmac
import json
import math
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Each 4-byte word read from a block is a whole number in [0, 2**32).
TWO_32 = 2**32

# One HMAC-SHA256 block is 32 bytes, which is 8 words of 4 bytes.
BLOCK_BYTES = 32
WORD_BYTES = 4
WORDS_PER_BLOCK = BLOCK_BYTES // WORD_BYTES

# A server seed is exactly 64 lowercase hex characters.
SERVER_SEED_RE = re.compile(r"[0-9a-f]{64}")

# A client seed is 1 to 64 characters from A-Z, a-z, 0-9, '_' and '-'.
# It can never hold ':', which is what keeps two different draws from ever
# building the same message (see message() below).
CLIENT_SEED_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")

HERE = Path(__file__).resolve().parent
VECTORS_PATH = HERE / "vectors.json"


# ---------------------------------------------------------------------------
# Input checks
#
# The recipe only works if the inputs are exactly the shapes the spec
# allows, so every public function checks them and raises ValueError on
# anything else. fullmatch() is used so a trailing newline can't sneak in.
# ---------------------------------------------------------------------------


def _check_server_seed(server_seed: object) -> str:
    if not isinstance(server_seed, str) or SERVER_SEED_RE.fullmatch(server_seed) is None:
        raise ValueError("server seed must be exactly 64 lowercase hex characters")
    return server_seed


def _check_client_seed(client_seed: object) -> str:
    if not isinstance(client_seed, str) or CLIENT_SEED_RE.fullmatch(client_seed) is None:
        raise ValueError("client seed must be 1 to 64 characters from A-Z a-z 0-9 _ -")
    return client_seed


def _check_count(name: str, value: object) -> int:
    # A non-negative whole number. bool is a subclass of int in Python, so
    # True and False are refused on purpose.
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a non-negative integer")
    return value


def _check_den(den: object) -> int:
    # The denominator of the survival fraction. It must be at least 1, and at
    # most 2**32, because a roll is cut from one 32-bit word.
    if isinstance(den, bool) or not isinstance(den, int) or not 1 <= den <= TWO_32:
        raise ValueError("den must be an integer with 1 <= den <= 2**32")
    return den


# ---------------------------------------------------------------------------
# The recipe, one step per function
# ---------------------------------------------------------------------------


def seed_hash(server_seed: str) -> str:
    """The fingerprint the player sees before the seed is revealed.

    SHA-256 of the seed's 64 characters taken as ASCII text (not of the 32
    bytes the hex spells), written as 64 lowercase hex characters.
    """
    _check_server_seed(server_seed)
    return hashlib.sha256(server_seed.encode("ascii")).hexdigest()


def message(client_seed: str, nonce: int, balloon: int, draw: int, block: int) -> str:
    """Step 1: the text that gets mixed for one block of one draw.

    The five parts are joined with ':' in this order:

        clientSeed:nonce:balloonIndex:drawIndex:block

    Numbers are plain decimal with no leading zeros, which is exactly what
    Python's str() gives for a non-negative int. The block number is always
    present, starting at 0.

    Why two different draws can't share a message: the client seed has no
    ':' in it, so the first ':' always ends the client seed, and the four
    numbers after it are separated by the remaining ':'s. Reading the text
    back gives the five parts exactly, so different parts give different
    text.
    """
    _check_client_seed(client_seed)
    _check_count("nonce", nonce)
    _check_count("balloon index", balloon)
    _check_count("draw index", draw)
    _check_count("block", block)
    return f"{client_seed}:{nonce}:{balloon}:{draw}:{block}"


def block_bytes(server_seed: str, msg: str) -> bytes:
    """Step 2: mix one message into 32 bytes.

    HMAC-SHA256 with the key = the server seed's 64 characters as ASCII text,
    and the data = the message as ASCII text.
    """
    _check_server_seed(server_seed)
    if not isinstance(msg, str):
        raise ValueError("message must be a string")
    try:
        data = msg.encode("ascii")
    except UnicodeEncodeError as err:
        raise ValueError("message must be ASCII") from err
    return hmac.digest(server_seed.encode("ascii"), data, "sha256")


def block_words(block: bytes) -> list:
    """Step 3: cut 32 bytes into 8 whole numbers of 4 bytes each.

    Big-endian: the first byte is the most significant. Each word is in
    [0, 2**32 - 1].
    """
    if len(block) != BLOCK_BYTES:
        raise ValueError("a block is exactly 32 bytes")
    return [
        int.from_bytes(block[i * WORD_BYTES : (i + 1) * WORD_BYTES], "big")
        for i in range(WORDS_PER_BLOCK)
    ]


def accept_limit(den: int) -> int:
    """The rejection-sampling cut-off for a denominator.

        limit = 2**32 - (2**32 mod den)

    limit is the largest multiple of den that is at most 2**32. Words in
    [0, limit) are kept and words in [limit, 2**32) are thrown away.

    Why this is exactly fair: [0, limit) holds limit / den full runs of
    0, 1, ..., den - 1, so "word mod den" gives every roll in [0, den) the
    same number of words. For example den = 101 leaves 68 words over at the
    top; those are skipped, and each of the 101 rolls is hit by exactly
    42,524,428 words.

    Edge cases: den = 1 or any power of two up to 2**32 divides 2**32, so
    limit = 2**32 and no word is ever thrown away. den = 2**31 + 1 gives
    limit = 2**31 + 1, so just under half of all words are thrown away.
    """
    _check_den(den)
    return TWO_32 - (TWO_32 % den)


def roll(server_seed: str, client_seed: str, nonce: int, balloon: int, draw: int, den: int) -> dict:
    """Step 4: one draw, as a roll that is uniform on [0, den).

    The caller passes den as the denominator of the survival fraction
    num / den in lowest terms (reducing it is the caller's job). The balloon
    survives when roll < num; that last step is a game rule and is not done
    here.

    Walk through the words of block 0, then block 1, block 2, ... and take
    the first word that is below the limit. roll = that word mod den.

    Returns:
        roll       the roll, in [0, den)
        block      which block the kept word came from (0 almost always)
        wordIndex  where the kept word sits inside that block, 0 to 7
        word       the kept word itself, in [0, limit)

    This always ends: for every legal den, limit >= 2**31 + 1, so each word
    is kept with chance above one half.
    """
    _check_server_seed(server_seed)
    _check_client_seed(client_seed)
    _check_count("nonce", nonce)
    _check_count("balloon index", balloon)
    _check_count("draw index", draw)
    limit = accept_limit(den)

    block = 0
    while True:
        words = block_words(block_bytes(server_seed, message(client_seed, nonce, balloon, draw, block)))
        for word_index, word in enumerate(words):
            if word < limit:
                return {"roll": word % den, "block": block, "wordIndex": word_index, "word": word}
        # All 8 words of this block were thrown away: read the next block.
        block += 1


# ---------------------------------------------------------------------------
# Self-checks that run before anything is written
# ---------------------------------------------------------------------------

# The worked example in docs/fairness.md, copied number for number.
DOCS_SERVER_SEED = "a4d93ce3d9f9e3f860e6275882ff4ecdfdb3adc0e87e99e1bc07b8ab1beeff14"
DOCS_SEED_HASH = "947d192d090f6845f059ae8e45b1d90105b3a34cfdcf209e7369fda4b5d60071"
DOCS_CLIENT_SEED = "myseed"
DOCS_NONCE = 5
DOCS_BALLOON = 0
DOCS_DRAW = 0
DOCS_DEN = 101  # 9700 / 10100 in lowest terms is 97 / 101
DOCS_MESSAGE = "myseed:5:0:0:0"
DOCS_BLOCK0_HEX = "c52f148266db67d40e90cea0680eb6be927163f2e35acd8df0df73aff0921b4a"
DOCS_WORDS = [
    3308196994, 1725654996, 244371104, 1745794750,
    2456904690, 3814378893, 4041175983, 4036107082,
]
DOCS_LIMIT = 4294967228
DOCS_WORD = 3308196994
DOCS_ROLL = 69


def check_docs_example() -> None:
    """Stop if this script disagrees with the worked example in the docs."""
    if seed_hash(DOCS_SERVER_SEED) != DOCS_SEED_HASH:
        raise AssertionError("docs example: seed hash does not match")
    msg = message(DOCS_CLIENT_SEED, DOCS_NONCE, DOCS_BALLOON, DOCS_DRAW, 0)
    if msg != DOCS_MESSAGE:
        raise AssertionError("docs example: message does not match")
    block = block_bytes(DOCS_SERVER_SEED, msg)
    if block.hex() != DOCS_BLOCK0_HEX:
        raise AssertionError("docs example: block 0 HMAC does not match")
    if block_words(block) != DOCS_WORDS:
        raise AssertionError("docs example: the 8 words do not match")
    if TWO_32 % DOCS_DEN != 68 or accept_limit(DOCS_DEN) != DOCS_LIMIT:
        raise AssertionError("docs example: limit does not match")
    got = roll(DOCS_SERVER_SEED, DOCS_CLIENT_SEED, DOCS_NONCE, DOCS_BALLOON, DOCS_DRAW, DOCS_DEN)
    want = {"roll": DOCS_ROLL, "block": 0, "wordIndex": 0, "word": DOCS_WORD}
    if got != want:
        raise AssertionError(f"docs example: roll gave {got}, docs say {want}")
    if not DOCS_ROLL < 97:
        raise AssertionError("docs example: the balloon should survive")


def survive_fraction(rtp_bp: int, ladder: list, target_rung: int) -> tuple:
    """num / den in lowest terms for a pump trying to reach target_rung.

    This is step 3 of "Checking a whole round" in docs/fairness.md. The rung
    is how many ladder steps the balloon has climbed, so target_rung is the
    rung just before the pump plus 1, not how many times pump was pressed.
    ladder[0] is h_1, the first step in hundredths.

        target rung 1:      RTP_BP / (100 * h_1)
        target rung k >= 2: h_(k-1) / h_k
    """
    if target_rung == 1:
        num, den = rtp_bp, 100 * ladder[0]
    else:
        num, den = ladder[target_rung - 2], ladder[target_rung - 1]
    common = math.gcd(num, den)
    return num // common, den // common


# ---------------------------------------------------------------------------
# After the round: where a cashed-out balloon would have popped
#
# docs/fairness.md, "After the round". Only for a balloon that cashed out
# below its top rung, once the whole round is over. It decides nothing and
# moves no money; it only shows what the next plain pumps would have done.
# ---------------------------------------------------------------------------


def _check_ladder(ladder: object) -> list:
    # Ladder steps in hundredths (101 means 1.01x), at least one, rising.
    if not isinstance(ladder, list) or not ladder:
        raise ValueError("ladder must be a non-empty list")
    for h in ladder:
        if isinstance(h, bool) or not isinstance(h, int) or h < 1:
            raise ValueError("every ladder step must be a positive integer")
    if any(a >= b for a, b in zip(ladder, ladder[1:])):
        raise ValueError("ladder steps must rise")
    return ladder


def top_rung(ladder: list, bet_cents: int, max_payout_cents: int) -> int:
    """T, the balloon's top rung: the highest rung k where

        bet * h_k <= max_payout * 100     (bet and max payout in cents)

    so its payout fits under the cap. Rungs above T are locked for that bet.
    0 if not even rung 1 fits.
    """
    _check_ladder(ladder)
    if _check_count("bet in cents", bet_cents) < 1 or _check_count("max payout in cents", max_payout_cents) < 1:
        raise ValueError("the bet and the max payout are at least 1 cent")
    fits = [k for k, h in enumerate(ladder, start=1) if bet_cents * h <= max_payout_cents * 100]
    return max(fits, default=0)


def reveal(server_seed: str, client_seed: str, nonce: int, balloon: int,
           rtp_bp: int, ladder: list, top: int, rung: int, draw: int) -> dict:
    """Where a cashed-out balloon would have popped.

    Start from how the balloon ended: rung r (1 or more), draw count d (the
    draws it used, Patch saves included, so d >= r) and top rung T. Then:

      1. One pump with draw index d, trying for rung r + 1, with no Patch.
         Its chance is h_r / h_(r+1) in lowest terms. r + 1 >= 2, so the
         RTP never comes in.
      2. If roll >= num, stop: it would have popped, having reached rung r.
      3. Otherwise it reaches rung r + 1. If that is T, stop: it would have
         reached the top. If not, add 1 to r and to d and go back to 1.

    Returns outcome ('popped' or 'top'), reachedRung (the highest rung it
    would have reached) and every draw made, in order.
    """
    _check_ladder(ladder)
    for name, value in (("rtp", rtp_bp), ("top rung", top), ("rung", rung), ("draw count", draw)):
        _check_count(name, value)
    if rung < 1:
        raise ValueError("a balloon cashes out on rung 1 or more")
    if top > len(ladder):
        raise ValueError("the top rung must be on the ladder")
    if rung >= top:
        raise ValueError("a balloon cashed out at its top rung has no reveal")
    if draw < rung:
        raise ValueError("the draw count is at least the rung")

    draws = []
    while True:
        num, den = survive_fraction(rtp_bp, ladder, rung + 1)
        got = roll(server_seed, client_seed, nonce, balloon, draw, den)["roll"]
        draws.append({"drawIndex": draw, "den": den, "num": num, "roll": got})
        if got >= num:
            return {"outcome": "popped", "reachedRung": rung, "draws": draws}
        rung += 1
        if rung == top:
            return {"outcome": "top", "reachedRung": rung, "draws": draws}
        draw += 1


# The round with a Patch save in docs/fairness.md, copied number for number.
# Each press: (rung just before it, Patch used, message, HMAC block 0 hex,
# first word, roll, what happened). The fractions are not copied: they are
# worked out from the round's RTP and ladder by survive_fraction.
DOCS_ROUND_NONCE = 3
DOCS_ROUND_RTP_BP = 9700
DOCS_ROUND_LADDER = [101, 111, 123]  # the round's first three Easy steps
DOCS_ROUND_PRESSES = [
    (0, False, "myseed:3:0:0:0",
     "0d996f9b5485bb7ee9fd02bbc7b611e6c4bba56d68d49e6fe48b16a77d78bc38", 228159387, 84, "survive"),
    (1, True, "myseed:3:0:1:0",
     "250c6ed4e5f5c47f46865d9c4bc3689f2adab0170490d8fb7c6f2f008b3bb63a", 621571796, 101, "saved"),
    (1, False, "myseed:3:0:2:0",
     "1db1b8b7c3af1cb03d2652fe2af62df8769465f6ad259803f7328bfec0f2e3da", 498186423, 108, "pop"),
]


def check_docs_round() -> None:
    """Stop if this script disagrees with the Patch-save round in the docs.

    It plays the round forward from rung 0. A pump that survives moves the
    balloon up one rung. A pump that would pop but has a Patch leaves it on
    the same rung, so the next press tries for the same rung with the same
    fraction, and only the draw index moves on.
    """
    rung = 0
    for draw, press in enumerate(DOCS_ROUND_PRESSES):
        rung_before, patched, msg_want, hex_want, word_want, roll_want, outcome = press
        where = f"docs round, press {draw + 1}"
        if rung != rung_before:
            raise AssertionError(f"{where}: balloon is on rung {rung}, docs say {rung_before}")
        num, den = survive_fraction(DOCS_ROUND_RTP_BP, DOCS_ROUND_LADDER, rung + 1)
        msg = message(DOCS_CLIENT_SEED, DOCS_ROUND_NONCE, DOCS_BALLOON, draw, 0)
        if msg != msg_want:
            raise AssertionError(f"{where}: message {msg!r}, docs say {msg_want!r}")
        if block_bytes(DOCS_SERVER_SEED, msg).hex() != hex_want:
            raise AssertionError(f"{where}: block 0 HMAC does not match")
        got = roll(DOCS_SERVER_SEED, DOCS_CLIENT_SEED, DOCS_ROUND_NONCE, DOCS_BALLOON, draw, den)
        want = {"roll": roll_want, "block": 0, "wordIndex": 0, "word": word_want}
        if got != want:
            raise AssertionError(f"{where}: roll gave {got}, docs say {want}")
        if roll_want < num:
            happened = "survive"
            rung += 1
        elif patched:
            happened = "saved"
        else:
            happened = "pop"
        if happened != outcome:
            raise AssertionError(f"{where}: {happened}, docs say {outcome}")
    if survive_fraction(DOCS_ROUND_RTP_BP, DOCS_ROUND_LADDER, 1) != (97, 101):
        raise AssertionError("docs round: the first pump's chance should be 97/101")
    # The mistake the docs warn about: counting presses, so press 3 would use
    # the rung 3 chance 111/123 = 37/41 and roll 15.
    wrong = survive_fraction(DOCS_ROUND_RTP_BP, DOCS_ROUND_LADDER, 3)
    wrong_roll = roll(DOCS_SERVER_SEED, DOCS_CLIENT_SEED, DOCS_ROUND_NONCE, DOCS_BALLOON, 2, wrong[1])
    if wrong != (37, 41) or wrong_roll["roll"] != 15:
        raise AssertionError("docs round: the counted-presses mistake should give 37/41 and roll 15")


# The two reveal examples in docs/fairness.md, copied number for number.
#
# The ladders are the rounds' saved ones. The docs quote the steps they use
# (Easy 101, 111, 123, 137 of 24 rungs up to 2500; Expert 150 to 12500,
# going on up to 500000); the full lists are the fixed test ladders in
# game-spec.json (testVectors.ladders).
DOCS_EASY_LADDER = [101, 111, 123, 137, 153, 171, 192, 216, 244, 277, 316, 362,
                    416, 480, 555, 645, 752, 881, 1040, 1230, 1460, 1740, 2080, 2500]
DOCS_EXPERT_LADDER = [150, 255, 465, 920, 2000, 4750, 12500, 37500, 125000, 500000]
DOCS_MAX_PAYOUT_CENTS = 10_000_000  # $100,000

# A reveal after a Patch save: nonce 338, bet $10, Easy, RTP 97%.
DOCS_PATCH_NONCE = 338
DOCS_PATCH_BET = 1000
DOCS_PATCH_RTP_BP = 9700
# The round as played, in the style of DOCS_ROUND_PRESSES, then a cash-out.
DOCS_PATCH_PRESSES = [
    (0, False, "myseed:338:0:0:0",
     "3a2862591d89f50da9c196812b8a30bcb319fb25d5cfff6eacce12c7be212be7", 975725145, 0, "survive"),
    (1, True, "myseed:338:0:1:0",
     "665a5377d2cdc4b811064ffd338c052da8ec642cc175af6ee561cf5358efae94", 1717195639, 109, "saved"),
]
DOCS_PATCH_TOP = 24
# The reveal: (draw index, num, den, limit, message, HMAC block 0 hex, first
# word, roll). Rung 1, draw count 2.
DOCS_PATCH_REVEAL = [
    (2, 101, 111, 4294967289, "myseed:338:0:2:0",
     "094c68969e8236de34b8ec35cf340f7b67088600e7573522ea18e76dd18d84e1", 156002454, 57),
    (3, 37, 41, 4294967259, "myseed:338:0:3:0",
     "8c4a0c226dda3f5812e5457950c9626cadce3a3f1e614a9c9118a4b7f442ae94", 2353663010, 36),
    (4, 123, 137, 4294967262, "myseed:338:0:4:0",
     "173be6f15d2b707b42f456f6b07c38d36bb7a894abc0095e254864e5b95cdae0", 389801713, 134),
]
DOCS_PATCH_OUTCOME = ("popped", 3)

# A reveal stopped by the payout cap: nonce 83, bet $1,000, Expert, RTP 97%.
DOCS_CAP_NONCE = 83
DOCS_CAP_BET = 100000
DOCS_CAP_RTP_BP = 9700
DOCS_CAP_TOP = 6
# The five real pumps, draw indexes 0 to 4: (num, den, roll). All survive.
DOCS_CAP_PUMPS = [(97, 150, 10), (10, 17, 0), (17, 31, 10), (93, 184, 41), (23, 50, 20)]
DOCS_CAP_REVEAL = [
    (5, 8, 19, 4294967290, "myseed:83:0:5:0",
     "be21d63ec5d65d703055b4b6c8f72e0b67bad2b5436ea4630dacd2349392107c", 3189888574, 6),
]
DOCS_CAP_OUTCOME = ("top", 6)

RTPS = [9400, 9700, 9900]


def _check_docs_reveal_draws(where: str, nonce: int, got: dict, want_draws: list, want_outcome: tuple) -> None:
    for i, (draw, num, den, limit, msg_want, hex_want, word_want, roll_want) in enumerate(want_draws):
        here = f"{where}, reveal draw {i + 1}"
        if accept_limit(den) != limit:
            raise AssertionError(f"{here}: limit does not match")
        msg = message(DOCS_CLIENT_SEED, nonce, DOCS_BALLOON, draw, 0)
        if msg != msg_want:
            raise AssertionError(f"{here}: message {msg!r}, docs say {msg_want!r}")
        if block_bytes(DOCS_SERVER_SEED, msg).hex() != hex_want:
            raise AssertionError(f"{here}: block 0 HMAC does not match")
        full = roll(DOCS_SERVER_SEED, DOCS_CLIENT_SEED, nonce, DOCS_BALLOON, draw, den)
        if full != {"roll": roll_want, "block": 0, "wordIndex": 0, "word": word_want}:
            raise AssertionError(f"{here}: roll gave {full}")
    want = [{"drawIndex": d, "den": den, "num": num, "roll": r} for d, num, den, _, _, _, _, r in want_draws]
    if got["draws"] != want:
        raise AssertionError(f"{where}: reveal draws {got['draws']}, docs say {want}")
    if (got["outcome"], got["reachedRung"]) != want_outcome:
        raise AssertionError(f"{where}: reveal ended {got['outcome']} on {got['reachedRung']}, docs say {want_outcome}")


def check_docs_reveals() -> None:
    """Stop if this script disagrees with the two reveal examples in the docs.

    Each round is played forward from rung 0 first, so the rung and draw
    count the reveal starts from come from the play itself, not from the
    docs.
    """
    # Patch save. Play the two presses, then cash out.
    where = "docs Patch reveal"
    rung = 0
    draw = 0
    for rung_before, patched, msg_want, hex_want, word_want, roll_want, outcome in DOCS_PATCH_PRESSES:
        if rung != rung_before:
            raise AssertionError(f"{where}: balloon is on rung {rung}, docs say {rung_before}")
        num, den = survive_fraction(DOCS_PATCH_RTP_BP, DOCS_EASY_LADDER, rung + 1)
        msg = message(DOCS_CLIENT_SEED, DOCS_PATCH_NONCE, DOCS_BALLOON, draw, 0)
        if msg != msg_want or block_bytes(DOCS_SERVER_SEED, msg).hex() != hex_want:
            raise AssertionError(f"{where}: press {draw + 1} message or HMAC does not match")
        got = roll(DOCS_SERVER_SEED, DOCS_CLIENT_SEED, DOCS_PATCH_NONCE, DOCS_BALLOON, draw, den)
        if got != {"roll": roll_want, "block": 0, "wordIndex": 0, "word": word_want}:
            raise AssertionError(f"{where}: press {draw + 1} roll gave {got}")
        happened = "survive" if roll_want < num else ("saved" if patched else "pop")
        if happened != outcome:
            raise AssertionError(f"{where}: press {draw + 1} {happened}, docs say {outcome}")
        if happened == "survive":
            rung += 1
        draw += 1
    if (rung, draw) != (1, 2):
        raise AssertionError(f"{where}: cashed out on rung {rung} with {draw} draws, docs say 1 and 2")
    if top_rung(DOCS_EASY_LADDER, DOCS_PATCH_BET, DOCS_MAX_PAYOUT_CENTS) != DOCS_PATCH_TOP:
        raise AssertionError(f"{where}: top rung should be {DOCS_PATCH_TOP}")
    # The docs say even the largest bet ($1,000) reaches rung 24 here.
    if top_rung(DOCS_EASY_LADDER, 100000, DOCS_MAX_PAYOUT_CENTS) != DOCS_PATCH_TOP:
        raise AssertionError(f"{where}: a $1,000 bet should reach rung 24 too")
    for rtp in RTPS:
        got = reveal(DOCS_SERVER_SEED, DOCS_CLIENT_SEED, DOCS_PATCH_NONCE, DOCS_BALLOON,
                     rtp, DOCS_EASY_LADDER, DOCS_PATCH_TOP, rung, draw)
        _check_docs_reveal_draws(f"{where} at RTP {rtp}", DOCS_PATCH_NONCE, got, DOCS_PATCH_REVEAL, DOCS_PATCH_OUTCOME)
    # The mistake the docs warn about: starting at the rung (draw index 1)
    # reads the draw the Patch used, roll 109, and shows an instant pop.
    wrong = reveal(DOCS_SERVER_SEED, DOCS_CLIENT_SEED, DOCS_PATCH_NONCE, DOCS_BALLOON,
                   DOCS_PATCH_RTP_BP, DOCS_EASY_LADDER, DOCS_PATCH_TOP, 1, 1)
    if wrong != {"outcome": "popped", "reachedRung": 1,
                 "draws": [{"drawIndex": 1, "den": 111, "num": 101, "roll": 109}]}:
        raise AssertionError(f"{where}: starting at the rung should pop at once with roll 109")

    # Payout cap. Play the five real pumps, then cash out on rung 5.
    where = "docs cap reveal"
    if top_rung(DOCS_EXPERT_LADDER, DOCS_CAP_BET, DOCS_MAX_PAYOUT_CENTS) != DOCS_CAP_TOP:
        raise AssertionError(f"{where}: top rung should be {DOCS_CAP_TOP}")
    if not (DOCS_CAP_BET * DOCS_EXPERT_LADDER[5] == 475_000_000
            and DOCS_CAP_BET * DOCS_EXPERT_LADDER[6] == 1_250_000_000
            and DOCS_MAX_PAYOUT_CENTS * 100 == 1_000_000_000):
        raise AssertionError(f"{where}: the cap arithmetic in the docs does not match")
    rung = 0
    for draw, (num_want, den_want, roll_want) in enumerate(DOCS_CAP_PUMPS):
        num, den = survive_fraction(DOCS_CAP_RTP_BP, DOCS_EXPERT_LADDER, rung + 1)
        got = roll(DOCS_SERVER_SEED, DOCS_CLIENT_SEED, DOCS_CAP_NONCE, DOCS_BALLOON, draw, den)["roll"]
        if (num, den, got) != (num_want, den_want, roll_want) or not got < num:
            raise AssertionError(f"{where}: real pump {draw + 1} gave {num}/{den} roll {got}")
        rung += 1
    for rtp in RTPS:
        got = reveal(DOCS_SERVER_SEED, DOCS_CLIENT_SEED, DOCS_CAP_NONCE, DOCS_BALLOON,
                     rtp, DOCS_EXPERT_LADDER, DOCS_CAP_TOP, rung, len(DOCS_CAP_PUMPS))
        _check_docs_reveal_draws(f"{where} at RTP {rtp}", DOCS_CAP_NONCE, got, DOCS_CAP_REVEAL, DOCS_CAP_OUTCOME)
    # Without the cap the same balloon would go on past rung 6.
    uncapped = reveal(DOCS_SERVER_SEED, DOCS_CLIENT_SEED, DOCS_CAP_NONCE, DOCS_BALLOON,
                      DOCS_CAP_RTP_BP, DOCS_EXPERT_LADDER, len(DOCS_EXPERT_LADDER), rung, len(DOCS_CAP_PUMPS))
    if len(uncapped["draws"]) < 2:
        raise AssertionError(f"{where}: the cap should be what stops this reveal")


def _expect_refused(what: str, fn, *args) -> None:
    try:
        fn(*args)
    except ValueError:
        return
    raise AssertionError(f"input check: {what} was accepted but must be refused")


def check_input_rules() -> None:
    """Stop if a bad input is accepted or a good edge input is refused."""
    ok_seed = DOCS_SERVER_SEED
    # Server seed: 64 lowercase hex, nothing else.
    for bad in [ok_seed.upper(), ok_seed[:63], ok_seed + "0", ok_seed[:63] + "g",
                ok_seed[:63] + "\n", "", 5]:
        _expect_refused(f"server seed {bad!r}", seed_hash, bad)
    # Client seed: 1 to 64 of A-Z a-z 0-9 _ -.
    for bad in ["", "a" * 65, "a:b", ":", "a b", "a.b", "é", "a\n", 7]:
        _expect_refused(f"client seed {bad!r}", message, bad, 0, 0, 0, 0)
    message("a" * 64, 0, 0, 0, 0)
    message("-", 0, 0, 0, 0)
    # Counters: non-negative ints only, no bools.
    for bad in [-1, True, 1.0, "1", None]:
        _expect_refused(f"nonce {bad!r}", message, "a", bad, 0, 0, 0)
        _expect_refused(f"balloon {bad!r}", message, "a", 0, bad, 0, 0)
        _expect_refused(f"draw {bad!r}", message, "a", 0, 0, bad, 0)
        _expect_refused(f"block {bad!r}", message, "a", 0, 0, 0, bad)
    # den: 1 <= den <= 2**32.
    for bad in [0, -1, TWO_32 + 1, True, 2.0]:
        _expect_refused(f"den {bad!r}", accept_limit, bad)
        _expect_refused(f"den {bad!r}", roll, ok_seed, "a", 0, 0, 0, bad)
    # Message text must be ASCII.
    _expect_refused("non-ASCII message", block_bytes, ok_seed, "é")
    # Reveal: rung 1 or more, below the top, top on the ladder, draw count
    # at least the rung, and plain non-negative ints only.
    easy = DOCS_EASY_LADDER
    for bad_rung, bad_top, bad_draw in [(0, 24, 0), (24, 24, 24), (5, 24, 4), (1, 25, 1), (3, 2, 3)]:
        _expect_refused(f"reveal rung {bad_rung} top {bad_top} draw {bad_draw}",
                        reveal, ok_seed, "a", 0, 0, 9700, easy, bad_top, bad_rung, bad_draw)
    for bad in [-1, True, 1.0, "1", None]:
        _expect_refused(f"reveal rung {bad!r}", reveal, ok_seed, "a", 0, 0, 9700, easy, 24, bad, 2)
        _expect_refused(f"reveal draw {bad!r}", reveal, ok_seed, "a", 0, 0, 9700, easy, 24, 1, bad)
        _expect_refused(f"reveal top {bad!r}", reveal, ok_seed, "a", 0, 0, 9700, easy, bad, 1, 1)
        _expect_refused(f"top_rung bet {bad!r}", top_rung, easy, bad, DOCS_MAX_PAYOUT_CENTS)
    _expect_refused("top_rung bet 0", top_rung, easy, 0, DOCS_MAX_PAYOUT_CENTS)
    _expect_refused("top_rung max payout 0", top_rung, easy, 10, 0)
    for bad in [[], [101, 101], [111, 101], [101, True], [101, 1.5], (101, 111)]:
        _expect_refused(f"ladder {bad!r}", top_rung, bad, 10, DOCS_MAX_PAYOUT_CENTS)
        _expect_refused(f"ladder {bad!r}", reveal, ok_seed, "a", 0, 0, 9700, bad, 1, 0, 0)
    # The smallest legal reveal: one rung below the top, draw count = rung.
    reveal(ok_seed, "a", 0, 0, 9700, easy, 24, 23, 23)
    # Top rung: a payout exactly at the cap is reachable, one cent of bet
    # more locks that rung, and a bet that can't reach rung 1 gets 0.
    expert = DOCS_EXPERT_LADDER
    if top_rung(expert, 2000, DOCS_MAX_PAYOUT_CENTS) != 10 or top_rung(expert, 2001, DOCS_MAX_PAYOUT_CENTS) != 9:
        raise AssertionError("top rung: a payout exactly at the cap must be reachable")
    if top_rung(expert, 6_666_666, DOCS_MAX_PAYOUT_CENTS) != 1 or top_rung(expert, 6_666_667, DOCS_MAX_PAYOUT_CENTS) != 0:
        raise AssertionError("top rung: a bet that can't reach rung 1 must give 0")
    # The limit is always a multiple of den and above half of 2**32.
    for den in [1, 2, 3, 7, 101, 2**31, 2**31 + 1, 2**32 - 1, 2**32]:
        limit = accept_limit(den)
        if limit % den != 0 or not TWO_32 // 2 < limit <= TWO_32 or TWO_32 - limit >= den:
            raise AssertionError(f"limit for den {den} is wrong")


# ---------------------------------------------------------------------------
# Building the vectors
# ---------------------------------------------------------------------------


def derived_seed(label: str) -> str:
    """A fixed server seed: SHA-256 of a fixed label, as 64 lowercase hex."""
    return hashlib.sha256(label.encode("ascii")).hexdigest()


# Seeds: the docs seed, four seeds made from fixed labels, and two plain edge
# seeds (all '0' and all 'f'), which are still 64 lowercase hex.
SEEDS = [DOCS_SERVER_SEED] + [derived_seed(f"pump-fair-reference:seed:{i}") for i in range(4)] + [
    "0" * 64,
    "f" * 64,
]

# A 64-character client seed that uses every allowed character once.
ALL_CHARS_CLIENT_SEED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"

CLIENT_SEEDS = ["myseed", "a", "0", "_-_", ALL_CHARS_CLIENT_SEED, "-"]

# 9007199254740991 is 2**53 - 1, the largest whole number a JavaScript
# number holds exactly.
NONCES = [0, 1, 9, 10, 99, 100, 123456789, 9007199254740991]

BALLOONS = [0, 1, 2]
DRAWS = [0, 1, 2, 3, 4, 5]

# Denominators chosen to hit every branch of the limit:
#   1, 2, 4, 2**31, 2**32   divide 2**32: no word is ever thrown away
#   3, 7, 97, 101, 111      small: a handful of words at the top are thrown away
#   1000003                 a prime near a million
#   2**31 + 1               just under half of all words are thrown away,
#                           so later words and later blocks really get used
#   2**32 - 1               only the single word 0xffffffff is thrown away
DENS = [1, 2, 3, 4, 7, 97, 101, 111, 1000003, 2147483648, 2147483649, 4294967295, 4294967296]

# The den that throws away the most words; used for the searched cases.
HALF_DEN = 2**31 + 1

# How many searched cases to keep.
WANT_BLOCK_ONE = 6
WANT_BLOCK_TWO_PLUS = 3
WANT_WORD_INDEXES = [3, 4, 5, 6, 7]

# A hard stop for the search, far above what it needs (it finds everything
# in a few hundred thousand draws). Hitting it means something is broken.
SEARCH_LIMIT = 5_000_000


def draw_vector(server_seed: str, client_seed: str, nonce: int, balloon: int, draw: int, den: int) -> dict:
    result = roll(server_seed, client_seed, nonce, balloon, draw, den)
    return {
        "serverSeed": server_seed,
        "clientSeed": client_seed,
        "nonce": nonce,
        "balloonIndex": balloon,
        "drawIndex": draw,
        "den": den,
        "roll": result["roll"],
        "block": result["block"],
        "wordIndex": result["wordIndex"],
        "word": result["word"],
    }


def _draw_inputs(vec: dict) -> tuple:
    # The six inputs that decide a draw; equal inputs always give equal output.
    return tuple(vec[k] for k in ("serverSeed", "clientSeed", "nonce", "balloonIndex", "drawIndex", "den"))


def hmac_vector(server_seed: str, msg: str) -> dict:
    return {"serverSeed": server_seed, "message": msg, "hex": block_bytes(server_seed, msg).hex()}


def search_rare_draws() -> tuple:
    """Find draws at den = 2**31 + 1 that need more than block 0.

    About half of all words are thrown away at this den, so all 8 words of
    block 0 are thrown away about once in 256 draws (block 1 is used), and
    all 16 words of blocks 0 and 1 about once in 65,536 draws (block 2 or
    later is used). The search walks nonce 0, 1, 2, ..., and inside each
    nonce balloons 0 to 2 and draw indexes 0 to 5, always in the same order,
    so it finds the same cases every run.

    It also keeps the first block-0 draw whose kept word sits at each word
    index 3 to 7, so every word position inside a block is checked.
    """
    server_seed = SEEDS[1]
    client_seed = "_-_"
    block_one = []
    block_two_plus = []
    by_word_index = {}
    tried = 0
    nonce = 0
    while True:
        for balloon in BALLOONS:
            for draw in DRAWS:
                tried += 1
                if tried > SEARCH_LIMIT:
                    raise AssertionError("search for rare draws went on far too long")
                vec = draw_vector(server_seed, client_seed, nonce, balloon, draw, HALF_DEN)
                if vec["block"] == 1 and len(block_one) < WANT_BLOCK_ONE:
                    block_one.append(vec)
                elif vec["block"] >= 2 and len(block_two_plus) < WANT_BLOCK_TWO_PLUS:
                    block_two_plus.append(vec)
                elif (
                    vec["block"] == 0
                    and vec["wordIndex"] in WANT_WORD_INDEXES
                    and vec["wordIndex"] not in by_word_index
                ):
                    by_word_index[vec["wordIndex"]] = vec
                done = (
                    len(block_one) == WANT_BLOCK_ONE
                    and len(block_two_plus) == WANT_BLOCK_TWO_PLUS
                    and len(by_word_index) == len(WANT_WORD_INDEXES)
                )
                if done:
                    words = [by_word_index[i] for i in WANT_WORD_INDEXES]
                    return block_one, block_two_plus, words
        nonce += 1


# ---------------------------------------------------------------------------
# Reveal vectors
#
# Each one is a balloon as it ended (cashed on `rung` with `drawIndex` draws
# used, below its `topRung`), with the round's RTP, ladder, bet and payout
# cap, then the reveal this script works out for it. The ladders are copied
# from game-spec.json (testVectors.ladders, which never change), plus one
# made-up ladder to show nothing depends on the shipped ones.
# ---------------------------------------------------------------------------

LADDERS = [
    ("easy", DOCS_EASY_LADDER),
    ("medium", [106, 125, 148, 178, 218, 271, 342, 440, 575, 765, 1040, 1435, 2020, 2900,
                4250, 6350, 9700, 15000]),
    ("hard", [120, 163, 228, 330, 490, 755, 1210, 2000, 3450, 6200, 11600, 22800, 47000, 100000]),
    ("expert", DOCS_EXPERT_LADDER),
    ("made-up", [150, 300, 700, 2000]),
]
REVEAL_BETS = [10, 2000, 100000]

# How many searched reveals of each kind to keep.
WANT_LONG_TOP = 3        # reaches the top with 3 or more draws
WANT_LONG_POP = 3        # pops after 8 or more draws
WANT_LAST_RUNG = 2       # cashed one rung below a cap-locked top, per outcome
REVEAL_SEARCH_LIMIT = 100_000


def reveal_vector(server_seed: str, client_seed: str, nonce: int, balloon: int, rtp_bp: int,
                  ladder: list, bet: int, max_payout: int, rung: int, draw: int) -> dict:
    top = top_rung(ladder, bet, max_payout)
    result = reveal(server_seed, client_seed, nonce, balloon, rtp_bp, ladder, top, rung, draw)
    return {
        "serverSeed": server_seed,
        "clientSeed": client_seed,
        "nonce": nonce,
        "balloonIndex": balloon,
        "rtpBp": rtp_bp,
        "ladder": list(ladder),
        "betCents": bet,
        "maxPayoutCents": max_payout,
        "topRung": top,
        "rung": rung,
        "drawIndex": draw,
        "outcome": result["outcome"],
        "reachedRung": result["reachedRung"],
        "draws": result["draws"],
    }


def _reveal_inputs(vec: dict) -> tuple:
    # Everything that decides a reveal.
    return (vec["serverSeed"], vec["clientSeed"], vec["nonce"], vec["balloonIndex"], vec["rtpBp"],
            tuple(vec["ladder"]), vec["betCents"], vec["maxPayoutCents"], vec["rung"], vec["drawIndex"])


def _end_state(vec: dict) -> tuple:
    # The same, without the RTP: the RTP must not change a reveal.
    inputs = _reveal_inputs(vec)
    return inputs[:4] + inputs[5:]


def search_reveals() -> list:
    """Find reveals the grid may not have: long ones, and ones cashed one
    rung below a top that the payout cap set.

    Walks nonce 0, 1, 2, ... and balloons 0 to 2 in the same order every
    run, so it finds the same cases every time.
    """
    server_seed = SEEDS[4]
    client_seed = "a"
    easy = DOCS_EASY_LADDER
    expert = DOCS_EXPERT_LADDER
    long_top, long_pop, last_top, last_pop = [], [], [], []
    tried = 0
    nonce = 0
    while True:
        for balloon in BALLOONS:
            tried += 1
            if tried > REVEAL_SEARCH_LIMIT:
                raise AssertionError("search for reveals went on far too long")
            rtp = RTPS[(nonce + balloon) % len(RTPS)]
            saves = nonce % 3
            if len(long_top) < WANT_LONG_TOP:
                # Easy, cashed on rung 20 of 24: three draws to the top.
                vec = reveal_vector(server_seed, client_seed, nonce, balloon, rtp, easy, 2000,
                                    DOCS_MAX_PAYOUT_CENTS, 20, 20 + saves)
                if vec["outcome"] == "top":
                    long_top.append(vec)
            if len(long_pop) < WANT_LONG_POP:
                # Easy, cashed on rung 1: a pop after 8 or more draws.
                vec = reveal_vector(server_seed, client_seed, nonce, balloon, rtp, easy, 10,
                                    DOCS_MAX_PAYOUT_CENTS, 1, 1 + saves)
                if vec["outcome"] == "popped" and len(vec["draws"]) >= 8:
                    long_pop.append(vec)
            if len(last_top) < WANT_LAST_RUNG or len(last_pop) < WANT_LAST_RUNG:
                # Expert at $1,000: the cap sets the top at rung 6. Cashed on 5.
                vec = reveal_vector(server_seed, client_seed, nonce, balloon, rtp, expert, 100000,
                                    DOCS_MAX_PAYOUT_CENTS, 5, 5 + saves)
                kept = last_top if vec["outcome"] == "top" else last_pop
                if len(kept) < WANT_LAST_RUNG:
                    kept.append(vec)
            done = (len(long_top) == WANT_LONG_TOP and len(long_pop) == WANT_LONG_POP
                    and len(last_top) == WANT_LAST_RUNG and len(last_pop) == WANT_LAST_RUNG)
            if done:
                return long_top + long_pop + last_top + last_pop
        nonce += 1


def build_reveals() -> list:
    reveals = []

    # 1. The two examples from docs/fairness.md, first, at RTP 97%.
    docs_cases = [
        (DOCS_PATCH_NONCE, DOCS_EASY_LADDER, DOCS_PATCH_BET, 1, 2),
        (DOCS_CAP_NONCE, DOCS_EXPERT_LADDER, DOCS_CAP_BET, 5, 5),
    ]
    for nonce, ladder, bet, rung, draw in docs_cases:
        reveals.append(reveal_vector(DOCS_SERVER_SEED, DOCS_CLIENT_SEED, nonce, DOCS_BALLOON, 9700,
                                     ladder, bet, DOCS_MAX_PAYOUT_CENTS, rung, draw))
    # 2. The same two balloons at the other RTPs: the reveal must not change.
    for rtp in RTPS:
        if rtp == 9700:
            continue
        for nonce, ladder, bet, rung, draw in docs_cases:
            reveals.append(reveal_vector(DOCS_SERVER_SEED, DOCS_CLIENT_SEED, nonce, DOCS_BALLOON, rtp,
                                         ladder, bet, DOCS_MAX_PAYOUT_CENTS, rung, draw))

    # 3. A grid: every ladder and bet, cashed on rung 1, half way, and the two
    #    rungs below the top, with 0 to 2 Patch saves (draw count = rung +
    #    saves). The rung-1 balloons are made at all three RTPs; the others
    #    at one RTP each, turning over.
    k = 0
    for name, ladder in LADDERS:
        for bet in REVEAL_BETS:
            top = top_rung(ladder, bet, DOCS_MAX_PAYOUT_CENTS)
            for rung in sorted({1, top // 2, top - 2, top - 1} - {0}):
                saves = k % 3
                where = (SEEDS[k % len(SEEDS)], CLIENT_SEEDS[k % len(CLIENT_SEEDS)],
                         NONCES[k % len(NONCES)], BALLOONS[k % len(BALLOONS)])
                rtps = RTPS if rung == 1 else [RTPS[k % len(RTPS)]]
                for rtp in rtps:
                    reveals.append(reveal_vector(*where, rtp, ladder, bet, DOCS_MAX_PAYOUT_CENTS,
                                                 rung, rung + saves))
                k += 1

    # 4. Other payout caps, where a payout lands exactly on the cap: the
    #    made-up ladder with a $70 cap (a $10 bet reaches 7.00x and no
    #    further), and Expert at $20.01 under the real cap (one cent too much
    #    for 5,000x).
    made_up = LADDERS[-1][1]
    for i, (ladder, bet, max_payout) in enumerate([(made_up, 1000, 7000), (made_up, 1001, 7000),
                                                   (DOCS_EXPERT_LADDER, 2001, DOCS_MAX_PAYOUT_CENTS)]):
        top = top_rung(ladder, bet, max_payout)
        for rung in range(1, top):
            rtp = RTPS[(i + rung) % len(RTPS)]
            reveals.append(reveal_vector(SEEDS[3], "_-_", 9007199254740991, (i + rung) % 3, rtp,
                                         ladder, bet, max_payout, rung, rung + (i + rung) % 3))

    # 5. Searched cases.
    reveals.extend(search_reveals())

    # Keep only the first copy of any reveal made twice.
    unique = []
    seen = set()
    for vec in reveals:
        key = _reveal_inputs(vec)
        if key not in seen:
            seen.add(key)
            unique.append(vec)
    return unique


def build_vectors() -> dict:
    draws = []

    # 1. The worked example from docs/fairness.md, first.
    draws.append(draw_vector(DOCS_SERVER_SEED, DOCS_CLIENT_SEED, DOCS_NONCE, DOCS_BALLOON, DOCS_DRAW, DOCS_DEN))

    # 2. The rest of that round: all three balloons, draw indexes 0 to 5,
    #    same seed, client seed, nonce and den.
    for balloon in BALLOONS:
        for draw in DRAWS:
            if (balloon, draw) == (DOCS_BALLOON, DOCS_DRAW):
                continue
            draws.append(draw_vector(DOCS_SERVER_SEED, DOCS_CLIENT_SEED, DOCS_NONCE, balloon, draw, DOCS_DEN))

    # 3. Every seed with every den, twice, the other inputs turning over so
    #    each client seed, nonce, balloon and draw index shows up with each.
    for s, server_seed in enumerate(SEEDS):
        for d, den in enumerate(DENS):
            for turn in range(2):
                k = s + d + 7 * turn
                draws.append(
                    draw_vector(
                        server_seed,
                        CLIENT_SEEDS[k % len(CLIENT_SEEDS)],
                        NONCES[(3 * s + d + 5 * turn) % len(NONCES)],
                        BALLOONS[k % len(BALLOONS)],
                        DRAWS[(2 * s + d + turn) % len(DRAWS)],
                        den,
                    )
                )

    # 4. Every client seed with every nonce and every balloon. The seed, draw
    #    index and den turn over with a counter.
    counter = 0
    for c, client_seed in enumerate(CLIENT_SEEDS):
        for n, nonce in enumerate(NONCES):
            for balloon in BALLOONS:
                draws.append(
                    draw_vector(
                        SEEDS[counter % len(SEEDS)],
                        client_seed,
                        nonce,
                        balloon,
                        DRAWS[(c * len(NONCES) + n) % len(DRAWS)],
                        DENS[counter % len(DENS)],
                    )
                )
                counter += 1

    # 5. Two whole rounds with the biggest nonces: every balloon, draw
    #    indexes 0 to 5, the den turning over.
    for nonce in [123456789, 9007199254740991]:
        for balloon in BALLOONS:
            for draw in DRAWS:
                den = DENS[(balloon * len(DRAWS) + draw) % len(DENS)]
                draws.append(draw_vector(SEEDS[2], ALL_CHARS_CLIENT_SEED, nonce, balloon, draw, den))

    # 6. Searched rare cases at den = 2**31 + 1: later blocks and late words.
    block_one, block_two_plus, late_words = search_rare_draws()
    draws.extend(block_one)
    draws.extend(block_two_plus)
    draws.extend(late_words)

    # Two of the turning patterns above can land on the same inputs. Keep
    # only the first copy of each, so the order stays fixed.
    unique = []
    seen = set()
    for vec in draws:
        key = _draw_inputs(vec)
        if key not in seen:
            seen.add(key)
            unique.append(vec)
    draws = unique

    # Raw HMAC blocks, so a mismatch can be traced to the mixing step alone.
    hmac_blocks = []
    # The docs message, and the same draw at blocks 1 and 2.
    for block in [0, 1, 2]:
        hmac_blocks.append(hmac_vector(DOCS_SERVER_SEED, message(DOCS_CLIENT_SEED, DOCS_NONCE, DOCS_BALLOON, DOCS_DRAW, block)))
    # One message per seed, each with different parts.
    for s, server_seed in enumerate(SEEDS):
        msg = message(
            CLIENT_SEEDS[s % len(CLIENT_SEEDS)],
            NONCES[s % len(NONCES)],
            BALLOONS[s % len(BALLOONS)],
            DRAWS[s % len(DRAWS)],
            0,
        )
        hmac_blocks.append(hmac_vector(server_seed, msg))
    # The longest message the vectors use: 64-char client seed, biggest nonce.
    hmac_blocks.append(hmac_vector(SEEDS[3], message(ALL_CHARS_CLIENT_SEED, 9007199254740991, 2, 5, 0)))
    # Every block read by the searched draws: block 0 (all 8 words thrown
    # away), block 1, and block 2 where it was reached.
    for vec in block_one + block_two_plus:
        for block in range(vec["block"] + 1):
            msg = message(vec["clientSeed"], vec["nonce"], vec["balloonIndex"], vec["drawIndex"], block)
            hmac_blocks.append(hmac_vector(vec["serverSeed"], msg))

    seed_hashes = [{"serverSeed": s, "hash": seed_hash(s)} for s in SEEDS]

    return {
        "about": (
            "Made by fair_reference.py from the recipe in docs/fairness.md, "
            "using only the Python standard library and no game code."
        ),
        "seedHashes": seed_hashes,
        "hmacBlocks": hmac_blocks,
        "draws": draws,
        # Last, so the keys above stay byte for byte as they were.
        "reveals": build_reveals(),
    }


def check_coverage(doc: dict) -> None:
    """Stop if an edit to this script quietly drops required coverage."""
    draws = doc["draws"]
    first = draws[0]
    if (first["serverSeed"], first["clientSeed"], first["nonce"], first["den"], first["roll"]) != (
        DOCS_SERVER_SEED, DOCS_CLIENT_SEED, DOCS_NONCE, DOCS_DEN, DOCS_ROLL
    ):
        raise AssertionError("coverage: the docs example must come first")
    if len({_draw_inputs(v) for v in draws}) != len(draws):
        raise AssertionError("coverage: a draw appears twice")
    seen_seeds = {v["serverSeed"] for v in draws} | {v["serverSeed"] for v in doc["hmacBlocks"]}
    hashed = {v["serverSeed"] for v in doc["seedHashes"]}
    if len(hashed) < 4 or not seen_seeds <= hashed:
        raise AssertionError("coverage: every seed used needs a seed hash, and at least 4 seeds")
    needs = [
        ("client seed", "clientSeed", CLIENT_SEEDS),
        ("nonce", "nonce", NONCES),
        ("balloon", "balloonIndex", BALLOONS),
        ("draw index", "drawIndex", DRAWS),
        ("den", "den", DENS),
    ]
    for name, key, values in needs:
        missing = set(values) - {v[key] for v in draws}
        if missing:
            raise AssertionError(f"coverage: {name} values missing: {sorted(missing)}")
    half = [v for v in draws if v["den"] == HALF_DEN]
    if sum(1 for v in half if v["block"] == 1) < 5:
        raise AssertionError("coverage: need at least 5 block-1 draws at den 2**31 + 1")
    if sum(1 for v in half if v["block"] >= 2) < 2:
        raise AssertionError("coverage: need at least 2 block-2+ draws at den 2**31 + 1")
    if not {3, 4, 5, 6, 7} <= {v["wordIndex"] for v in draws}:
        raise AssertionError("coverage: need kept words at word indexes 3 to 7")
    blocks = [int(v["message"].rsplit(":", 1)[1]) for v in doc["hmacBlocks"]]
    if len(blocks) < 20 or 1 not in blocks or 2 not in blocks:
        raise AssertionError("coverage: need 20+ HMAC blocks including block 1 and block 2")
    check_reveal_coverage(doc)


def check_reveal_coverage(doc: dict) -> None:
    """Stop if an edit drops a reveal case the engine has to get right."""
    reveals = doc["reveals"]
    docs_firsts = [(DOCS_PATCH_NONCE, 1, 2, DOCS_PATCH_OUTCOME), (DOCS_CAP_NONCE, 5, 5, DOCS_CAP_OUTCOME)]
    for vec, (nonce, rung, draw, outcome) in zip(reveals, docs_firsts):
        got = (vec["serverSeed"], vec["clientSeed"], vec["nonce"], vec["rtpBp"], vec["rung"],
               vec["drawIndex"], (vec["outcome"], vec["reachedRung"]))
        if got != (DOCS_SERVER_SEED, DOCS_CLIENT_SEED, nonce, 9700, rung, draw, outcome):
            raise AssertionError("coverage: the two docs reveals must come first")
    if len({_reveal_inputs(v) for v in reveals}) != len(reveals):
        raise AssertionError("coverage: a reveal appears twice")
    hashed = {v["serverSeed"] for v in doc["seedHashes"]}
    if not {v["serverSeed"] for v in reveals} <= hashed:
        raise AssertionError("coverage: every reveal seed needs a seed hash")

    # Every reveal keeps the recipe's own rules.
    for i, v in enumerate(reveals):
        where = f"coverage: reveals[{i}]"
        if not 1 <= v["rung"] < v["topRung"] <= len(v["ladder"]) or v["drawIndex"] < v["rung"]:
            raise AssertionError(f"{where}: not a balloon that gets a reveal")
        if [d["drawIndex"] for d in v["draws"]] != list(range(v["drawIndex"], v["drawIndex"] + len(v["draws"]))):
            raise AssertionError(f"{where}: draw indexes must run on from the draw count")
        if not 1 <= len(v["draws"]) <= v["topRung"] - v["rung"]:
            raise AssertionError(f"{where}: too many draws")
        if v["outcome"] == "top" and v["reachedRung"] != v["topRung"]:
            raise AssertionError(f"{where}: a top reveal ends on the top rung")
        if v["reachedRung"] != v["rung"] + len(v["draws"]) - (1 if v["outcome"] == "popped" else 0):
            raise AssertionError(f"{where}: every draw but a last pop moves up one rung")

    def count(test) -> int:
        return sum(1 for v in reveals if test(v))

    needs = [
        ("a top reveal with 2+ draws", 3, lambda v: v["outcome"] == "top" and len(v["draws"]) >= 2),
        ("a popped reveal with 3+ draws", 5, lambda v: v["outcome"] == "popped" and len(v["draws"]) >= 3),
        ("a reveal that pops on its first draw", 3, lambda v: v["outcome"] == "popped" and len(v["draws"]) == 1),
        ("a Patch-saved balloon (draw count above the rung)", 5, lambda v: v["drawIndex"] > v["rung"]),
        ("a cap-locked top rung", 5, lambda v: v["topRung"] < len(v["ladder"])),
        ("rung = top - 1 that reaches the top", 2, lambda v: v["rung"] == v["topRung"] - 1 and v["outcome"] == "top"),
        ("rung = top - 1 that pops", 2, lambda v: v["rung"] == v["topRung"] - 1 and v["outcome"] == "popped"),
        ("a top payout exactly at the cap", 1,
         lambda v: v["betCents"] * v["ladder"][v["topRung"] - 1] == v["maxPayoutCents"] * 100),
        ("a payout cap other than $100,000", 1, lambda v: v["maxPayoutCents"] != DOCS_MAX_PAYOUT_CENTS),
        ("the largest safe nonce", 1, lambda v: v["nonce"] == 9007199254740991),
        ("the made-up ladder", 1, lambda v: v["ladder"] == LADDERS[-1][1]),
    ]
    for name, least, test in needs:
        if count(test) < least:
            raise AssertionError(f"coverage: need at least {least} reveals with {name}")
    for key, values in (("balloonIndex", BALLOONS), ("rtpBp", RTPS)):
        missing = set(values) - {v[key] for v in reveals}
        if missing:
            raise AssertionError(f"coverage: reveals missing {key} {sorted(missing)}")

    # The same end state at 9400, 9700 and 9900 gives the same reveal.
    groups = {}
    for v in reveals:
        groups.setdefault(_end_state(v), []).append(v)
    full = [g for g in groups.values() if {v["rtpBp"] for v in g} == set(RTPS)]
    if len(full) < 5:
        raise AssertionError("coverage: need 5+ end states played at all three RTPs")
    for group in groups.values():
        if len({json.dumps([v["outcome"], v["reachedRung"], v["draws"]]) for v in group}) != 1:
            raise AssertionError("coverage: a reveal changed with the RTP")


def render(doc: dict) -> str:
    # 2-space indent, keys kept in the order written above, one trailing
    # newline. Every value is ASCII, so the bytes are the same everywhere.
    return json.dumps(doc, indent=2, ensure_ascii=True) + "\n"


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(description="Independent reference for Pump's draw recipe.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="rebuild in memory and fail if the committed vectors.json differs",
    )
    args = parser.parse_args(argv)

    check_docs_example()
    check_docs_round()
    check_docs_reveals()
    check_input_rules()
    doc = build_vectors()
    check_coverage(doc)
    text = render(doc)

    if args.check:
        if not VECTORS_PATH.exists():
            print(f"FAIL: {VECTORS_PATH} does not exist", file=sys.stderr)
            return 1
        if VECTORS_PATH.read_bytes() != text.encode("ascii"):
            print(f"FAIL: {VECTORS_PATH} differs from what this script makes", file=sys.stderr)
            return 1
        print(f"OK: {VECTORS_PATH.name} matches ({len(doc['draws'])} draws, {len(doc['reveals'])} reveals)")
        return 0

    VECTORS_PATH.write_bytes(text.encode("ascii"))
    print(
        f"wrote {VECTORS_PATH.name}: {len(doc['seedHashes'])} seed hashes, "
        f"{len(doc['hmacBlocks'])} HMAC blocks, {len(doc['draws'])} draws, "
        f"{len(doc['reveals'])} reveals"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
