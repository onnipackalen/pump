#!/usr/bin/env python3
"""Independent reference for Pump's provably fair draw recipe.

This file is written only from two places: the "Provably fair" section of
CLAUDE.md and docs/fairness.md. It does not import, read or copy any of the
game's code. Its job is to be a second, separate implementation of the same
recipe, so the TypeScript engine can be checked against it.

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
        print(f"OK: {VECTORS_PATH.name} matches ({len(doc['draws'])} draws)")
        return 0

    VECTORS_PATH.write_bytes(text.encode("ascii"))
    print(
        f"wrote {VECTORS_PATH.name}: {len(doc['seedHashes'])} seed hashes, "
        f"{len(doc['hmacBlocks'])} HMAC blocks, {len(doc['draws'])} draws"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
