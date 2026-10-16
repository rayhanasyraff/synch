# SilverBullet + Synch (Railway)

A separate Railway service that runs [SilverBullet](https://silverbullet.md) as
a browser editor over a plaintext working copy of one **existing** Synch remote
vault, kept in sync by the Synch CLI (`synch watch`). The Synch API, its volume,
and its deployment are not touched.

```
Obsidian (desktop/phone) ──▶ Synch API (@synch/api, unchanged) ◀── synch watch ─┐
                                                                                 │ same folder
                                         browser ──HTTPS──▶ SilverBullet ◀────────┘ /data/space
```

## Security model — read first

This service holds **plaintext notes** and the **decrypted vault key**:

- `/data/space` contains every synced note and attachment in plaintext.
- `/data/synch-config/synch/credentials.json` contains the Synch session token
  and the raw remote vault key (base64, file mode 0600). Anyone with access to
  this volume, the service shell (`railway ssh`), or Railway's infrastructure
  can read all notes and decrypt the remote vault, including its history.

End-to-end encryption still protects data at rest in the Synch API, but this
service is a trusted endpoint, like an unlocked Obsidian device.

Other properties:

- SilverBullet login is required. The container refuses to start unless
  `SB_USER` is `user:password` with a password of at least 16 characters.
- Credentials live outside the folder SilverBullet serves. SilverBullet 2.12.1
  also refuses every dot-prefixed path (`.synch/`, `.silverbullet.auth.json`)
  over HTTP; the image pins that release.
- Notes can contain Space Lua, which SilverBullet runs in your browser. Any
  device that can write to this vault can therefore plant scripts that run in
  your SilverBullet session.

### Process isolation

SilverBullet and the Synch CLI run as different users, so a compromised
SilverBullet process cannot read the vault key or tamper with sync state:

| Path / process | Owner | Mode | `synch` (CLI) | `silverbullet` |
|---|---|---|---|---|
| `/data/synch-config` (session token, vault key) | `synch` | `0700` / files `0600` | read/write | **no access** |
| `/data/space/.synch` (sync state) | `synch` (dir group `notes`) | dir `0750`, files `0600` (group `synch`) | read/write | lists file names only (needed by SilverBullet's file watcher); **cannot read or change** contents (can delete/replace the directory itself — see below) |
| `/data/space` (notes) | group `notes` | dirs `2770`, files `0660` | read/write | read/write |
| `/data/space/.silverbullet*` | `silverbullet` | SilverBullet's own | — | read/write |
| `synch watch` process | uid `synch` (10001) | no capabilities, `no_new_privs` | | cannot read its memory or `/proc/<pid>/environ` |
| SilverBullet process | uid `silverbullet` (10002) | no capabilities, `no_new_privs` | | |

The entrypoint stays root (PID 1 under `tini`) only to repair this layout on
every boot, run the preflight as `synch`, and start the two children. The image
has no setuid binaries. Operator commands run through `railway ssh` (a root
shell) re-launch themselves as `synch`. The CLI process never receives
`SB_USER` or `SB_AUTH_TOKEN`. Isolation requires the container to start as root:
do **not** set `RAILWAY_RUN_UID`; if the container starts as another user, the
logs warn that isolation is off.

Because SilverBullet can create files (and symlinks) in the shared notes
folder, the boot-time ownership and permission steps never follow a symlink or
descend through one (`! -type l`, `chgrp -h`), so a planted symlink cannot
redirect a `chown`/`chmod` onto a path outside the notes folder. The entrypoint
also validates `/data/space/.synch` before trusting or re-owning it: it must be
a real directory (never a symlink) owned by `synch`. If it is not — for example
if the SilverBullet user replaced it — the service stops in maintenance mode and
does **not** modify it, so an operator can inspect it.

What this isolation does and does not cover:

- **Covered:** the SilverBullet user cannot read `/data/synch-config` or the
  decrypted vault key, cannot read or alter the `.synch` sync-state contents,
  cannot read the CLI process's memory or environment, and cannot escalate
  through the boot-time permission fixes.
- **Not covered (shared by design):** both users can read and change every
  **note**, so a compromised SilverBullet can alter or delete notes, and those
  changes sync to every device. SilverBullet can also rename or delete the
  `.synch` directory itself (its parent is group-writable); the next boot
  detects a substituted `.synch` and refuses to start rather than trusting it,
  but a plain deletion is recovered like any other (a fresh first sync).
  Isolation is an in-container privilege boundary, not protection against a
  malicious note author.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | Builds the CLI bundle from only the files it needs, adds the pinned, checksum-verified SilverBullet 2.12.1 server binary, creates the `synch`/`silverbullet` users, and runs both under `tini`. Base images are pinned by digest; the header explains how to update them. |
| `entrypoint.sh` | Validates configuration, runs the preflight, then supervises SilverBullet and `synch watch`, or stays in maintenance mode. |
| `lib/preflight.mjs` | Read-only startup guard (see below). |
| `lib/as-synch` | Runs operator commands as `synch` when started as root. |
| `bin/synch` | The guarded `synch` command on `PATH` (see below). |
| `lib/synch-unguarded` | Direct CLI entry for the entrypoint and `synch-first-sync` only. |
| `bin/synch-first-sync` | Interactive connection: first download, resume, or reconnect after `synch logout`. |
| `bin/synch-list-vaults` | Lists the account's vaults (IDs and names only, never the token). |
| `bin/synch-preflight` | Prints the preflight verdict. |
| `test/` | Unit tests: `node --test "deploy/silverbullet/test/*.test.mjs"` (Linux, Node >= 22.18); fixtures in `test/helpers.mjs` use the CLI's real sync-store schema. `test/symlink-regression.sh` runs inside the built image (as root) and checks the boot-time permission hardening against planted symlinks. |

## How startup works

1. `entrypoint.sh` refuses to start without `SB_USER`, `SYNCH_VAULT_ID`, and
   `SYNCH_API_URL`, warns loudly if `SYNCH_CONFIRM_DELETE_COUNT` (or the
   retired, ignored `SYNCH_ALLOW_MASS_DELETE`) is set,
   creates `/data/space` and `/data/synch-config`, applies the ownership and
   permissions above, and removes a stale `/data/space/.synch/cli.lock` (only
   this container mounts the volume).
2. With `NOTES_MAINTENANCE=1` it goes straight to maintenance mode (below).
3. Otherwise `lib/preflight.mjs` inspects the credentials and the CLI sync
   store, read-only, and decides:
   - **ready**: the folder is connected to `SYNCH_VAULT_ID`, its sync store is
     bound to the same vault, the first sync has completed, and the files the
     store knows about are still present.
   - **maintenance**: not signed in or connected, the first sync has not
     completed, or a guard tripped (connected to another vault, unreadable
     credentials or store, or most known files missing). SilverBullet and sync
     both stay **off**; the container idles so you can `railway ssh` in.
4. When ready, it starts `synch watch --vault /data/space` and
   `silverbullet --single /data/space` on `$PORT`. If either process exits, the
   other is stopped and the container exits non-zero, so SilverBullet never
   accepts edits while sync is down. Railway's restart policy brings both back;
   `synch watch` rescans the folder on start, so edits made before a crash are
   still uploaded. On `SIGTERM` (redeploy or stop) both are stopped cleanly.

### Why these guards

From the sync engine (`packages/sync-client/src/sync/engine/local-reconcile-service.ts`):

- A file that this copy synced before and that is now missing is uploaded as a
  **delete**. An emptied or replaced `/data/space` with an intact `.synch/`
  store would delete every note on every device. The preflight blocks start
  when the missing files are **at least half** of the tracked files (so it
  catches a small vault, e.g. 24 of 25 gone), **or** at least 25 files are
  missing in absolute terms (a safety net for large vaults). It prints the
  exact deletion and a confirmation token (see `SYNCH_CONFIRM_DELETE_COUNT`
  below). This is a **startup** guard only: it cannot stop deletions made while
  the service is already running (those sync like any edit).
- A local file at a path that exists remotely is uploaded as a new revision.
  The first sync therefore only runs into an empty folder, and SilverBullet
  never runs before it (SilverBullet seeds `index.md` into an empty space).
- Resuming an interrupted first sync, or reconnecting after `synch logout`,
  keeps the existing `.synch/` store. `synch-first-sync` only allows that when
  the folder matches the store exactly (no known file missing, no unknown file
  added); otherwise the sync would delete or overwrite remote notes. The safe
  way to start over is to delete **everything** in `/data/space`, including
  `.synch/`.

## Railway settings (service `silver-bullet`)

| Setting | Value |
|---|---|
| Source | GitHub `rayhanasyraff/synch`, the branch that contains `deploy/silverbullet/` |
| Root Directory | `/` (repository root; the build needs the workspace) |
| Builder | Dockerfile; path `deploy/silverbullet/Dockerfile` (or variable `RAILWAY_DOCKERFILE_PATH=deploy/silverbullet/Dockerfile`) |
| Volume | **New** volume attached to `silver-bullet`, mounted at `/data`. Never attach `@synch/api-volume`. |
| Replicas | 1 (volumes do not support more) |
| Restart policy | **Always**, or On Failure with a high retry limit. With a low limit, an API outage during restarts (see below) can exhaust the retries and leave the service stopped until you redeploy. |
| `RAILWAY_RUN_UID` | Leave unset (process isolation needs the container to start as root). |
| Healthcheck | None (maintenance mode intentionally serves nothing) |
| Public networking | **Leave disabled** until the first sync is done; then Generate Domain (Railway routes it to `$PORT`, which SilverBullet listens on) |
| Draining seconds (optional) | e.g. 10, so `synch watch` can finish an in-flight upload on redeploy (unfinished work is retried after restart either way) |
| Watch paths (optional) | `/deploy/silverbullet/**`, `/apps/cli/**`, `/packages/sync-client/**`, `/packages/vault-crypto/**`, `/pnpm-lock.yaml` |

### Variables

| Variable | Required | Value |
|---|---|---|
| `SB_USER` | yes, secret | `username:password`; generate a long random password (>= 16 characters). |
| `SYNCH_VAULT_ID` | yes | ID of the existing remote vault. Until you know it, use a placeholder such as `unknown`; nothing connects to it (see below). |
| `SYNCH_API_URL` | yes | `https://synchapi-production.up.railway.app` |
| `NOTES_MAINTENANCE` | no | `1` keeps SilverBullet and sync stopped regardless of state, for shell work (re-login, inspecting or restoring files). |
| `SB_LOCKOUT_LIMIT`, `SB_LOCKOUT_TIME` | no | SilverBullet login lockout (defaults 10 attempts / 60 s). |
| `SYNCH_CONFIRM_DELETE_COUNT` | no | Confirms **one** intended mass deletion. Set it to the `count:fingerprint` token the blocked start printed (for example `24:3f9ab0c1`). It applies only while exactly that set of files is missing: the count must match **and** the fingerprint (a hash of the exact missing paths) must match, so a value left set cannot approve a later deletion — not even one of the same size but a different set. A bare count, a stale token, or any other value stays blocked (fails closed). Every start with it set logs a warning. **Remove it right after the start it was meant for.** |
| `SYNCH_ALLOW_MASS_DELETE` | — | Retired. It is ignored (the guard stays on) and its presence logs a warning. |

Do not set `PORT` (Railway provides it; the entrypoint passes it to
SilverBullet), `SB_FOLDER`, or `XDG_CONFIG_HOME` (the image sets them to
`/data/space` and `/data/synch-config`). Do not set `SB_AUTH_TOKEN` unless you
need SilverBullet's HTTP API; it is a second credential to the notes.

## One-time connection to the existing vault

Prerequisites: the variables above are set, the volume is new and empty, and
public networking is off. Deploy once; the logs show `Maintenance mode`.

1. Open a shell: `railway ssh` (link the project and select `silver-bullet`).
2. Find the vault ID: run `synch login` (open the printed URL on a device where
   you are signed in to the Synch API and approve the code), then
   `synch-list-vaults`. It prints only vault IDs, names, and creation dates.
   If `SYNCH_VAULT_ID` was a placeholder, set the real ID in Railway; the
   redeploy comes back in maintenance mode, and the login is kept on the volume.
3. Run `synch-first-sync`. It:
   - refuses to continue unless the folder is completely empty;
   - runs `synch login` (already signed in from step 2);
   - lists your vaults and requires `SYNCH_VAULT_ID` to be one of them, then
     asks you to type the ID again;
   - runs `synch vault connect` (enter the vault password; it is not echoed),
     then `synch sync`, which only downloads into the empty folder;
   - re-runs the preflight and reports the file count.
   It never creates a vault. If anything is off, it stops before changing state.
   If it is interrupted, rerun it; it resumes only while the folder still
   matches what was downloaded.
4. Compare the reported file count with your vault in Obsidian.
5. Restart the service in Railway (unset `NOTES_MAINTENANCE` if you set it).
   Logs show `Starting synch watch and SilverBullet`.
6. Enable public networking (Generate Domain), open it, and log in with
   `SB_USER`.

## Routine maintenance

- **Shell work** (inspecting, restoring, or moving files; re-login): set
  `NOTES_MAINTENANCE=1` first, so neither SilverBullet nor sync runs, then
  remove it and redeploy. Never delete files in `/data/space` from a shell
  while the service runs.
- **Expired login** (logs repeat `sync failed`): in maintenance mode run
  `synch login`, then restart. Edits made in SilverBullet meanwhile were kept
  locally as pending changes and upload after the restart.
- **`sync failed` lines need attention.** The CLI's file watcher ignores
  SilverBullet's private `.silverbullet*` state (including the 0600
  `.silverbullet.auth.json` it cannot read), so that no longer produces a
  spurious `EACCES` on startup. Any `sync failed` line now reflects a real
  problem (see API outage below).
- **API outage at startup**: if the Synch API is unreachable or failing when
  the service starts, `synch watch` exits with **"The stored session was
  rejected. Run `synch login` again."** even though the login is fine (the CLI
  cannot tell an outage from a rejected session at that point; the stored
  login is not deleted). The container exits and Railway restarts it; once the
  API is back, it starts normally. Check the API first before signing in again.
  The same message can appear when the API rate-limits the CLI (HTTP 429),
  for example after many manual `synch status` or `synch sync` calls in a row.
  An outage while the service is already running only produces `sync failed`
  retries; edits wait locally.

### The guarded `synch` command

In this container, `synch` is a guard (`bin/synch`) in front of the CLI that
blocks the commands most likely to lose data by accident:

- `synch pull` is **refused**. It replaces local files that differ from the
  remote, discarding unsynced SilverBullet edits.
- `synch vault connect` is **refused**; use `synch-first-sync`, which verifies
  the vault ID and the folder first.
- `synch sync` and `synch watch` run only for `/data/space` and only when the
  preflight is ready (connected to `SYNCH_VAULT_ID`, first sync complete, no
  unconfirmed mass deletion). Otherwise they print the preflight verdict and
  stop. When the service is running, the CLI's own lock refuses a second sync.
- `synch login`, `synch logout`, `synch status`, `--help`, and `--version`
  pass through; `synch-list-vaults` and `synch-preflight` are read-only.

The guard prevents **accidents only; it is not a security boundary**. Anything
that runs the CLI another way bypasses it: `/opt/notes/lib/synch-unguarded`
(used internally by the entrypoint and `synch-first-sync`, which apply their
own checks), `node /opt/synch/synch.js`, or any copy of the CLI. Do not use
those by hand.
- **Reconnect after `synch logout`**: in maintenance mode run
  `synch-first-sync`; with the folder unchanged it reconnects without a fresh
  download.
- **Start over**: in maintenance mode delete everything in `/data/space`
  including `.synch/`, then run `synch-first-sync`.

## Testing both directions with a disposable note

1. In SilverBullet, create `Sync Test (delete me)` with one line.
   Within seconds it appears in Obsidian.
2. In Obsidian, add a second line to that note. It appears in SilverBullet
   (reload the page if it is open).
3. Rename it in SilverBullet; confirm Obsidian shows only the new name.
4. Delete it in Obsidian; confirm it disappears from SilverBullet.

Only then edit important notes.

## Behaviour and limitations

- **Conflicts.** Concurrent edits to different lines of a Markdown file are
  merged. Edits to the same lines keep the remote version in place and save the
  other side as `Name.sync-conflict-YYYYMMDD-HHMMSS.md` **on the device that
  lost**. Conflict copies are never synced, so one created here only exists in
  SilverBullet (and one created on a phone only exists there).
- **Deletions while running.** The mass-delete guard only runs at startup.
  Anything deleted from `/data/space` while the service runs (in SilverBullet,
  or from a `railway ssh` shell) is deleted on every device, exactly like a
  deletion in Obsidian. Use `NOTES_MAINTENANCE=1` before working in a shell.
- **Renames** are synced as a new file plus a delete (a new sync entry).
- **Synced types.** This service uploads `.md`, images, audio, video, and PDF.
  Other non-hidden files that Obsidian syncs (for example `.canvas`) are
  downloaded here, but changes to them on this side are never uploaded and
  never deleted remotely. Dot-folders and Obsidian's `.obsidian/` settings are
  neither downloaded nor uploaded.
- **SilverBullet system files.** `Library/Std` is built in and never written to
  disk. SilverBullet writes a default `index.md` whenever it starts on a space
  with no pages. The first-sync procedure avoids that, but if the space ever
  becomes completely empty while the service runs (for example after a
  confirmed deletion of every note, or if the remote vault is emptied),
  SilverBullet seeds `index.md` and it **syncs into Obsidian** (seen in tests).
  Delete it there if unwanted. If you install SilverBullet libraries, their
  pages are written under `Library/` as `.md` and also **sync into Obsidian**;
  the CLI has no per-folder exclusion today.
- **Session lifetime.** The CLI's API session lasts 30 days and is extended
  when it is used after a day. If it expires (for example after the service was
  stopped for a month), `synch watch` does **not** exit: it logs `sync failed`
  and retries while SilverBullet keeps working, so edits accumulate locally
  until you run `synch login` (see Routine maintenance). Watch the logs.
- **Empty remote vault.** A brand-new vault that has never held a note leaves
  the sync cursor at 0, which this service cannot tell apart from a folder that
  never synced, so `synch-first-sync` reports the vault as empty and refuses to
  mark it ready (it never fabricates a cursor or creates content). Add at least
  one note to the vault from Obsidian, then rerun `synch-first-sync`. A vault
  that has ever held a note is unaffected, even if it is currently empty.
- **One vault per service.** SilverBullet runs in single-space mode; deploy one
  service (with its own volume and `SB_USER`) per vault.
- **Single-space mode** is labelled legacy by SilverBullet in favour of
  multi-space mode; it is still supported in 2.12.1, which this image pins.
- **x86_64 only** (the pinned SilverBullet asset).
- **Redeploys** cause a short downtime (Railway volumes do not overlap
  deployments).

## Rollback

- **Stop editing:** remove the public domain, or stop the service. Nothing
  else depends on it; Obsidian and the API keep working.
- **Disconnect without touching notes:** set `NOTES_MAINTENANCE=1`, then
  `railway ssh` and `synch logout` (clears the session token and every stored
  vault key). The remote vault is unchanged; reconnect later with
  `synch-first-sync`.
- **Remove entirely:** delete the `silver-bullet` service and its volume. This
  deletes only the plaintext working copy; the remote vault and every other
  device are unaffected. Do not delete `@synch/api-volume`.
- **Undo a bad sync or recover deleted notes:** first set
  `NOTES_MAINTENANCE=1` (or stop the service) so it cannot re-upload. Then, in
  Obsidian's Synch plugin, use **View deleted files** to select and restore
  deleted notes, or a note's version history to restore an earlier version.
  Restored files sync back to this service when it starts again. Recovery
  depends on the remote vault still holding that history (deleted-file history
  can be purged permanently from the same view).

## Security boundaries and residual risks

- **Plaintext on the volume.** The notes and the decrypted vault key live in
  cleartext on this service's volume (and in any Railway volume backups).
  Anyone with volume access, a root shell, or Railway infrastructure access can
  read everything. End-to-end encryption still protects the API at rest; this
  service is a trusted endpoint, like an unlocked device.
- **In-container isolation** protects the vault key and sync state from the
  SilverBullet UID (see Process isolation). It does **not** stop a compromised
  SilverBullet, or a malicious note author on any device, from changing or
  deleting notes; those changes sync.
- **The `synch` guard** prevents accidental data-losing commands; it is not a
  security boundary (see The guarded `synch` command).
- **The mass-delete guard** is a startup check only. It does not prevent
  deletions made while the service runs, and small, below-threshold deletions
  (under half of the tracked files and fewer than 25) are not caught.
- **`SB_USER`** is visible to Railway project members. **Space Lua** in notes
  runs in the viewer's browser.

## Not verified

These hold in local testing (a Podman build of this image plus a local API) but
have **not** been confirmed on Railway or against the real setup. Check them
during the first real deployment:

- Railway starts the container as root (required for isolation), and
  `setpriv` / `no_new_privs` / `chown` / `chmod` behave as expected on Railway's
  runtime and volume filesystem.
- `railway ssh` provides an interactive root shell with a TTY.
- Railway injects `$PORT`, routes the generated domain to it, and provides
  automatic HTTPS; stop/redeploy timing and the restart-retry limit behave as
  assumed.
- Linux inotify limits are sufficient for a large vault (SilverBullet's watcher
  and `synch watch` both watch the tree).
- Real Obsidian desktop and mobile, and SilverBullet's **browser** editor and
  its offline cache, behave as the CLI-level tests imply.
- The delete-versus-unsent-edit race (a note deleted on one side while the other
  has unsent edits) has not been exercised.
- SilverBullet's login lockout behind Railway's proxy, and how long the remote
  vault retains deleted-file and version history, are unconfirmed.
