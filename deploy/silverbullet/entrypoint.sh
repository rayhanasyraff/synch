#!/usr/bin/env bash
# Container entrypoint (run under tini). Starts SilverBullet and `synch watch`
# on the same notes folder only after the read-only preflight confirms the
# folder is connected to SYNCH_VAULT_ID and has completed its first sync.
# Otherwise, or when NOTES_MAINTENANCE=1, it stays in maintenance mode:
# nothing serves or syncs the notes, so a shell (`railway ssh`) can safely run
# `synch-first-sync`, `synch login`, or inspect files.
#
# When started as root (the image default) it isolates the two processes:
# `synch` (holds the decrypted vault key) and `silverbullet` (serves the
# notes) are different users that share only the notes folder through the
# `notes` group. SilverBullet cannot read the credentials or the sync state.
set -Eeuo pipefail

log() { printf '[notes] %s\n' "$*" >&2; }
fatal() {
	log "FATAL: $*"
	exit 1
}

NOTES_HOME="${NOTES_HOME:-/opt/notes}"
DATA_ROOT="${DATA_ROOT:-/data}"
export SB_FOLDER="${SB_FOLDER:-$DATA_ROOT/space}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$DATA_ROOT/synch-config}"
# Railway provides PORT; SilverBullet reads SB_PORT.
export SB_PORT="${PORT:-${SB_PORT:-3000}}"
export SB_HOSTNAME="${SB_HOSTNAME:-0.0.0.0}"
# The entrypoint applies its own checks (preflight) before `synch watch`, so it
# calls the CLI directly rather than through the operator-facing guard.
SYNCH_BIN="${SYNCH_BIN:-$NOTES_HOME/lib/synch-unguarded}"
SILVERBULLET_BIN="${SILVERBULLET_BIN:-silverbullet}"
MIN_PASSWORD_LENGTH=16
SYNCH_USER=synch
SILVERBULLET_USER=silverbullet
NOTES_GROUP=notes

# Refuse to start unless SilverBullet has credentials and the Synch target is
# named. Without SB_USER, SilverBullet is open to anyone who can reach it (and
# newer releases fall back to a setup wizard). Grouped into a function so the
# functions below can be sourced for testing without triggering these exits.
startup_env_checks() {
	local sb_user sb_password
	sb_user="${SB_USER:-}"
	if [[ "$sb_user" != *:* || -z "${sb_user%%:*}" ]]; then
		fatal "SB_USER must be set to 'username:password' before this service can start."
	fi
	sb_password="${sb_user#*:}"
	if ((${#sb_password} < MIN_PASSWORD_LENGTH)); then
		fatal "The SB_USER password must be at least ${MIN_PASSWORD_LENGTH} characters."
	fi
	[[ -n "${SYNCH_VAULT_ID:-}" ]] || fatal "SYNCH_VAULT_ID must name the existing remote vault to sync."
	[[ -n "${SYNCH_API_URL:-}" ]] || fatal "SYNCH_API_URL must point at the existing Synch API."

	if [[ -n "${SYNCH_ALLOW_MASS_DELETE:-}" ]]; then
		log "WARNING: SYNCH_ALLOW_MASS_DELETE is no longer supported and is ignored; the mass-delete guard stays on."
		log "WARNING: To confirm one intended mass deletion, set SYNCH_CONFIRM_DELETE_COUNT to the count:fingerprint"
		log "WARNING: token that the blocked start reported. Remove SYNCH_ALLOW_MASS_DELETE."
	fi
	if [[ -n "${SYNCH_CONFIRM_DELETE_COUNT:-}" ]]; then
		log "WARNING: SYNCH_CONFIRM_DELETE_COUNT=${SYNCH_CONFIRM_DELETE_COUNT} is set. If it matches the count and"
		log "WARNING: fingerprint of the files missing from ${SB_FOLDER}, this start deletes them from the remote"
		log "WARNING: vault and every device. Any other value stays blocked. Remove it right after this start."
	fi
}

isolated=0
if [[ "$(id -u)" -eq 0 ]] && id "$SYNCH_USER" >/dev/null 2>&1 && id "$SILVERBULLET_USER" >/dev/null 2>&1; then
	isolated=1
fi

# SilverBullet runs as a different user and can write into the notes folder, so
# it can create symlinks there. Every root-run ownership/mode change below must
# therefore refuse to act on a symlink or to descend through one; otherwise a
# planted symlink could redirect a chown/chmod onto a path outside the folder.
# `find` without -L never descends into a symlinked directory, and the explicit
# `! -type l` / `-h` keep each operation from following the link itself.

RESERVED_PRUNE=(-name .synch -o -name '.silverbullet*')

# True only for a real directory (not a symlink) owned by root or synch. The
# notes group cannot write to the volume root or to .synch's parent chain in a
# way that lets SilverBullet substitute these, but we still verify rather than
# trust, and never "repair" a path that fails the check.
is_trusted_dir() {
	local p="$1"
	[[ -d "$p" && ! -L "$p" ]] || return 1
	local owner
	owner="$(stat -c '%U' "$p" 2>/dev/null)" || return 1
	[[ "$owner" == "root" || "$owner" == "$SYNCH_USER" ]]
}

# Validates the sync-state directory before anything trusts or re-owns it. It
# must be a real directory (never a symlink) owned by synch. A symlink or a
# directory owned by another user means SilverBullet, or something, replaced
# it; we stop in maintenance rather than chown/chmod attacker-controlled state.
validate_synch_state() {
	local p="$SB_FOLDER/.synch"
	if [[ -L "$p" ]]; then
		SYNCH_STATE_ERROR="$p is a symlink; refusing to touch it."
		return 1
	fi
	if [[ ! -e "$p" ]]; then
		return 0 # absent before the first connection: nothing to validate
	fi
	if [[ ! -d "$p" ]]; then
		SYNCH_STATE_ERROR="$p is not a directory."
		return 1
	fi
	# Ownership only means something under isolation (root + the two users).
	# Without it, everything runs as one user that legitimately owns .synch.
	if ((isolated)); then
		local owner
		owner="$(stat -c '%U' "$p" 2>/dev/null)" || {
			SYNCH_STATE_ERROR="cannot stat $p."
			return 1
		}
		if [[ "$owner" != "$SYNCH_USER" && "$owner" != "root" ]]; then
			SYNCH_STATE_ERROR="$p is owned by $owner, not $SYNCH_USER (it may have been replaced)."
			return 1
		fi
	fi
	return 0
}

# Brings the volume to the layout the isolation relies on. Runs on every boot,
# so earlier deployments, shell work, or restores cannot leave a gap.
prepare_volume() {
	mkdir -p "$SB_FOLDER" "$XDG_CONFIG_HOME"
	if ((!isolated)); then
		chmod 0700 "$XDG_CONFIG_HOME"
		log "WARNING: not running as root; SilverBullet and sync run as the same user (no isolation)."
		return 0
	fi
	# The config tree and the notes root must be real directories we control;
	# if not, stop rather than operate on whatever is there.
	is_trusted_dir "$XDG_CONFIG_HOME" || {
		SYNCH_STATE_ERROR="$XDG_CONFIG_HOME is not a directory owned by root or $SYNCH_USER."
		return 1
	}
	is_trusted_dir "$SB_FOLDER" || {
		SYNCH_STATE_ERROR="$SB_FOLDER is not a directory owned by root or $SYNCH_USER."
		return 1
	}
	# Both users must be able to pass through the volume root to reach their
	# folders (traverse only, no listing). These are fixed, non-symlink paths.
	chmod a+x "$(dirname "$SB_FOLDER")" "$(dirname "$XDG_CONFIG_HOME")"
	# Credentials and the decrypted vault key: synch only. SilverBullet cannot
	# write under here, so there is no symlink to follow, but stay no-follow.
	chown -Rh "$SYNCH_USER:$SYNCH_USER" "$XDG_CONFIG_HOME"
	chmod u+rwx,go-rwx "$XDG_CONFIG_HOME"
	find "$XDG_CONFIG_HOME" -mindepth 1 ! -type l -exec chmod u+rwX,go-rwx {} +
	# Notes: shared by the notes group; setgid directories keep new files in it.
	# Reserved hidden state is pruned here and handled separately below. Symlinks
	# are never touched and never traversed, so an operation cannot escape the
	# folder.
	chown -h "$SYNCH_USER:$NOTES_GROUP" "$SB_FOLDER"
	chmod u+rwx,g+rwxs,o-rwx "$SB_FOLDER"
	find "$SB_FOLDER" -mindepth 1 \( "${RESERVED_PRUNE[@]}" \) -prune -o ! -type l -exec chgrp -h "$NOTES_GROUP" {} +
	find "$SB_FOLDER" -mindepth 1 \( "${RESERVED_PRUNE[@]}" \) -prune -o -type d ! -type l -exec chmod u+rwx,g+rwxs,o-rwx {} +
	find "$SB_FOLDER" -mindepth 1 \( "${RESERVED_PRUNE[@]}" \) -prune -o -type f ! -type l -exec chmod ug+rw,o-rwx {} +
	# Sync state: contents readable and writable by synch only, so SilverBullet
	# can neither read nor tamper with it. The directory itself is listable by
	# the notes group because SilverBullet's native file watcher must be able to
	# watch every directory in the space; one unreadable directory makes it give
	# up watching entirely. No group write and no setgid, so files the CLI
	# creates later keep the synch group. validate_synch_state has already
	# confirmed .synch is a real directory synch owns, so this never follows a
	# planted symlink; -type l filters guard the contents too.
	if [[ -d "$SB_FOLDER/.synch" ]]; then
		chown -Rh "$SYNCH_USER:$SYNCH_USER" "$SB_FOLDER/.synch"
		find "$SB_FOLDER/.synch" -mindepth 1 ! -type l -exec chmod u+rwX,go-rwx {} +
		chgrp -h "$NOTES_GROUP" "$SB_FOLDER/.synch"
		chmod u=rwx,g=rx,o=,g-s "$SB_FOLDER/.synch"
	fi
	# SilverBullet's own hidden state (for example .silverbullet.auth.json),
	# at the top level only and never through a symlink.
	find "$SB_FOLDER" -mindepth 1 -maxdepth 1 -name '.silverbullet*' ! -type l \
		-exec chown -h "$SILVERBULLET_USER:$NOTES_GROUP" {} +
	return 0
}

# Replaces the calling subshell with the command run as the given user.
# Switching from root to a non-zero uid clears all capabilities, and
# no_new_privs (plus the image's stripped setuid bits) prevents regaining
# them. Group-shared files (0660/2770) and nothing for others.
run_as() {
	local user="$1"
	shift
	if ((!isolated)); then
		exec "$@"
	fi
	umask 0007
	exec setpriv --reuid="$user" --regid="$user" --init-groups --no-new-privs \
		env HOME="/home/$user" "$@"
}

# Like run_as but returns to the caller (no exec), so an exit code can be read.
# Used for the preflight, which is run as synch (least privilege): it never
# needs root, and running it unprivileged means even a hypothetically tampered
# sync store is parsed without root.
run_capture_as() {
	local user="$1"
	shift
	if ((!isolated)); then
		"$@"
		return
	fi
	setpriv --reuid="$user" --regid="$user" --init-groups --no-new-privs \
		env HOME="/home/$user" "$@"
}

maintenance() {
	log "Maintenance mode: SilverBullet and sync are NOT running. $1"
	log "Open a shell (railway ssh) to run synch-first-sync, synch login, or inspect files;"
	log "then unset NOTES_MAINTENANCE (if set) and restart this service from Railway."
	sleep infinity &
	sleep_pid=$!
	trap 'log "stopping"; kill "$sleep_pid" 2>/dev/null || true; exit 0' TERM INT
	wait "$sleep_pid"
	exit 0
}

# Sourcing the script with ENTRYPOINT_LIB_ONLY=1 stops here, exposing the
# functions and variables above (is_trusted_dir, validate_synch_state,
# prepare_volume, ...) for in-container regression tests without running the
# service flow or the startup exits below.
if [[ "${ENTRYPOINT_LIB_ONLY:-}" == "1" ]]; then
	return 0 2>/dev/null || exit 0
fi

startup_env_checks

# Validate the sync-state directory BEFORE anything touches or trusts it, then
# apply the volume layout. On any failure, stop in maintenance without
# repairing potentially substituted state.
SYNCH_STATE_ERROR=""
if ! validate_synch_state; then
	maintenance "Sync-state check failed: ${SYNCH_STATE_ERROR} Inspect ${SB_FOLDER}/.synch by hand; it was not modified."
fi
if ! prepare_volume; then
	maintenance "Volume layout check failed: ${SYNCH_STATE_ERROR} Nothing was modified."
fi

# Only this container mounts the volume (Railway volumes allow no replicas or
# overlapping deployments). A lock left by a killed CLI can carry a PID that a
# fresh container reuses, which would block `synch watch` forever. Safe now:
# .synch is a validated real directory, so this cannot act through a symlink.
rm -f "$SB_FOLDER/.synch/cli.lock"

if [[ "${NOTES_MAINTENANCE:-}" == "1" ]]; then
	maintenance "(NOTES_MAINTENANCE=1)"
fi

set +e
run_capture_as "$SYNCH_USER" node "$NOTES_HOME/lib/preflight.mjs"
preflight_status=$?
set -e

case "$preflight_status" in
0) ;;
10 | 11) maintenance "The folder is not connected or its first sync has not completed: run synch-first-sync." ;;
20) maintenance "A safety check blocked startup (see the preflight message above); nothing was synced." ;;
*) fatal "Preflight could not validate the configuration (exit ${preflight_status})." ;;
esac

# Install the stop handler before starting anything, so a stop request can
# never leave a child running without a parent to wait for it.
sync_pid=""
sb_pid=""
stopping=0
stop_children() {
	local pid
	for pid in "$sync_pid" "$sb_pid"; do
		if [[ -n "$pid" ]]; then
			kill -TERM "$pid" 2>/dev/null || true
		fi
	done
	return 0
}
trap 'stopping=1; log "stopping"; stop_children' TERM INT

log "Starting synch watch and SilverBullet ${SB_HOSTNAME}:${SB_PORT} for ${SB_FOLDER} (isolated users: $([[ $isolated == 1 ]] && echo yes || echo no))"
# The CLI never needs SilverBullet's credentials.
(run_as "$SYNCH_USER" env -u SB_USER -u SB_AUTH_TOKEN "$SYNCH_BIN" watch --vault "$SB_FOLDER") &
sync_pid=$!
if ((stopping)); then
	stop_children
	wait "$sync_pid"
	exit 0
fi
(run_as "$SILVERBULLET_USER" "$SILVERBULLET_BIN" --single "$SB_FOLDER") &
sb_pid=$!

# Whichever process ends first ends the container, so SilverBullet never keeps
# accepting edits while sync is down. Railway's restart policy brings both back.
set +e
wait -n "$sync_pid" "$sb_pid"
first_status=$?
stop_children
wait "$sync_pid"
wait "$sb_pid"
set -e

if ((stopping)); then
	exit 0
fi
log "A supervised process exited (status ${first_status}); stopping the container."
exit 1
