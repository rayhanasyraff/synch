// Run with: node --test "deploy/silverbullet/test/*.test.mjs"   (Linux; needs bash)
// Exercises entrypoint.sh with stub `synch`, `silverbullet`, and preflight
// programs so startup gating and process supervision are tested without
// network access or real notes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ENTRYPOINT = fileURLToPath(new URL("../entrypoint.sh", import.meta.url));
const skip = process.platform === "win32" ? "entrypoint.sh needs a POSIX shell" : false;

let root;
let children = [];
beforeEach(() => {
	children = [];
	root = fs.mkdtempSync(path.join(os.tmpdir(), "notes-entrypoint-"));
	fs.mkdirSync(path.join(root, "notes", "lib"), { recursive: true });
	fs.mkdirSync(path.join(root, "bin"));
});
afterEach(() => {
	for (const child of children) {
		child.stderr?.destroy();
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			// The group already exited.
		}
	}
	fs.rmSync(root, { recursive: true, force: true });
});

function stubPreflight(exitCode) {
	fs.writeFileSync(path.join(root, "notes", "lib", "preflight.mjs"), `process.exit(${exitCode});\n`);
}

/** A stub that records its arguments, then exits with STUB_<NAME>_EXIT or waits for SIGTERM. */
function stubProgram(name) {
	const file = path.join(root, "bin", name);
	const envName = `STUB_${name.toUpperCase()}_EXIT`;
	fs.writeFileSync(
		file,
		`#!/usr/bin/env bash
printf '%s\\n' "$*" > "${root}/${name}.args"
printf '%s\\n' "$SB_PORT" > "${root}/${name}.port"
printf '%s\\n' "\${SB_USER:-}" > "${root}/${name}.sbuser"
if [[ -n "\${${envName}:-}" ]]; then sleep 0.3; exit "\${${envName}}"; fi
sleep infinity &
sleep_pid=$!
trap 'echo term > "${root}/${name}.term"; kill "$sleep_pid"; exit 0' TERM
wait "$sleep_pid"
`,
	);
	fs.chmodSync(file, 0o755);
}

function run(env = {}) {
	stubProgram("synch");
	stubProgram("silverbullet");
	const fullEnv = {
			PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
			NOTES_HOME: path.join(root, "notes"),
			SB_FOLDER: path.join(root, "data", "space"),
			XDG_CONFIG_HOME: path.join(root, "data", "synch-config"),
			SB_USER: "editor:a-sufficiently-long-password",
			SYNCH_VAULT_ID: "vault-expected",
			SYNCH_API_URL: "https://api.example",
			SYNCH_BIN: "synch",
			PORT: "8080",
			...env,
	};
	// A null value removes the variable, to exercise the script's defaults.
	for (const [key, value] of Object.entries(fullEnv)) if (value === null) delete fullEnv[key];
	const child = spawn("bash", [ENTRYPOINT], {
		env: fullEnv,
		stdio: ["ignore", "ignore", "pipe"],
		// Own process group, so cleanup can reach every descendant.
		detached: true,
	});
	children.push(child);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = new Promise((resolve) => child.on("exit", (code) => resolve({ code, stderr })));
	return { child, exited };
}

const exists = (name) => fs.existsSync(path.join(root, name));
const read = (name) => fs.readFileSync(path.join(root, name), "utf8").trim();
const waitFor = async (predicate, ms = 5000) => {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
};

describe("entrypoint.sh", { skip }, () => {
	it("refuses to start without SilverBullet authentication", async () => {
		stubPreflight(0);
		const { exited } = run({ SB_USER: "" });
		const { code, stderr } = await exited;
		assert.equal(code, 1);
		assert.match(stderr, /SB_USER must be set/);
		assert.equal(exists("silverbullet.args"), false);
		assert.equal(exists("synch.args"), false);
	});

	it("refuses a short SilverBullet password", async () => {
		stubPreflight(0);
		const { code, stderr } = await run({ SB_USER: "editor:short" }).exited;
		assert.equal(code, 1);
		assert.match(stderr, /at least 16 characters/);
	});

	it("requires the expected vault ID", async () => {
		stubPreflight(0);
		const { code } = await run({ SYNCH_VAULT_ID: "" }).exited;
		assert.equal(code, 1);
	});

	for (const preflightExit of [10, 11, 20]) {
		it(`stays in maintenance mode without serving or syncing (preflight ${preflightExit})`, async () => {
			stubPreflight(preflightExit);
			const { child, exited } = run();
			await new Promise((resolve) => setTimeout(resolve, 500));
			assert.equal(exists("silverbullet.args"), false);
			assert.equal(exists("synch.args"), false);
			child.kill("SIGTERM");
			const { code, stderr } = await exited;
			assert.equal(code, 0);
			assert.match(stderr, /Maintenance mode/);
		});
	}

	it("NOTES_MAINTENANCE=1 keeps everything stopped even when the folder is ready", async () => {
		fs.writeFileSync(
			path.join(root, "notes", "lib", "preflight.mjs"),
			`import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(path.join(root, "preflight.ran"))}, "");\nprocess.exit(0);\n`,
		);
		const { child, exited } = run({ NOTES_MAINTENANCE: "1" });
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(exists("silverbullet.args"), false);
		assert.equal(exists("synch.args"), false);
		assert.equal(exists("preflight.ran"), false);
		child.kill("SIGTERM");
		const { code, stderr } = await exited;
		assert.equal(code, 0);
		assert.match(stderr, /NOTES_MAINTENANCE=1/);
	});

	it("still refuses to start without authentication in maintenance mode", async () => {
		stubPreflight(0);
		const { code } = await run({ NOTES_MAINTENANCE: "1", SB_USER: "" }).exited;
		assert.equal(code, 1);
	});

	async function stderrOfMaintenanceStart(env) {
		stubPreflight(10);
		const { child, exited } = run(env);
		await new Promise((resolve) => setTimeout(resolve, 300));
		child.kill("SIGTERM");
		return (await exited).stderr;
	}

	it("warns loudly whenever SYNCH_CONFIRM_DELETE_COUNT is set, echoing the value", async () => {
		const stderr = await stderrOfMaintenanceStart({ SYNCH_CONFIRM_DELETE_COUNT: "42:3f9ab0c1" });
		assert.match(stderr, /WARNING: SYNCH_CONFIRM_DELETE_COUNT=42:3f9ab0c1 is set/);
		assert.match(stderr, /Any other value stays blocked/);
		assert.match(stderr, /Remove it right after this start/);
	});

	it("reports the retired SYNCH_ALLOW_MASS_DELETE as ignored", async () => {
		const stderr = await stderrOfMaintenanceStart({ SYNCH_ALLOW_MASS_DELETE: "1" });
		assert.match(stderr, /SYNCH_ALLOW_MASS_DELETE is no longer supported and is ignored/);
	});

	it("does not warn about mass deletion when neither variable is set", async () => {
		const stderr = await stderrOfMaintenanceStart({});
		assert.doesNotMatch(stderr, /SYNCH_CONFIRM_DELETE_COUNT|SYNCH_ALLOW_MASS_DELETE/);
	});

	it("warns that isolation is off when not started as root", async () => {
		stubPreflight(10);
		const { child, exited } = run();
		await new Promise((resolve) => setTimeout(resolve, 300));
		child.kill("SIGTERM");
		const { stderr } = await exited;
		if (process.getuid?.() === 0) {
			assert.doesNotMatch(stderr, /no isolation/);
		} else {
			assert.match(stderr, /no isolation/);
		}
	});

	it("fails on an unexpected preflight error", async () => {
		stubPreflight(2);
		const { code } = await run().exited;
		assert.equal(code, 1);
		assert.equal(exists("silverbullet.args"), false);
	});

	it("removes a stale CLI lock before starting", async () => {
		stubPreflight(0);
		const lock = path.join(root, "data", "space", ".synch", "cli.lock");
		fs.mkdirSync(path.dirname(lock), { recursive: true });
		fs.writeFileSync(lock, '{"pid":7}\n');
		const { child, exited } = run();
		await waitFor(() => exists("synch.args"));
		assert.equal(fs.existsSync(lock), false);
		child.kill("SIGTERM");
		await exited;
	});

	it("runs both processes on the same folder and Railway's port, and stops both on SIGTERM", async () => {
		stubPreflight(0);
		const { child, exited } = run();
		await waitFor(() => exists("synch.args") && exists("silverbullet.args"));
		const space = path.join(root, "data", "space");
		assert.equal(read("synch.args"), `watch --vault ${space}`);
		assert.equal(read("synch.sbuser"), "", "the CLI must not receive SB_USER");
		assert.equal(read("silverbullet.sbuser"), "editor:a-sufficiently-long-password");
		assert.equal(read("silverbullet.args"), `--single ${space}`);
		assert.equal(read("silverbullet.port"), "8080");
		assert.equal((fs.statSync(path.join(root, "data", "synch-config")).mode & 0o777).toString(8), "700");
		child.kill("SIGTERM");
		const { code } = await exited;
		assert.equal(code, 0);
		assert.equal(exists("synch.term"), true);
		assert.equal(exists("silverbullet.term"), true);
	});

	it("starts sync through lib/synch-unguarded by default (its own preflight replaces the guard)", async () => {
		stubPreflight(0);
		const unguarded = path.join(root, "notes", "lib", "synch-unguarded");
		fs.writeFileSync(unguarded, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "${root}/unguarded.args"\nsleep infinity & wait $!\n`);
		fs.chmodSync(unguarded, 0o755);
		const { child, exited } = run({ SYNCH_BIN: null });
		await waitFor(() => exists("unguarded.args"));
		assert.equal(read("unguarded.args"), `watch --vault ${path.join(root, "data", "space")}`);
		child.kill("SIGTERM");
		await exited;
	});

	it("stops SilverBullet and exits non-zero when sync exits", async () => {
		stubPreflight(0);
		const { code, stderr } = await run({ STUB_SYNCH_EXIT: "1" }).exited;
		assert.equal(code, 1);
		assert.equal(exists("silverbullet.term"), true);
		assert.match(stderr, /supervised process exited/);
	});

	it("stops sync and exits non-zero when SilverBullet exits", async () => {
		stubPreflight(0);
		const { code } = await run({ STUB_SILVERBULLET_EXIT: "0" }).exited;
		assert.equal(code, 1);
		assert.equal(exists("synch.term"), true);
	});
});
