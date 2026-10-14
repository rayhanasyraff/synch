// Run with: node --test "deploy/silverbullet/test/*.test.mjs"   (Linux; needs bash)
// Drives bin/synch (the guarded wrapper) with the real preflight and
// real-schema stores; only the unguarded CLI is a stub that records calls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { missingFingerprint } from "../lib/preflight.mjs";
import { VAULT_ID, connectFolder, createLayout, notes, writeNotes, writeStore } from "./helpers.mjs";

const DEPLOY_DIR = fileURLToPath(new URL("..", import.meta.url));
const GUARD = path.join(DEPLOY_DIR, "bin", "synch");
const skip = process.platform === "win32" ? "bin/synch needs a POSIX shell" : false;

let layout;
let calls;
beforeEach(() => {
	layout = createLayout("notes-guard-");
	calls = path.join(layout.root, "cli-calls.log");
	const stub = path.join(layout.root, "synch-unguarded");
	fs.writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n`);
	fs.chmodSync(stub, 0o755);
});
afterEach(() => fs.rmSync(layout.root, { recursive: true, force: true }));

function guard(args, { cwd = layout.root, env = {} } = {}) {
	const result = spawnSync("bash", [GUARD, ...args], {
		cwd,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			NOTES_HOME: DEPLOY_DIR,
			SYNCH_UNGUARDED: path.join(layout.root, "synch-unguarded"),
			SB_FOLDER: layout.vaultDir,
			XDG_CONFIG_HOME: layout.configHome,
			SYNCH_VAULT_ID: VAULT_ID,
			...env,
		},
	});
	const forwarded = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : [];
	return { status: result.status, stderr: result.stderr, forwarded };
}

function readyFolder() {
	connectFolder(layout);
	writeNotes(layout.vaultDir, notes(2));
	writeStore(layout.vaultDir, { entries: notes(2).map((p) => ({ path: p })) });
}

describe("bin/synch guard", { skip }, () => {
	it("refuses pull in every state", () => {
		readyFolder();
		for (const args of [["pull"], ["pull", "--vault", layout.vaultDir], ["--vault", layout.vaultDir, "pull"]]) {
			const { status, stderr, forwarded } = guard(args);
			assert.equal(status, 2, args.join(" "));
			assert.match(stderr, /'synch pull' is disabled/);
			assert.deepEqual(forwarded, []);
		}
	});

	it("refuses a hand-run vault connect and points to synch-first-sync", () => {
		const { status, stderr, forwarded } = guard(["vault", "connect", "--vault-id", VAULT_ID, "--vault", layout.vaultDir]);
		assert.equal(status, 2);
		assert.match(stderr, /synch-first-sync/);
		assert.deepEqual(forwarded, []);
	});

	for (const command of ["sync", "watch"]) {
		it(`forwards ${command} for the managed folder when the preflight is ready`, () => {
			readyFolder();
			const { status, forwarded } = guard([command, "--vault", layout.vaultDir]);
			assert.equal(status, 0);
			assert.deepEqual(forwarded, [`${command} --vault ${layout.vaultDir}`]);
		});

		it(`refuses ${command} when the folder is not connected yet`, () => {
			const { status, stderr, forwarded } = guard([command, "--vault", layout.vaultDir]);
			assert.equal(status, 2);
			assert.match(stderr, /no_credentials/);
			assert.deepEqual(forwarded, []);
		});

		it(`refuses ${command} when a mass deletion is pending`, () => {
			connectFolder(layout);
			writeStore(layout.vaultDir, { entries: notes(3).map((p) => ({ path: p })) });
			const { status, stderr, forwarded } = guard([command, "--vault", layout.vaultDir]);
			assert.equal(status, 2);
			assert.match(stderr, /mass_delete_guard/);
			assert.deepEqual(forwarded, []);
		});

		it(`refuses ${command} for any other folder`, () => {
			readyFolder();
			const other = path.join(layout.root, "elsewhere");
			fs.mkdirSync(other);
			const { status, stderr, forwarded } = guard([command, "--vault", other]);
			assert.equal(status, 2);
			assert.match(stderr, /only runs for the managed notes folder/);
			assert.deepEqual(forwarded, []);
		});
	}

	it("uses the current directory when --vault is omitted, like the CLI", () => {
		readyFolder();
		assert.equal(guard(["sync"], { cwd: layout.vaultDir }).status, 0);
		assert.equal(guard(["sync"], { cwd: layout.root }).status, 2);
	});

	it("understands --vault=<path>", () => {
		readyFolder();
		assert.equal(guard([`--vault=${layout.vaultDir}`, "sync"]).status, 0);
	});

	it("honours a confirmed mass deletion token, exactly as the service start would", () => {
		connectFolder(layout);
		writeStore(layout.vaultDir, { entries: notes(3).map((p) => ({ path: p })) });
		const token = `3:${missingFingerprint(notes(3))}`;
		assert.equal(guard(["sync", "--vault", layout.vaultDir], { env: { SYNCH_CONFIRM_DELETE_COUNT: token } }).status, 0);
		assert.equal(guard(["sync", "--vault", layout.vaultDir], { env: { SYNCH_CONFIRM_DELETE_COUNT: "3:deadbeef" } }).status, 2);
	});

	it("passes safe commands through unchanged", () => {
		for (const args of [["login"], ["logout"], ["status", "--vault", layout.vaultDir], ["--help"], ["-v"], []]) {
			fs.rmSync(calls, { force: true });
			const { status, forwarded } = guard(args);
			assert.equal(status, 0, args.join(" "));
			assert.deepEqual(forwarded, [args.join(" ")]);
		}
	});

	it("lets --help through even for guarded commands", () => {
		const { status, forwarded } = guard(["pull", "--help"]);
		assert.equal(status, 0);
		assert.deepEqual(forwarded, ["pull --help"]);
	});
});
