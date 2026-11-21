# Pump graphics

Made by Claude (AI): list it in AI_USAGE.md.

The game's art lives where the game uses it, so there is only one copy.

| What | Where |
|---|---|
| Balloon, floor pump and hose, and every attribute they take | `apps/web/src/balloon/Balloon.tsx` |
| Balloon colours and every animation | `apps/web/src/balloon/balloon.css` (app-side switches in `balloon-app.css`) |
| Favicon and app icons | `apps/web/public/` |

## Rules

- Mint is only for real wins. Grey is only for pops.
- The "would have popped" reveal shows only once the whole round is over, and is drawn plainly: no win colour, no celebration and no "so close" wording.
- Animate only `transform` and `opacity`.
