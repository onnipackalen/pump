# Playtest

- **Not just one session.** I went back to the other games again and
  again while ours was built, not only in the session below. I judged them
  critically: what they do well came over into ours, and I looked at their
  flaws to make sure ours didn't copy them.
- **Some of their flaws:**
  - SmartSoft's Balloon: to me its graphics were a bit over the top, and I
    didn't like the colours. I felt this game needed calm, simple graphics,
    more like Stake's.
  - Stake marks the level with red dots on the pump. I didn't want red
    dots, so ours shows a small colour instead.
- **The sit-down session:** Friday evening, 20 November, about 40 minutes
  in all.
- **What:** Stake's Pump first, then two similar games: SmartSoft's
  Balloon and InOut's Chicken Road. I spoke my notes out loud as I played.
- **Then ours.** I had also been playing it at points while it was built.

## What theirs does better

Stake: Pump

- Public wins. You can see other people's wins and lucky wins. I wanted
  their biggest wins too.
- Auto-bet gives more control: it can change the bet by itself after a win
  or a loss, and you can still cash out by hand in auto mode.
- The start. The balloon begins flat and empty and pumps up by itself,
  and the view slowly zooms out so you see it grow next to the pump.
- Live stats. You pull them out and keep them next to the game, with a
  profit line. I really liked this.
- The level shows on the pump: dots on its base show the difficulty. I
  didn't want red dots, just a small colour for the level.
- Multipliers along the top. In auto mode a row shows the multipliers you
  have reached and the next ones, and it scrolls.
- It uses the space. We had a lot of empty space at the top, and our
  balloon needed to grow more.
- Switching levels is easy.
- Its house edge seems to come from the inflating. (In ours it all sits on
  the first pump; the README shows why.)
- I really like its look, but I also like our pump.

SmartSoft: Balloon

- The balloon starts lying on the floor, then rises slowly. I really liked
  that. I didn't like the colours.

InOut: Chicken Road

- A really good anxious feel, and very clear jumps between levels. Our
  pump already does the jumps well.

## What I changed in ours because of it

1. **Auto-bet.** On top of what the brief asks for (number of rounds,
   target pumps, stop on profit, stop on loss), it can change the bet
   after a win or a loss, like Stake. You can still cash out by hand
   during auto-play.
2. **Start animation.** A mix of Stake and SmartSoft. When you bet, a small
   flat balloon goes on the end of the hose, lying on the floor, and the
   view moves in a little. It waits there for your first pump, then lifts
   off and blows up while the view eases back out.
3. **Live stats.** Profit over the session with a line: next to the game
   on a computer, at the bottom of the bet panel on a phone (the chart
   button slides the panel up to it, so Bet never moves).
4. **Public wins.** Recent, Biggest and Lucky lists at the bottom of the
   page, with a "Keep my wins private" setting. The live site shows them.
5. **The space at the top.** The balloon grows more in its early pumps.
   Each balloon has its own row of multiplier steps:
   - on a computer, in the space at the top
   - on a phone with one balloon, under the balloon
   - with two or three balloons, a small "next 1.23×" in each Pump button

   On phones I only added things where there was clearly room. Nothing
   covers the balloons or the sky they grow into.
6. **Level colour on the pump.** A small colour for the difficulty, not
   red dots.
7. **Off switches.** Some of this may not be allowed everywhere (Ontario,
   for example), so the extras can be turned off. The README lists every
   switch.

I didn't copy Stake's look. I kept ours.

## What I found playing ours

Bugs:

- Pump, Patch and Cash out were too easy to mix up, so Patch got its own
  clear button.
- On a phone you couldn't start a new round after one ended: the bet panel
  popped up and squeezed the balloon. Now you scroll down to bet, and on an
  upright phone the bet panel is a sheet you swipe up.
- With three balloons, the last one's Pump button disappeared once the
  other two had popped. Now each balloon keeps its own Pump.
- Changing the number of balloons or the difficulty didn't show until the
  next round. Now the screen changes at once and slides into place.
- Auto-play's target was fiddly to change, so it got − and + buttons.

Other changes I asked for:

- **Less on the screen.** The first screen had hint sentences, a stats grid
  under every balloon and side panels. I showed the chat Stake's screen and
  asked for almost no sentences, big numbers, and settings always one tap
  away.
- **Ladders tuned for fun.** I asked whether the ladders were tuned for
  enjoyment. They weren't: Easy popped 9% to 17% of the time on every pump
  after the first, there were no round rungs like 2x, 5x or 10x, and a
  $1,000 bet topped out at $62,000 on Hard. They were redesigned with round
  rungs, and a rung at exactly 100x so the top bet can win the full cap.
- **Only signs real games use.** Several made-up graphics were taken out:
  a seal on top, a grid of dots for the odds, a ghost outline after a pop,
  a cash-out tick and a tape sticker for the Patch. The Patch shows in
  words instead.
- **Bet at the top.** I had the bet panel's order reversed, so Bet comes
  first.
- **Phone and computer don't look the same.** The swipe-up sheet is for
  phones only. A computer keeps the panel as a card beside the game.
- **No snapping back.** After a round, the old pump was swapped for a fresh
  one in a single frame. Now the new pump sets itself up with a short
  animation.
- **The air going up the hose.** I asked for the hose itself to swell as
  the air goes up, not a dot on top of it. I spotted the first version
  sticking out of the hose at the bend, picked the size of the swell, and
  had the flashing removed while it waits.
- **Tension on every level.** The balloon's strain now follows each
  ladder's own range of pop chances, so Easy builds up too, not just
  Expert.
- **Three balloons on a phone.** This was the hardest fit. With two or three
  balloons, each Pump button shows a small "next 1.23×" instead of a full
  row of steps.

## Still to improve

- **The smallest phone held sideways** (568 × 320) still has to scroll
  inside the bet panel.
- **The sheet's handle is only a picture.** Tapping it does nothing; you
  have to swipe.
- **Easy's pace.** I'm not entirely sure about how slowly it builds.
- **A mode that keeps growing, like a rocket game.** I'd like to make one,
  but I decided not to.
- **Patches on tiny bets.** On Easy with small bets, some Patches cost as
  much as the step can win. See whether players buy them.
- **Stake's tap-a-step.** On Stake you can tap a future step to see its
  profit and chance. I haven't decided whether we want it.
