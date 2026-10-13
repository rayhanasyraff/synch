import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalDiskBlobObjectStorage } from "../sync-blob-transfer/adapters/outbound/local-disk-object-storage";
import { createNodeRuntime, type NodeRuntime } from "./node";

const publicUrl = "http://127.0.0.1:8787";

describe("Node runtime client IP header", () => {
	let dir: string | undefined;
	let runtime: NodeRuntime | undefined;

	afterEach(() => {
		runtime?.dispose();
		runtime = undefined;
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
			dir = undefined;
		}
	});

	async function sessionIpThroughRuntime(clientIpHeader: string | undefined) {
		dir = mkdtempSync(path.join(tmpdir(), "synch-node-client-ip-"));
		runtime = await createNodeRuntime({
			dataDir: dir,
			publicUrl,
			betterAuthSecret: "a-long-test-secret-with-at-least-32-characters",
			authAllowedEmails: "owner@example.com",
			syncTokenSecret: "sync-secret",
			clientIpHeader,
			blobStorage: new LocalDiskBlobObjectStorage(path.join(dir, "blobs")),
		});

		const signUp = await runtime.fetch(new Request(`${publicUrl}/v1/auth/sign-up/email`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: publicUrl,
				"x-forwarded-for": "198.51.100.50",
				"x-real-ip": "203.0.113.50",
			},
			body: JSON.stringify({ name: "Owner", email: "owner@example.com", password: "password-123" }),
		}));
		expect(signUp.status).toBe(200);

		const cookie = signUp.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
		const sessions = await runtime.fetch(new Request(`${publicUrl}/v1/auth/list-sessions`, {
			headers: { cookie },
		}));
		expect(sessions.status).toBe(200);
		const body = await sessions.json() as Array<{ ipAddress?: string | null }>;
		expect(body).toHaveLength(1);
		return body[0]?.ipAddress;
	}

	it("passes the configured header from runtime config to Better Auth", async () => {
		expect(await sessionIpThroughRuntime("x-real-ip")).toBe("203.0.113.50");
	});

	it("keeps Better Auth's default resolution when no header is configured", async () => {
		expect(await sessionIpThroughRuntime(undefined)).toBe("198.51.100.50");
	});
});
