// Shared fixtures: credentials and sync stores shaped exactly like the CLI's.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SQLITE_STORE_SCHEMA } from "../../../apps/cli/src/host/sqlite-store/schema.ts";

export const VAULT_ID = "vault-expected";

/** A temp layout mirroring the container: <root>/space and <root>/synch-config. */
export function createLayout(prefix) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	const vaultDir = path.join(root, "space");
	const configHome = path.join(root, "synch-config");
	fs.mkdirSync(vaultDir);
	return { root, vaultDir, configHome };
}

/** Writes credentials.json like CliCredentialsStore (vaults keyed by real path). */
export function writeCredentials(configHome, vaults) {
	fs.mkdirSync(path.join(configHome, "synch"), { recursive: true });
	fs.writeFileSync(
		path.join(configHome, "synch", "credentials.json"),
		JSON.stringify({ version: 1, sessionToken: "token", vaults }),
	);
}

export function connectFolder(layout, remoteVaultId = VAULT_ID) {
	writeCredentials(layout.configHome, {
		[layout.vaultDir]: { remoteVaultId, remoteVaultKeyBase64: "a2V5" },
	});
}

/** Creates (or replaces) a sync store with the CLI's real schema. */
export function writeStore(vaultDir, { remoteVaultId = VAULT_ID, cursor = 7, entries = [] } = {}) {
	const file = path.join(vaultDir, ".synch", "sync.sqlite");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.rmSync(file, { force: true });
	const db = new DatabaseSync(file);
	db.exec(SQLITE_STORE_SCHEMA);
	db.prepare(
		"INSERT INTO metadata (id, local_vault_id, remote_vault_id, last_pulled_cursor) VALUES ('sync', 'local-1', ?, ?)",
	).run(remoteVaultId, cursor);
	const insert = db.prepare(`INSERT INTO entries (
		entry_id, remote_known, remote_revision, remote_deleted, remote_updated_at,
		base_revision, base_deleted, local_known, local_path, local_deleted, local_updated_at, dirty
	) VALUES (?, 1, 1, 0, 0, 1, 0, 1, ?, ?, 0, 0)`);
	entries.forEach((entry, index) => insert.run(`entry-${index}`, entry.path, entry.deleted ? 1 : 0));
	db.close();
}

export function writeNotes(vaultDir, paths) {
	for (const relative of paths) {
		const file = path.join(vaultDir, ...relative.split("/"));
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `# ${relative}\n`);
	}
}

export const notes = (count, prefix = "Note") => Array.from({ length: count }, (_, i) => `${prefix} ${i}.md`);
