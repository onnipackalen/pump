# Playtest

On Friday evening (20 November) I played Stake's Pump, then two games like
it: SmartSoft's Balloon and InOut's Chicken Road. That was about 40 minutes
in all, and I spoke my notes as I played. Then I went back to ours, which I
had also been playing while it was being built.

## What theirs does better

**Stake: Pump**

- **Public wins.** You can see other people's wins, and their lucky wins. I
  wanted their biggest wins too.
- **Auto-bet.** More control: it can change the bet by itself after a win
  or after a loss. In auto mode you can still cash out by hand.
- **Start animation.** It starts from a flat, empty balloon that pumps up by
  itself, and the view zooms out slowly so you see it grow next to the pump.
- **Live stats.** You pull them out and keep them next to the game, with a
  profit line. I really liked this.
- **The level shows on the pump.** Dots on the bottom of the pump show the
  difficulty. I didn't want red dots, but some small colour for the level.
- **Multipliers on top.** In auto mode a row along the top shows the
  multipliers you've reached and the ones coming next, and it scrolls.
- **It uses the space.** We had a lot of empty space at the top, and our
  balloon needed to grow more.
- **Switching levels is easy.**
- I really like its look, but I also like our pump.

**SmartSoft: Balloon**

- The balloon starts lying on the floor, then rises slowly. I really liked
  that. I didn't like the colours.

**InOut: Chicken Road**

- A really good anxious feel, and very clear jumps between levels. Our pump
  already does the jumps well.

## What I changed in ours because of it

1. **Auto-bet.** Besides what the brief asks for (number of rounds, target
   pumps, stop on profit, stop on loss), it can change the bet after a win
   or a loss, like Stake. You can still cash out by hand during auto-play.
2. **Start animation.** I mixed Stake and SmartSoft. When you bet, a small
   flat balloon goes on the end of the hose, lying on the floor, and the view
   moves in a little. It stays there until your first pump. Then it lifts
   off, blows up, and the view eases back out.
3. **Live stats.** Profit over the session with a line, next to the game on
   a computer and as a strip under the game on a phone.
4. **Public wins.** Recent, Biggest and Lucky lists, at the bottom of the
   page, with a "Keep my wins private" setting. It's built, but switched off
   on the live site for now (the `PUBLIC_WINS` setting).
5. **The space at the top.** The balloon grows more in its early pumps, and
   each balloon has its own row of multiplier steps: in the space at the top
   on a computer, under the balloon on a phone with one balloon, and a small
   "next 1.23×" in each Pump button with two or three balloons. On phones I
   only added things where there was clearly room, and nothing covers the
   balloons or the sky they grow into.
6. **Level colour on the pump.** A small colour on the pump for the
   difficulty, not red dots.
7. **Off switches.** Some of this may not be allowed everywhere (Ontario, for
   example), so the extras can be turned off. The README lists every switch.

I didn't copy Stake's look. I kept ours.

## What I found playing ours

- Pump, Patch and Cash out were too easy to mix up, so Patch got its own
  clear button.
- On a phone you couldn't start a new round after one ended, because the bet
  panel popped up and squeezed the balloon. Now you scroll down to bet, and
  on an upright phone the bet panel is a sheet you swipe up.
- With three balloons, the last balloon's Pump button disappeared once the
  other two had popped. Now each balloon keeps its own Pump.
- Changing the number of balloons or the difficulty didn't show until the
  next round. Now the screen changes at once and slides into place.
- Auto-play's target was fiddly to change, so it got − and + buttons.
