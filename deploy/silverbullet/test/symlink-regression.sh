#!/usr/bin/env bash
# Regression test for the boot-time permission hardening in entrypoint.sh.
# Runs INSIDE the built image as root (synch/silverbullet users and setpriv
# present); the PowerShell/CI harness invokes it with:
#   podman run --rm --entrypoint bash <image> /opt/notes/test/symlink-regression.sh
# (this file is not copied into the image by default; the harness mounts or
# copies deploy/silverbullet into the container to run it).
#
# It sources the real entrypoint functions (ENTRYPOINT_LIB_ONLY=1) so it tests
# the shipped code, not a copy, and asserts that a symlink the SilverBullet user
# can plant in the shared notes folder cannot make a root-run chown/chmod escape
# the folder, expose credentials, or let a substituted .synch be trusted.
set -uo pipefail

ENTRYPOINT="${ENTRYPOINT:-/opt/notes/entrypoint.sh}"
SB_USER_UID=silverbullet
pass=0
fail=0
check() {
	local desc="$1" ok="$2"
	if [[ "$ok" == "ok" ]]; then
		pass=$((pass + 1))
		echo "PASS: $desc"
	else
		fail=$((fail + 1))
		echo "FAIL: $desc"
	fi
}
as_sb() { setpriv --reuid=$SB_USER_UID --regid=$SB_USER_UID --init-groups "$@"; }
group_of() { stat -c '%G' "$1" 2>/dev/null; }
mode_owner() { stat -c '%U:%G %a' "$1" 2>/dev/null; }

export SB_FOLDER=/data/space
export XDG_CONFIG_HOME=/data/synch-config
# Load the real functions without running the service flow or the env exits.
ENTRYPOINT_LIB_ONLY=1 SB_USER="x:placeholderplaceholder" SYNCH_VAULT_ID=v SYNCH_API_URL=http://x source "$ENTRYPOINT"
# The sourced entrypoint enables `set -Eeuo pipefail`; this test checks return
# codes of functions that return non-zero by design, so relax -e/-E here.
set +eE
[[ "${isolated:-0}" == "1" ]] || { echo "FAIL: test must run as root with the synch/silverbullet users"; exit 1; }

reset_layout() {
	rm -rf /data/space /data/synch-config
	mkdir -p /data/space/.synch /data/synch-config/synch
	printf 'vault-key\n' >/data/synch-config/synch/credentials.json
	printf 'sqlite\n' >/data/space/.synch/sync.sqlite
	chown -R synch:synch /data/synch-config; chmod 700 /data/synch-config /data/synch-config/synch; chmod 600 /data/synch-config/synch/credentials.json
	chown -R synch:synch /data/space/.synch
	chgrp notes /data/space/.synch; chmod u=rwx,g=rx,o=,g-s /data/space/.synch # production .synch mode (0750)
	chown synch:notes /data/space; chmod 2770 /data/space; chmod a+x /data
}

echo "== Scenario A: an escape symlink in the notes folder must not be followed"
reset_layout
# Baseline: a sensitive outside path owned by root:root.
base_shadow="$(group_of /etc/shadow)"
as_sb ln -s /etc/shadow "$SB_FOLDER/escape" 2>/dev/null
as_sb sh -c 'echo note > "'"$SB_FOLDER"'/Real note.md"' 2>/dev/null
validate_synch_state; vstatus=$?
prepare_volume; pstatus=$?
check "valid .synch passes validation (A)" "$([[ $vstatus -eq 0 ]] && echo ok)"
check "prepare_volume succeeds with an escape symlink present (A)" "$([[ $pstatus -eq 0 ]] && echo ok)"
check "/etc/shadow group is unchanged (symlink not followed)" "$([[ "$(group_of /etc/shadow)" == "$base_shadow" ]] && echo ok)"
check "the escape entry is still a symlink, not re-owned through its target" "$([[ -L "$SB_FOLDER/escape" ]] && echo ok)"
check "a real note got group 'notes'" "$([[ "$(group_of "$SB_FOLDER/Real note.md")" == notes ]] && echo ok)"
as_sb cat "$SB_FOLDER/.synch/sync.sqlite" >/dev/null 2>&1 && sbread=open || sbread=denied
check "silverbullet still cannot read .synch contents after prepare (A)" "$([[ "$sbread" == denied ]] && echo ok)"

echo "== Scenario B: .synch replaced by the silverbullet user must be rejected, not repaired"
reset_layout
# The realistic substitution: .synch at 0750 blocks writing inside it, but the
# parent notes folder is group-writable, so the SilverBullet user can rename the
# whole directory aside and create its own in place.
as_sb sh -c 'mv "'"$SB_FOLDER"'/.synch" "'"$SB_FOLDER"'/.synch.bak" && mkdir "'"$SB_FOLDER"'/.synch" && echo forged > "'"$SB_FOLDER"'/.synch/sync.sqlite"' 2>/dev/null
check "the silverbullet user could substitute .synch via rename (setup)" "$([[ "$(stat -c '%U' "$SB_FOLDER/.synch" 2>/dev/null)" == "$SB_USER_UID" ]] && echo ok)"
owner_before="$(stat -c '%U' "$SB_FOLDER/.synch" 2>/dev/null)"
validate_synch_state; vstatus=$?
owner_after="$(stat -c '%U' "$SB_FOLDER/.synch" 2>/dev/null)"
check "a silverbullet-owned .synch fails validation (B)" "$([[ $vstatus -ne 0 ]] && echo ok)"
check "validation did not re-own the substituted .synch (B)" "$([[ "$owner_before" == "$owner_after" && "$owner_after" == "$SB_USER_UID" ]] && echo ok)"

echo "== Scenario C: .synch as a symlink to the config dir must be rejected without following it"
reset_layout
cfg_before="$(mode_owner /data/synch-config)"
as_sb sh -c 'mv "'"$SB_FOLDER"'/.synch" "'"$SB_FOLDER"'/.synch.bak" && ln -s /data/synch-config "'"$SB_FOLDER"'/.synch"' 2>/dev/null
check "the silverbullet user could point .synch at the config dir (setup)" "$([[ -L "$SB_FOLDER/.synch" ]] && echo ok)"
validate_synch_state; vstatus=$?
cfg_after="$(mode_owner /data/synch-config)"
check "a symlinked .synch fails validation (C)" "$([[ $vstatus -ne 0 ]] && echo ok)"
check "the config dir ownership/mode is unchanged (symlink not followed) (C)" "$([[ "$cfg_before" == "$cfg_after" ]] && echo ok)"
as_sb cat /data/synch-config/synch/credentials.json >/dev/null 2>&1 && sbread=open || sbread=denied
check "silverbullet cannot read the vault key after scenario C" "$([[ "$sbread" == denied ]] && echo ok)"

echo
echo "symlink-regression: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
