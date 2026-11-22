# Playtest

- **When:** Friday evening, 20 November, about 40 minutes in all.
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
   on a computer, a strip under the game on a phone.
4. **Public wins.** Recent, Biggest and Lucky lists at the bottom of the
   page, with a "Keep my wins private" setting. It's built, but switched
   off on the live site for now (the `PUBLIC_WINS` setting).
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
