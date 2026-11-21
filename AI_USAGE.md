# AI usage

**Tools.** Claude Code (the desktop app), with several chats at once, each
with one job: the math, the fairness code, the server, the screen, the
graphics, reviews, and one chat that decided the order things went into
main.

**What I delegated and what I did.** Claude wrote nearly all of the code, the
tests and the scripts. I gave each chat its job and made the design calls:
the ladders, rounding that always favours the house, the after-round reveal,
the start animation and the phone layout. I played competitors' games and
ours, and sent back what was wrong. Most pieces were checked by a separate
review chat before they went into main.

**Where the AI was wrong and I caught it.**

- In the first hour, two chats started building the game engine at the same
  time. I stopped them and gave each part one owner. Two engines could
  disagree on whether a pump pops, and then the verify page would not match
  the server.
- Playing with three balloons, I found that the last balloon's Pump button
  disappeared once the other two had popped. It now keeps its own button.
