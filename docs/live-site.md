# The live site

The game is live at **<https://pump-wysj.onrender.com>**.

- It runs on [Render](https://render.com): one web service with one 1 GB
  disk, set up from `render.yaml` in this repo.
- No setting is typed in by hand on Render's pages, and none should be
  changed there: Render puts back what `render.yaml` says.
- It costs about 7.25 US dollars a month (7 for the server, 0.25 for the
  disk), less for part of a month. A service with a disk needs a paid plan,
  so add a payment card under Billing on Render first.

## Setting it up from nothing

1. `main` on GitHub must contain `render.yaml`, with a green check on its
   newest commit.
2. On Render choose **New > Blueprint**. Under **Public Git Repository**
   paste this repository's address and continue. (Connecting Render to
   GitHub works too, but isn't needed: the repository is public.) Give the
   Blueprint any name and leave the branch as `main`.
3. Render lists what `render.yaml` will create: a web service named `pump`.
   If the file has a mistake, Render shows it here instead. Choose
   **Deploy Blueprint**.
4. When the deploy is live, open the `onrender.com` address shown on the
   service's page.

Then check it, once:

- The service's Disk page shows a 1 GB disk mounted at `/var/data`.
- Search the service's log for `the database file is`. The line is printed
  at every start and must name `/var/data/pump.db`.
- Play a round and note the balance. Choose **Manual Deploy > Deploy latest
  commit**, wait until it is live, reload the game in the same browser, and
  check the balance is the same. A fresh $10,000 means the database was
  lost. After this second start the log must say `opened the existing
  file`, not `made a NEW, EMPTY file`.

If the first deploy fails, don't make a second Blueprint: that creates a
second paid service with its own empty disk. Fix the cause, push, and
deploy the same service again.

## Deploying a new version

- Push to `main`, wait for the green check on GitHub, then on the service's
  page choose **Manual Deploy > Deploy latest commit**.
- Render isn't connected to the repository, so a push doesn't deploy by
  itself (seen on 2026-11-20: a push with a green check started nothing).
- Use "Deploy latest commit" only. "Deploy a specific commit" also switches
  automatic deploys off.
- The site is down for a few seconds on each deploy. Render stops the old
  copy before starting the new one, so two versions never write to the same
  database. Balances and rounds in play are kept.
- A Manual Deploy builds the new code but does not apply `render.yaml`'s
  settings. Only a Blueprint sync does. To change a setting, such as
  `PUBLIC_WINS`, change it in `render.yaml`, push, sync the Blueprint on
  Render, then read the log: for public wins, the `public wins:` line.
- Public wins are on: `render.yaml` sets `PUBLIC_WINS` to `"on"`, and the
  Blueprint was synced on 2026-11-22.

## Where the wallets are

- Every wallet is in one file on the disk, `/var/data/pump.db`. Render keeps
  only what is on the disk; the rest of the machine is thrown away on every
  deploy and restart.
- So a missing setting or a missing disk can't quietly lose the wallets,
  the server won't start on a host unless `DATABASE_PATH` is set and its
  folder already exists (`apps/server/src/db/location.ts`).
- The server can't tell the disk from any other folder that exists, so
  `DATABASE_PATH` and the disk's mount path are changed only in
  `render.yaml`, both together, never on Render's pages.

## Never roll back

Never put an older version of the server back on the live site: not with
Render's Rollback button, not with "Deploy a specific commit", and not by
undoing a change on `main` and deploying that.

- A newer version may have added a step to the database that older code
  can't follow. On such a database an older server fails half way through
  some actions, and a pump that fails only when it would end the round
  tells the player what that pump would do.
- The server now refuses to start on a database that a newer version has
  changed (`migrate` in `apps/server/src/db/migrations.ts`), so the mistake
  is loud instead of quiet.
- Each database step is one-way. Once step 2 (the after-round reveal) or
  step 3 (keeping wins private) has run on the live database, no version
  from before that step may be deployed there again.
- If something is wrong after a deploy, fix it with a new commit and deploy
  that.

## Backups and taking it down

- Never delete the service while the site is in use: the wallets are on its
  disk.
- Render snapshots the disk once a day and keeps each snapshot for a week.
  That is a last resort, not a backup: restoring one puts the whole disk
  back to that moment, so every round and payout since is gone, and Render
  warns that a database restored this way can come back damaged.
- When the site is no longer needed: on the Blueprint's Settings page set
  Auto Sync to No, then delete the `pump` service. That destroys every
  wallet for good. Afterwards, check the Billing page to see the charges
  stopped.
