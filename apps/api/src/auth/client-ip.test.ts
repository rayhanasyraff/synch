import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAuthFeature, type AuthFeature } from "../composition/features/create-auth-feature";
import { parseNodeServerConfig } from "../config/node";
import { createLibsqlDb } from "../db/client";

// Under NODE_ENV=test, Better Auth falls back to 127.0.0.1 when no configured
// header yields a trusted IP; production resolves no IP at all instead.
const TEST_MODE_FALLBACK_IP = "127.0.0.1";

const baseURL = "http://localhost:8787";
let client: Client;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
});
afterEach(() => client.close());

function feature(clientIpHeader?: string, options: { rateLimit?: boolean } = {}): AuthFeature {
  const config = parseNodeServerConfig({
    BETTER_AUTH_SECRET: "a-long-test-secret-with-at-least-32-characters",
    SYNC_TOKEN_SECRET: "sync-secret",
    AUTH_ALLOWED_EMAILS: "owner@example.com",
    CLIENT_IP_HEADER: clientIpHeader,
  });
  return createAuthFeature(createLibsqlDb(client), {
    baseURL,
    trustedOrigins: [baseURL],
    emailVerification: "disabled",
    devMode: false,
    secret: config.betterAuthSecret,
    allowedEmails: config.authAllowedEmails,
    clientIpHeader: config.clientIpHeader,
  }, options.rateLimit ? [{
    id: "test-rate-limit",
    // Better Auth only enables rate limiting under NODE_ENV=production.
    init: () => ({ context: { rateLimit: { enabled: true, window: 10, max: 100, storage: "memory" } } }),
  }] : []);
}

function post(auth: AuthFeature, path: string, body: unknown, headers: Record<string, string>) {
  return auth.authHttpHandler(new Request(`${baseURL}/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseURL, ...headers },
    body: JSON.stringify(body),
  }));
}

async function recordedSessionIp(auth: AuthFeature, headers: Record<string, string>) {
  const signUp = await post(auth, "sign-up/email", {
    name: "Owner", email: "owner@example.com", password: "password-123",
  }, headers);
  expect(signUp.status).toBe(200);
  return (await client.execute("SELECT ip_address FROM session")).rows[0]?.ip_address;
}

function failedSignIn(auth: AuthFeature, realIp: string) {
  return post(auth, "sign-in/email", {
    email: "nobody@example.com", password: "wrong-password",
  }, { "x-real-ip": realIp });
}

describe("client IP resolution", () => {
  it("keeps Better Auth's default x-forwarded-for resolution when unset", async () => {
    expect(await recordedSessionIp(feature(), {
      "x-forwarded-for": "198.51.100.10",
      "x-real-ip": "203.0.113.10",
    })).toBe("198.51.100.10");
  });

  it("ignores x-real-ip when unset", async () => {
    expect(await recordedSessionIp(feature(), { "x-real-ip": "203.0.113.11" }))
      .toBe(TEST_MODE_FALLBACK_IP);
  });

  it("resolves only the configured header", async () => {
    expect(await recordedSessionIp(feature("X-Real-IP"), {
      "x-forwarded-for": "198.51.100.12",
      "x-real-ip": "203.0.113.12",
    })).toBe("203.0.113.12");
  });

  it("does not fall back to x-forwarded-for when the configured header is missing", async () => {
    expect(await recordedSessionIp(feature("x-real-ip"), { "x-forwarded-for": "198.51.100.13" }))
      .toBe(TEST_MODE_FALLBACK_IP);
  });
});

// Better Auth keeps memory rate-limit counters in a module-level map shared by
// every instance in this file, keyed by `<ip>|<path>`. Only these tests enable
// rate limiting, and each resolves to client IPs no other test uses.
describe("sign-in rate limiting", () => {
  it("shares one bucket across x-real-ip values when unset", async () => {
    const auth = feature(undefined, { rateLimit: true });

    // Both addresses resolve to the test-mode fallback, so they share a bucket.
    for (let i = 0; i < 3; i++) expect((await failedSignIn(auth, "203.0.113.30")).status).toBe(401);
    expect((await failedSignIn(auth, "203.0.113.30")).status).toBe(429);
    expect((await failedSignIn(auth, "203.0.113.31")).status).toBe(429);
  });

  it("keeps a separate bucket per configured client IP", async () => {
    const auth = feature("x-real-ip", { rateLimit: true });

    for (let i = 0; i < 3; i++) expect((await failedSignIn(auth, "203.0.113.20")).status).toBe(401);
    expect((await failedSignIn(auth, "203.0.113.20")).status).toBe(429);
    expect((await failedSignIn(auth, "203.0.113.21")).status).toBe(401);
  });
});
