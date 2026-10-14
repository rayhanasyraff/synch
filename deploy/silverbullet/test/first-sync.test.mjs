// Run with: node --test "deploy/silverbullet/test/*.test.mjs"   (Linux; needs bash)
// Drives bin/synch-first-sync with the real preflight and real-schema sync
// stores. Only the `synch` CLI and the vault listing are stubbed, so the test
// shows which CLI commands the script runs (or refuses to run) in each state.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { VAULT_ID, connectFolder, createLayout, writeCredentials, writeNotes, writeStore } from "./helpers.mjs";

const DEPLOY_DIR = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(DEPLOY_DIR, "bin", "synch-first-sync");
const HELPERS = fileURLToPath(new URL("./helpers.mjs", import.meta.url));
const skip = process.platform === "win32" ? "synch-first-sync needs a POSIX shell" : false;

let layout;
let calls;
beforeEach(() => {
	layout = createLayout("notes-first-sync-");
	calls = path.join(layout.root, "synch-calls.log");
	fs.mkdirSync(path.join(layout.root, "bin"));
	// Stub CLI: records each invocation, and simulates connect/sync effects on disk.
	fs.writeFileSync(
		path.join(layout.root, "bin", "synch"),
		`#!/usr/bin/env bash\nexec node "$(dirname "$0")/synch.mjs" "$@"\n`,
	);
	fs.writeFileSync(
		path.join(layout.root, "bin", "synch.mjs"),
		`import fs from "node:fs";
import { connectFolder, writeNotes, writeStore } from ${JSON.stringify(HELPERS)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, args.join(" ") + "\\n");
const layout = { vaultDir: process.env.SB_FOLDER, configHome: process.env.XDG_CONFIG_HOME };
if (args[0] === "vault" && args[1] === "connect") connectFolder(layout, args[args.indexOf("--vault-id") + 1]);
if (args[0] === "sync") {
	if (process.env.STUB_SYNC_FAIL) process.exit(1);
	writeNotes(layout.vaultDir, ["Downloaded.md"]);
	const files = fs.readdirSync(layout.vaultDir).filter((name) => !name.startsWith("."));
	writeStore(layout.vaultDir, { cursor: 9, entries: files.map((p) => ({ path: p })) });
}
`,
	);
	fs.writeFileSync(
		path.join(layout.root, "bin", "list-vaults"),
		`#!/usr/bin/env bash\nprintf '%s\\n' "\${STUB_LISTING}"\n`,
	);
	for (const name of ["synch", "list-vaults"]) fs.chmodSync(path.join(layout.root, "bin", name), 0o755);
});
afterEach(() => fs.rmSync(layout.root, { recursive: true, force: true }));

const LISTING = `${VAULT_ID}  "My vault"  created 2026-01-01T00:00:00.000Z  <- SYNCH_VAULT_ID\nvault-other  "Other"  created 2026-01-02T00:00:00.000Z`;

function run({ input = `${VAULT_ID}\n`, env = {} } = {}) {
	const result = spawnSync("bash", [SCRIPT], {
		input,
		encoding: "utf8",
		env: {
			PATH: `${path.join(layout.root, "bin")}:${process.env.PATH}`,
			NOTES_HOME: DEPLOY_DIR,
			SB_FOLDER: layout.vaultDir,
			XDG_CONFIG_HOME: layout.configHome,
			SYNCH_VAULT_ID: VAULT_ID,
			SYNCH_API_URL: "https://api.example",
			LIST_VAULTS_BIN: path.join(layout.root, "bin", "list-vaults"),
			SYNCH_BIN: "synch",
			STUB_LISTING: LISTING,
			...env,
		},
	});
	const commands = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : [];
	return { status: result.status, stderr: result.stderr, commands };
}

describe("synch-first-sync", { skip }, () => {
	it("connects and downloads into an empty folder", () => {
		const { status, stderr, commands } = run();
		assert.equal(status, 0, stderr);
		assert.deepEqual(commands, [
			"login",
			`vault connect --vault ${layout.vaultDir} --vault-id ${VAULT_ID}`,
			`sync --vault ${layout.vaultDir}`,
		]);
		assert.match(stderr, /Done: Connected to the expected vault/);
	});

	it("refuses a non-empty folder before running any CLI command", () => {
		writeNotes(layout.vaultDir, ["Local only.md"]);
		const { status, stderr, commands } = run();
		assert.equal(status, 1);
		assert.match(stderr, /is not empty/);
		assert.deepEqual(commands, []);
	});

	it("refuses a leftover .synch folder that belongs to no vault", () => {
		writeStore(layout.vaultDir, { remoteVaultId: null });
		connectFolder(layout);
		const { status, commands } = run();
		assert.equal(status, 1);
		assert.deepEqual(commands, []);
	});

	it("does not connect when the vault ID is not one of the account's vaults", () => {
		const { status, stderr, commands } = run({ env: { STUB_LISTING: `vault-other  "Other"  created x` } });
		assert.equal(status, 1);
		assert.match(stderr, /is not one of this account's vaults/);
		assert.deepEqual(commands, ["login"]);
	});

	it("does not treat a vault ID as a pattern", () => {
		const { status, commands } = run({
			env: { SYNCH_VAULT_ID: "vault-.*", STUB_LISTING: `vault-xyz  "X"  created x  <- SYNCH_VAULT_ID` },
			input: "vault-.*\n",
		});
		assert.equal(status, 1);
		assert.deepEqual(commands, ["login"]);
	});

	it("does not connect when the typed confirmation differs", () => {
		const { status, stderr, commands } = run({ input: "vault-other\n" });
		assert.equal(status, 1);
		assert.match(stderr, /Confirmation did not match/);
		assert.deepEqual(commands, ["login"]);
	});

	it("resumes an interrupted first sync when the folder matches its store", () => {
		connectFolder(layout);
		writeNotes(layout.vaultDir, ["Downloaded.md"]);
		writeStore(layout.vaultDir, { cursor: 0, entries: [{ path: "Downloaded.md" }] });
		const { status, stderr, commands } = run();
		assert.equal(status, 0, stderr);
		assert.deepEqual(commands, ["login", `sync --vault ${layout.vaultDir}`]);
	});

	it("refuses to resume when files the store knows were removed (they would be deleted remotely)", () => {
		connectFolder(layout);
		writeStore(layout.vaultDir, { cursor: 0, entries: [{ path: "Downloaded.md" }] });
		const { status, stderr, commands } = run();
		assert.equal(status, 1);
		assert.match(stderr, /missing: Downloaded\.md/);
		assert.match(stderr, /delete EVERYTHING .* including \.synch/);
		assert.deepEqual(commands, []);
	});

	it("refuses to resume when unknown files were added (they would be uploaded)", () => {
		connectFolder(layout);
		writeNotes(layout.vaultDir, ["Downloaded.md", "Copied in.md"]);
		writeStore(layout.vaultDir, { cursor: 0, entries: [{ path: "Downloaded.md" }] });
		const { status, stderr, commands } = run();
		assert.equal(status, 1);
		assert.match(stderr, /unknown: Copied in\.md/);
		assert.deepEqual(commands, []);
	});

	it("reconnects a folder after synch logout without requiring an empty folder", () => {
		writeCredentials(layout.configHome, {});
		writeNotes(layout.vaultDir, ["Downloaded.md"]);
		writeStore(layout.vaultDir, { entries: [{ path: "Downloaded.md" }] });
		const { status, stderr, commands } = run();
		assert.equal(status, 0, stderr);
		assert.deepEqual(commands, [
			"login",
			`vault connect --vault ${layout.vaultDir} --vault-id ${VAULT_ID}`,
			`sync --vault ${layout.vaultDir}`,
		]);
	});

	it("refuses folders tied to another vault", () => {
		connectFolder(layout, "vault-other");
		const { status, stderr, commands } = run();
		assert.equal(status, 1);
		assert.match(stderr, /connected_to_other_vault/);
		assert.deepEqual(commands, []);
	});

	it("does nothing when the folder is already ready", () => {
		connectFolder(layout);
		writeNotes(layout.vaultDir, ["Downloaded.md"]);
		writeStore(layout.vaultDir, { entries: [{ path: "Downloaded.md" }] });
		const { status, commands } = run();
		assert.equal(status, 0);
		assert.deepEqual(commands, []);
	});

	it("reports a failed sync instead of claiming success", () => {
		const { status, stderr } = run({ env: { STUB_SYNC_FAIL: "1" } });
		assert.equal(status, 1);
		assert.match(stderr, /The sync did not complete/);
	});
});
