// Run with: node --test "deploy/silverbullet/test/*.test.mjs"   (Node >= 22.18 for .ts imports)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
	EXIT,
	MASS_DELETE_MIN_FILES,
	inspectNotesState,
	missingFingerprint,
	parseDeleteConfirmation,
} from "../lib/preflight.mjs";
import {
	VAULT_ID,
	connectFolder,
	createLayout,
	notes,
	writeCredentials,
	writeNotes,
	writeStore,
} from "./helpers.mjs";

let layout;
beforeEach(() => {
	layout = createLayout("notes-preflight-");
});
afterEach(() => fs.rmSync(layout.root, { recursive: true, force: true }));

function inspect(overrides = {}) {
	return inspectNotesState({
		vaultDir: layout.vaultDir,
		configHome: layout.configHome,
		expectedVaultId: VAULT_ID,
		...overrides,
	});
}

const tracked = (paths) => paths.map((p) => ({ path: p }));

describe("configuration", () => {
	it("requires the expected vault ID", async () => {
		assert.equal((await inspect({ expectedVaultId: " " })).code, EXIT.CONFIG_ERROR);
	});

	it("refuses credentials stored inside the served notes folder", async () => {
		const state = await inspect({ configHome: path.join(layout.vaultDir, "config") });
		assert.equal(state.reason, "config_inside_notes");
		assert.equal(state.code, EXIT.CONFIG_ERROR);
	});
});

describe("connection", () => {
	it("reports a folder that was never signed in or connected", async () => {
		const state = await inspect();
		assert.equal(state.reason, "no_credentials");
		assert.equal(state.code, EXIT.NOT_CONNECTED);
	});

	it("reports a signed-in account whose folder is not connected", async () => {
		writeCredentials(layout.configHome, { "/elsewhere": { remoteVaultId: VAULT_ID, remoteVaultKeyBase64: "a2V5" } });
		assert.equal((await inspect()).reason, "folder_not_connected");
	});

	it("blocks a folder connected to a different vault", async () => {
		connectFolder(layout, "vault-other");
		const state = await inspect();
		assert.equal(state.reason, "connected_to_other_vault");
		assert.equal(state.code, EXIT.BLOCKED);
	});

	it("blocks instead of letting the CLI reset an unreadable credentials file", async () => {
		fs.mkdirSync(path.join(layout.configHome, "synch"), { recursive: true });
		fs.writeFileSync(path.join(layout.configHome, "synch", "credentials.json"), "{not json");
		assert.equal((await inspect()).reason, "credentials_unreadable");
	});

	it("matches credentials by the folder's real path, like the CLI", async () => {
		const link = path.join(layout.root, "space-link");
		fs.symlinkSync(layout.vaultDir, link, "dir");
		connectFolder(layout);
		writeStore(layout.vaultDir);
		assert.equal((await inspect({ vaultDir: link })).reason, "ready");
	});
});

describe("first sync state", () => {
	it("requires a first sync when no store exists", async () => {
		connectFolder(layout);
		const state = await inspect();
		assert.equal(state.reason, "no_sync_store");
		assert.equal(state.code, EXIT.NOT_INITIALIZED);
	});

	it("requires a first sync when the store is not bound to a vault yet", async () => {
		connectFolder(layout);
		writeStore(layout.vaultDir, { remoteVaultId: null });
		assert.equal((await inspect()).reason, "sync_store_unbound");
	});

	it("blocks a store bound to a different vault, even before the folder is connected", async () => {
		writeStore(layout.vaultDir, { remoteVaultId: "vault-other" });
		const state = await inspect();
		assert.equal(state.reason, "sync_store_other_vault");
		assert.equal(state.code, EXIT.BLOCKED);
	});

	it("reports an interrupted first sync and how the folder differs from the store", async () => {
		connectFolder(layout);
		writeNotes(layout.vaultDir, ["Downloaded.md", "Stray.md"]);
		writeStore(layout.vaultDir, { cursor: 0, entries: tracked(["Downloaded.md", "Gone.md"]) });
		const state = await inspect();
		assert.equal(state.reason, "first_sync_incomplete");
		assert.equal(state.code, EXIT.NOT_INITIALIZED);
		assert.deepEqual(state.counts, { known: 2, missing: 1, untracked: 1 });
		assert.deepEqual(state.samples, { missing: ["Gone.md"], untracked: ["Stray.md"] });
	});
});

describe("reconnecting a folder whose vault key was removed", () => {
	it("reports reconnect_required when the folder still matches its store", async () => {
		writeNotes(layout.vaultDir, ["A.md", "Folder/B.md"]);
		writeStore(layout.vaultDir, { entries: tracked(["A.md", "Folder/B.md"]) });
		const state = await inspect();
		assert.equal(state.reason, "reconnect_required");
		assert.equal(state.code, EXIT.NOT_CONNECTED);
		assert.deepEqual(state.counts, { known: 2, missing: 0, untracked: 0 });
	});

	it("counts missing and unknown files, ignoring dot paths and conflict copies", async () => {
		writeCredentials(layout.configHome, {});
		writeNotes(layout.vaultDir, [
			"A.md",
			"New note.md",
			"A.sync-conflict-20261014-120000.md",
			".hidden.md",
			".silverbullet.auth.json",
		]);
		writeStore(layout.vaultDir, { entries: tracked(["A.md", "Deleted meanwhile.md"]) });
		const state = await inspect();
		assert.equal(state.reason, "reconnect_required");
		assert.deepEqual(state.counts, { known: 2, missing: 1, untracked: 1 });
		assert.deepEqual(state.samples.untracked, ["New note.md"]);
	});
});

describe("mass delete guard", () => {
	it("is ready when every synced file is present", async () => {
		connectFolder(layout);
		const paths = [...notes(3), "Folder/Nested.md", "Attachments/image.png"];
		writeNotes(layout.vaultDir, paths);
		writeStore(layout.vaultDir, { entries: tracked(paths) });
		const state = await inspect();
		assert.equal(state.code, EXIT.READY);
		assert.deepEqual(state.counts, { known: 5, missing: 0 });
	});

	it("blocks when the folder lost every synced file", async () => {
		connectFolder(layout);
		writeStore(layout.vaultDir, { entries: tracked(notes(2)) });
		const state = await inspect();
		assert.equal(state.reason, "mass_delete_guard");
		assert.equal(state.code, EXIT.BLOCKED);
	});

	it("blocks a heavy loss in a small vault (24 of 25 gone) by proportion", async () => {
		connectFolder(layout);
		const paths = notes(25);
		writeNotes(layout.vaultDir, paths.slice(0, 1)); // keep 1, lose 24
		writeStore(layout.vaultDir, { entries: tracked(paths) });
		const state = await inspect();
		assert.equal(state.reason, "mass_delete_guard");
		assert.deepEqual(state.counts, { known: 25, missing: 24 });
	});

	it("blocks a large absolute loss even below the ratio (30 of 100)", async () => {
		connectFolder(layout);
		const paths = notes(100);
		writeNotes(layout.vaultDir, paths.slice(0, 70)); // lose 30 of 100 (0.3 ratio, but >= 25)
		writeStore(layout.vaultDir, { entries: tracked(paths) });
		assert.equal((await inspect()).reason, "mass_delete_guard");
	});

	it("allows ordinary deletions: few files, small fraction", async () => {
		connectFolder(layout);
		const paths = notes(100);
		writeNotes(layout.vaultDir, paths.slice(3)); // lose 3 of 100
		writeStore(layout.vaultDir, { entries: tracked(paths) });
		const state = await inspect();
		assert.equal(state.code, EXIT.READY);
		assert.deepEqual(state.counts, { known: 100, missing: 3 });
	});

	it("ignores entries that are already deleted locally", async () => {
		connectFolder(layout);
		writeNotes(layout.vaultDir, ["Kept.md"]);
		writeStore(layout.vaultDir, { entries: [{ path: "Kept.md" }, { path: "Gone.md", deleted: true }] });
		assert.deepEqual((await inspect()).counts, { known: 1, missing: 0 });
	});

	it("prints a count:fingerprint token for the operator to confirm", async () => {
		connectFolder(layout);
		writeStore(layout.vaultDir, { entries: tracked(notes(2)) });
		const state = await inspect();
		const token = `2:${missingFingerprint(notes(2))}`;
		assert.equal(state.fingerprint, missingFingerprint(notes(2)));
		assert.match(state.message, new RegExp(`SYNCH_CONFIRM_DELETE_COUNT=${token}`));
	});
});

describe("fingerprint-bound mass-delete confirmation", () => {
	// All `known` notes are tracked but none written to disk, so all are missing.
	function emptiedFolder(known) {
		connectFolder(layout);
		writeStore(layout.vaultDir, { entries: tracked(notes(known)) });
		return `${known}:${missingFingerprint(notes(known))}`;
	}

	it("proceeds only for the exact count:fingerprint of the missing set", async () => {
		const token = emptiedFolder(3);
		const state = await inspect({ confirmDeleteCount: token });
		assert.equal(state.code, EXIT.READY);
		assert.equal(state.reason, "mass_delete_confirmed");
		assert.deepEqual(state.counts, { known: 3, missing: 3 });
	});

	it("stays blocked when the count is right but the fingerprint is wrong", async () => {
		emptiedFolder(3);
		const state = await inspect({ confirmDeleteCount: "3:deadbeef" });
		assert.equal(state.code, EXIT.BLOCKED);
		assert.equal(state.reason, "mass_delete_confirmation_mismatch");
	});

	it("stays blocked when the fingerprint is right but the count is wrong", async () => {
		emptiedFolder(3);
		const state = await inspect({ confirmDeleteCount: `2:${missingFingerprint(notes(3))}` });
		assert.equal(state.reason, "mass_delete_confirmation_mismatch");
	});

	it("rejects a different missing set of the same size (same count, different fingerprint)", async () => {
		// Blocked start reports 3 missing with fingerprint Fp(A). Operator sets that
		// token. Before restart the missing set changes to a different 3 files.
		connectFolder(layout);
		const setA = ["a1.md", "a2.md", "a3.md"];
		const setB = ["b1.md", "b2.md", "b3.md"];
		const tokenForA = `3:${missingFingerprint(setA)}`;
		writeStore(layout.vaultDir, { entries: tracked(setB) });
		const state = await inspect({ confirmDeleteCount: tokenForA });
		assert.equal(state.code, EXIT.BLOCKED);
		assert.equal(state.reason, "mass_delete_confirmation_mismatch");
		// It names the token that WOULD confirm the current set, which is set B's.
		assert.match(state.message, new RegExp(`expected 3:${missingFingerprint(setB)}`));
	});

	it("fails closed on a bare count (no fingerprint) and other invalid values", async () => {
		emptiedFolder(3);
		for (const value of ["3", "1", "yes", "0", "-3", "03", "3.0", "3e0", " 3", "+3", "1e3", "3:", "3:ABCDEF12", "3:deadbee"]) {
			const state = await inspect({ confirmDeleteCount: value });
			assert.equal(state.code, EXIT.BLOCKED, JSON.stringify(value));
			assert.match(state.reason, /^mass_delete_confirmation_(invalid|mismatch)$/, JSON.stringify(value));
		}
	});

	it("has no effect when no mass deletion is pending", async () => {
		connectFolder(layout);
		writeNotes(layout.vaultDir, notes(3));
		writeStore(layout.vaultDir, { entries: tracked(notes(3)) });
		const state = await inspect({ confirmDeleteCount: `3:${missingFingerprint(notes(3))}` });
		assert.equal(state.reason, "ready");
	});

	it("does not carry over to a later, different deletion", async () => {
		// Start 1: 30 notes, all missing, confirmed with the matching token -> proceeds.
		connectFolder(layout);
		const all = notes(30);
		const token1 = `30:${missingFingerprint(all)}`;
		writeStore(layout.vaultDir, { entries: tracked(all) });
		assert.equal((await inspect({ confirmDeleteCount: token1 })).reason, "mass_delete_confirmed");

		// Start 2: 40 fresh notes present -> ready, the stale token is irrelevant.
		const fresh = notes(40, "Fresh");
		writeNotes(layout.vaultDir, fresh);
		writeStore(layout.vaultDir, { entries: tracked(fresh) });
		assert.equal((await inspect({ confirmDeleteCount: token1 })).reason, "ready");

		// Start 3: a new mass deletion (the 40 fresh) -> blocked; stale token1 cannot approve it.
		fs.rmSync(layout.vaultDir, { recursive: true, force: true });
		fs.mkdirSync(layout.vaultDir);
		writeStore(layout.vaultDir, { entries: tracked(fresh) });
		const state = await inspect({ confirmDeleteCount: token1 });
		assert.equal(state.code, EXIT.BLOCKED);
		assert.equal(state.reason, "mass_delete_confirmation_mismatch");
	});

	it("ignores the retired SYNCH_ALLOW_MASS_DELETE when run as the startup command", () => {
		const token = emptiedFolder(2);
		const run = (extraEnv) =>
			spawnSync(process.execPath, [fileURLToPath(new URL("../lib/preflight.mjs", import.meta.url))], {
				encoding: "utf8",
				env: {
					SB_FOLDER: layout.vaultDir,
					XDG_CONFIG_HOME: layout.configHome,
					SYNCH_VAULT_ID: VAULT_ID,
					...extraEnv,
				},
			});
		const retired = run({ SYNCH_ALLOW_MASS_DELETE: "1" });
		assert.equal(retired.status, EXIT.BLOCKED);
		assert.match(retired.stderr, /mass_delete_guard/);
		assert.equal(run({ SYNCH_CONFIRM_DELETE_COUNT: token }).status, EXIT.READY);
	});
});

describe("parseDeleteConfirmation", () => {
	it("accepts only a count:fingerprint token", () => {
		assert.deepEqual(parseDeleteConfirmation(undefined), { kind: "none" });
		assert.deepEqual(parseDeleteConfirmation(""), { kind: "none" });
		assert.deepEqual(parseDeleteConfirmation("12:3f9ab0c1"), { kind: "token", count: 12, fingerprint: "3f9ab0c1" });
		for (const bad of ["12", "012:3f9ab0c1", "12:3F9AB0C1", "12:3f9ab0c", "12:3f9ab0c12", "1 2:3f9ab0c1", "12:"]) {
			assert.equal(parseDeleteConfirmation(bad).kind, "invalid", bad);
		}
	});

	it("produces a stable fingerprint independent of path order", () => {
		assert.equal(missingFingerprint(["a.md", "b.md"]), missingFingerprint(["b.md", "a.md"]));
		assert.notEqual(missingFingerprint(["a.md"]), missingFingerprint(["b.md"]));
		assert.match(missingFingerprint(["a.md"]), /^[0-9a-f]{8}$/);
	});
});
