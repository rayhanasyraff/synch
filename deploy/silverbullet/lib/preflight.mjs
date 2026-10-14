#!/usr/bin/env node
// Read-only startup guard for the SilverBullet + Synch service.
//
// The CLI treats a file it has synced before but cannot find any more as a
// local delete, and treats a local file at a remote path as a new revision
// (packages/sync-client/src/sync/engine/local-reconcile-service.ts). This
// guard therefore lets `synch watch` (and SilverBullet) start only when the
// notes folder is connected to the expected remote vault, has completed its
// first sync, and still contains the files its sync store knows about. For
// the manual procedures it also reports how the folder differs from the store.
// It never writes to the credentials file, the sync store, or the notes.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const EXIT = Object.freeze({
	READY: 0,
	CONFIG_ERROR: 2,
	NOT_CONNECTED: 10,
	NOT_INITIALIZED: 11,
	BLOCKED: 20,
});

/**
 * A start is treated as data loss, and blocked, when a large fraction of the
 * tracked files are missing (proportion rule, so it catches small vaults such
 * as 24 of 25 gone), or when a large absolute number are missing (a safety net
 * for big vaults where even a smaller fraction is a lot of notes). Either
 * condition blocks; both are deliberately conservative.
 */
export const MASS_DELETE_MIN_RATIO = 0.5;
export const MASS_DELETE_MIN_FILES = 25;

/** 8 hex chars of sha256 over the sorted missing paths: enough to bind a confirmation to one specific set. */
export function missingFingerprint(paths) {
	const normalized = [...paths].sort();
	return crypto.createHash("sha256").update(normalized.join("\n"), "utf8").digest("hex").slice(0, 8);
}

/**
 * Parses SYNCH_CONFIRM_DELETE_COUNT. A confirmation must be `<count>:<fp>`
 * (for example `24:3f9ab0c1`): the count and the fingerprint of the exact
 * missing-path set, both taken from the blocked start's message. A bare count,
 * or anything else, is invalid so a stale/guessed value fails closed.
 * @returns {{ kind: "none" } | { kind: "token", count: number, fingerprint: string } | { kind: "invalid", raw: string }}
 */
export function parseDeleteConfirmation(raw) {
	if (raw === undefined || raw === "") {
		return { kind: "none" };
	}
	const match = /^([1-9][0-9]{0,8}):([0-9a-f]{8})$/.exec(raw);
	if (!match) {
		return { kind: "invalid", raw };
	}
	return { kind: "token", count: Number(match[1]), fingerprint: match[2] };
}

/** Matches CLI conflict copies, which are local-only and never synced (sync-client file-rules.ts). */
const CONFLICT_COPY_PATTERN = /\.sync-conflict-\d{8}-\d{6}(?:-\d+)?(?:\.[^/.]+)?$/;
const SAMPLE_LIMIT = 5;

/**
 * @param {{
 *   vaultDir: string,
 *   configHome: string,
 *   expectedVaultId: string,
 *   confirmDeleteCount?: string,
 * }} input
 */
export async function inspectNotesState(input) {
	const expectedVaultId = input.expectedVaultId?.trim();
	if (!expectedVaultId) {
		return result(EXIT.CONFIG_ERROR, "config_missing_vault_id", "SYNCH_VAULT_ID is not set.");
	}
	if (!input.vaultDir || !input.configHome) {
		return result(EXIT.CONFIG_ERROR, "config_missing_paths", "Notes folder or config directory is not set.");
	}

	const vaultDir = resolveVaultPath(input.vaultDir);
	const configHome = path.resolve(input.configHome);
	if (isInside(configHome, vaultDir)) {
		return result(
			EXIT.CONFIG_ERROR,
			"config_inside_notes",
			"XDG_CONFIG_HOME must not be inside the notes folder; SilverBullet would serve the credentials.",
		);
	}

	const credential = readCredential(path.join(configHome, "synch", "credentials.json"), vaultDir, expectedVaultId);
	if (credential === "unreadable") {
		// The CLI would move an unreadable file aside and start fresh; stop instead.
		return result(EXIT.BLOCKED, "credentials_unreadable", "Cannot read the Synch CLI credentials file; inspect it manually.");
	}
	if (credential === "other_vault") {
		return result(
			EXIT.BLOCKED,
			"connected_to_other_vault",
			`${vaultDir} is connected to a different remote vault than SYNCH_VAULT_ID.`,
		);
	}

	const storePath = path.join(vaultDir, ".synch", "sync.sqlite");
	let store = null;
	if (fs.existsSync(storePath)) {
		try {
			store = await readStore(storePath);
		} catch (error) {
			return result(EXIT.BLOCKED, "sync_store_unreadable", `Cannot read ${storePath}: ${describe(error)}`);
		}
	}
	if (store?.vaultId && store.vaultId !== expectedVaultId) {
		return result(
			EXIT.BLOCKED,
			"sync_store_other_vault",
			"The folder's sync store belongs to a different remote vault than SYNCH_VAULT_ID.",
		);
	}

	if (store?.vaultId !== expectedVaultId) {
		// No sync state for this vault yet: the first sync must start from an empty folder.
		if (credential === "none") {
			return result(EXIT.NOT_CONNECTED, "no_credentials", "The Synch CLI has not signed in or connected this folder yet.");
		}
		if (credential === "not_connected") {
			return result(EXIT.NOT_CONNECTED, "folder_not_connected", `${vaultDir} is not connected to a remote vault.`);
		}
		return result(
			EXIT.NOT_INITIALIZED,
			store ? "sync_store_unbound" : "no_sync_store",
			"The first sync has not run for this folder.",
		);
	}

	// The store belongs to the expected vault: compare the folder against it.
	const missing = store.knownPaths.filter((relative) => !isFile(path.join(vaultDir, ...relative.split("/"))));
	const counts = { known: store.knownPaths.length, missing: missing.length };

	if (credential !== "connected" || !(store.cursor > 0)) {
		// Manual procedures may only proceed when the folder matches the store
		// exactly, so a sync can neither delete nor overwrite remote notes.
		const untracked = listUntrackedFiles(vaultDir, new Set(store.knownPaths));
		const details = {
			counts: { ...counts, untracked: untracked.length },
			samples: { missing: missing.slice(0, SAMPLE_LIMIT), untracked: untracked.slice(0, SAMPLE_LIMIT) },
		};
		if (credential !== "connected") {
			return result(
				EXIT.NOT_CONNECTED,
				"reconnect_required",
				"The folder has sync state for SYNCH_VAULT_ID but no stored vault key; reconnect it with synch-first-sync.",
				details,
			);
		}
		return result(
			EXIT.NOT_INITIALIZED,
			"first_sync_incomplete",
			"The first sync started but has not completed; rerun synch-first-sync.",
			details,
		);
	}

	const looksLikeDataLoss =
		counts.known > 0 &&
		counts.missing > 0 &&
		(counts.missing / counts.known >= MASS_DELETE_MIN_RATIO || counts.missing >= MASS_DELETE_MIN_FILES);
	if (looksLikeDataLoss) {
		// The confirmation is bound to this exact set of missing files by a
		// fingerprint, so a value left set cannot approve a later deletion of a
		// different set (even one of the same size). Anything that is not an
		// exact count+fingerprint match fails closed.
		const fingerprint = missingFingerprint(missing);
		const token = `${counts.missing}:${fingerprint}`;
		const confirmation = parseDeleteConfirmation(input.confirmDeleteCount);
		const howToConfirm =
			`If this exact deletion is intended, set SYNCH_CONFIRM_DELETE_COUNT=${token} for one start, then remove it.`;
		const loss =
			`${counts.missing} of ${counts.known} previously synced files are missing from ${vaultDir}. ` +
			"Starting sync would delete them from the remote vault and every device.";
		if (confirmation.kind === "token" && confirmation.count === counts.missing && confirmation.fingerprint === fingerprint) {
			return result(
				EXIT.READY,
				"mass_delete_confirmed",
				`${loss} Proceeding because SYNCH_CONFIRM_DELETE_COUNT=${token} confirms exactly this set of files.`,
				{ counts, fingerprint },
			);
		}
		if (confirmation.kind === "invalid") {
			return result(
				EXIT.BLOCKED,
				"mass_delete_confirmation_invalid",
				`${loss} SYNCH_CONFIRM_DELETE_COUNT is not a valid count:fingerprint token, so nothing is confirmed. ${howToConfirm}`,
				{ counts, fingerprint },
			);
		}
		if (confirmation.kind === "token") {
			// Either the count or the fingerprint differs: a stale confirmation
			// from a different deletion, or the missing set changed since it was issued.
			return result(
				EXIT.BLOCKED,
				"mass_delete_confirmation_mismatch",
				`${loss} SYNCH_CONFIRM_DELETE_COUNT=${input.confirmDeleteCount} does not match this deletion ` +
					`(expected ${token}), so nothing is confirmed. Restore the files, or ${howToConfirm}`,
				{ counts, fingerprint },
			);
		}
		return result(
			EXIT.BLOCKED,
			"mass_delete_guard",
			`${loss} Restore the files. ${howToConfirm}`,
			{ counts, fingerprint },
		);
	}

	return result(EXIT.READY, "ready", `Connected to the expected vault; ${counts.known} synced files tracked.`, { counts });
}

/** @returns {"none" | "unreadable" | "not_connected" | "other_vault" | "connected"} */
function readCredential(credentialsPath, vaultDir, expectedVaultId) {
	let credentials;
	try {
		credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
	} catch (error) {
		return error?.code === "ENOENT" ? "none" : "unreadable";
	}
	if (!credentials || typeof credentials !== "object") {
		return "unreadable";
	}
	// The CLI keys vault credentials by the folder's real path (apps/cli/src/host/secrets.ts).
	const connection = credentials.vaults?.[vaultDir];
	if (!connection?.remoteVaultId || !connection.remoteVaultKeyBase64) {
		return "not_connected";
	}
	return connection.remoteVaultId === expectedVaultId ? "connected" : "other_vault";
}

async function readStore(storePath) {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(storePath, { readOnly: true });
	try {
		const metadata = db
			.prepare("SELECT remote_vault_id, last_pulled_cursor FROM metadata WHERE id = 'sync'")
			.get();
		const knownPaths = db
			.prepare(
				"SELECT local_path FROM entries WHERE local_known = 1 AND local_deleted = 0 AND local_path IS NOT NULL",
			)
			.all()
			.map((row) => row.local_path);
		return {
			vaultId: metadata?.remote_vault_id?.trim() ?? "",
			cursor: Number(metadata?.last_pulled_cursor ?? 0),
			knownPaths,
		};
	} finally {
		db.close();
	}
}

/**
 * Files the store does not know about, skipping dot-prefixed paths (never
 * synced, and where the CLI and SilverBullet keep their state) and conflict
 * copies (local-only by design).
 */
function listUntrackedFiles(vaultDir, knownPaths) {
	const untracked = [];
	const walk = (relativeDir) => {
		let entries;
		try {
			entries = fs.readdirSync(path.join(vaultDir, ...relativeDir.split("/").filter(Boolean)), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) {
				continue;
			}
			const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				walk(relative);
			} else if (!knownPaths.has(relative) && !CONFLICT_COPY_PATTERN.test(relative)) {
				untracked.push(relative);
			}
		}
	};
	walk("");
	return untracked.sort();
}

function result(code, reason, message, extra) {
	return { code, reason, message, ...(extra ?? {}) };
}

function resolveVaultPath(input) {
	const resolved = path.resolve(input);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

function isInside(child, parent) {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isFile(file) {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

async function main() {
	const state = await inspectNotesState({
		vaultDir: process.env.SB_FOLDER ?? "",
		configHome: process.env.XDG_CONFIG_HOME ?? "",
		expectedVaultId: process.env.SYNCH_VAULT_ID ?? "",
		// The retired SYNCH_ALLOW_MASS_DELETE is deliberately not read.
		confirmDeleteCount: process.env.SYNCH_CONFIRM_DELETE_COUNT,
	});
	if (process.argv.includes("--json")) {
		process.stdout.write(`${JSON.stringify(state)}\n`);
	} else {
		// Counts only; file names stay out of the service logs.
		const counts = state.counts
			? ` (${Object.entries(state.counts).map(([key, value]) => `${key}=${value}`).join(", ")})`
			: "";
		process.stderr.write(`[preflight] ${state.reason}: ${state.message}${counts}\n`);
	}
	process.exitCode = state.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
	await main();
}
