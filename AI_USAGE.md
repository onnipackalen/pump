# AI usage

## Tools

- Claude Code, in the desktop app.
- I ran several chats at once, each with one job: the math, the fairness
  code, the server, the screen, the graphics, reviews, and one chat that
  decided what went into `main` and in what order.

## What I did, and what the AI did

- The AI wrote nearly all of the code, the tests and the scripts. It also
  drafted these write-ups from my notes and messages, and I went through
  them and corrected them.
- I made the design calls:
  - the four ladders. I kept the long, gentle Easy over a shorter one the
    AI designed.
  - rounding (see below).
  - no limit on Patch prices. The AI suggested a $1,000 cap. I said no,
    because every Patch already returns the RTP and its price is on the
    button before you buy.
  - the after-round reveal, the start animation, the phone layout and
    auto-bet.
- I decided what had to be checked. Separate chats had one job: try to
  break the math, the wallet and the fairness code. Most pieces went
  through one of them before going into `main`. Before I submitted, one
  last chat checked everything against the brief.
- I played Stake's Pump and two similar games, then ours, and sent back
  what was wrong (see PLAYTEST.md).

## Rounding was my call

- At first I asked for random rounding: round up or down at random, so the
  average comes out exact. The math chat built it and had it checked.
- The same day I switched back to floor for payouts and ceiling for Patch
  prices:
  - The brief says rounding may push the RTP just under, never over. With
    floor and ceiling, no single payment is ever above its exact value.
    With random rounding, some payments round up.
  - Random rounding needs a second random draw just for money, and players
    would have to check that too. The fairness code, the player guide and
    its test vectors all assume one draw per pump.
- The cost: tiny bets get back a little less than 97%. `npm run rtp`
  prints the worst cases instead of hiding them.

## Where the AI was wrong

What I caught myself:

- **Two chats built the game engine at once**, in the first hour. I
  stopped them and gave each part one owner. Two engines could disagree
  on whether a pump pops, and then the verify page would not match the
  server.
- **The last balloon lost its Pump button.** With three balloons, once
  two had popped, the third one's Pump button disappeared. It now keeps
  its own button.
- **"Play until infinity."** I asked for a mode to play until infinity. I
  meant something more like a rocket game. A chat read it as auto-play
  with endless rounds and built that, tests and all. I had it scrapped.

The math mistake I should have caught:

- The first simulator (`npm run sim`) took its expected numbers from the
  engine it was testing. It was checking the engine against itself.
- A review chat proved this by breaking the engine on purpose. Pump 1
  popped too often, so the game paid about 92.6% instead of 97%, and the
  simulator still said PASS. A doubled Patch price passed too, and so did
  payouts one cent off.
- The fix: `packages/engine/cli/rules.ts` works out every expected number
  from the config alone and never calls the engine. The simulator and
  `npm run rtp` now measure against it (commits 34c0b3f, 8d21551 and
  12b19fa). The tests give the simulator engines that are wrong on
  purpose and expect FAIL.
- I should have asked one question at the start: what would make this
  check fail? If nothing can, it proves nothing.
