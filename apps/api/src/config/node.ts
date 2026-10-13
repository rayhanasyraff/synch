import { z } from "zod";

const optionalNonBlankString = z.preprocess(
	(value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
	z.string().trim().min(1).optional(),
);

const nodeEnvSchema = z.object({
	DATA_DIR: optionalNonBlankString.default("./data"),
	PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
	// Keep uploads below the coordinator's 30-minute staged-blob GC grace.
	REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(25 * 60_000).default(300_000),
	HOST: optionalNonBlankString.default("0.0.0.0"),
	PUBLIC_URL: optionalNonBlankString,
	CORS_ORIGIN: optionalNonBlankString,
	BETTER_AUTH_SECRET: z.string().trim().min(1, "BETTER_AUTH_SECRET is required"),
	GOOGLE_CLIENT_ID: optionalNonBlankString,
	GOOGLE_CLIENT_SECRET: optionalNonBlankString,
	GITHUB_CLIENT_ID: optionalNonBlankString,
	GITHUB_CLIENT_SECRET: optionalNonBlankString,
	AUTH_ALLOWED_EMAILS: z.string().trim().min(1, "AUTH_ALLOWED_EMAILS is required"),
	SYNC_TOKEN_SECRET: z.string().trim().min(1, "SYNC_TOKEN_SECRET is required"),
	SYNC_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().optional(),
	// Single request header carrying the client IP, set by a fronting proxy that
	// overwrites any client-supplied copy (e.g. Railway's `x-real-ip`). Only set
	// this when clients cannot reach the server except through that proxy.
	CLIENT_IP_HEADER: optionalNonBlankString.pipe(
		z
			.string()
			.regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "CLIENT_IP_HEADER must be a single HTTP header name")
			.transform((value) => value.toLowerCase())
			.optional(),
	),
	BLOB_STORAGE: z.preprocess(
		(value) => (typeof value === "string" ? value.toLowerCase() : value),
		z.enum(["disk", "s3"]).default("disk"),
	),
	BLOB_DISK_DIR: optionalNonBlankString,
	S3_ENDPOINT: optionalNonBlankString,
	S3_BUCKET: optionalNonBlankString,
	S3_REGION: optionalNonBlankString,
	S3_ACCESS_KEY_ID: optionalNonBlankString,
	S3_SECRET_ACCESS_KEY: optionalNonBlankString,
});

export type NodeBlobConfig =
	| { kind: "disk"; directory: string }
	| {
			kind: "s3";
			endpoint: string;
			bucket: string;
			region?: string;
			accessKeyId: string;
			secretAccessKey: string;
	  };

export type NodeServerConfig = {
	host: string;
	port: number;
	requestTimeoutMs: number;
	dataDir: string;
	publicUrl: string;
	corsOrigin?: string;
	betterAuthSecret: string;
	authAllowedEmails: string;
	googleClientId?: string;
	googleClientSecret?: string;
	githubClientId?: string;
	githubClientSecret?: string;
	syncTokenSecret: string;
	syncTokenTtlSeconds?: number;
	clientIpHeader?: string;
	blob: NodeBlobConfig;
};

export function parseNodeServerConfig(
	input: Readonly<Record<string, string | undefined>>,
): NodeServerConfig {
	const env = nodeEnvSchema.parse(input);
	const publicUrl = parseUrl("PUBLIC_URL", env.PUBLIC_URL ?? `http://localhost:${env.PORT}`);
	const corsOrigin = env.CORS_ORIGIN
		? new URL(parseUrl("CORS_ORIGIN", env.CORS_ORIGIN)).origin
		: undefined;

	return {
		host: env.HOST,
		port: env.PORT,
		requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
		dataDir: env.DATA_DIR,
		publicUrl,
		corsOrigin,
		betterAuthSecret: env.BETTER_AUTH_SECRET,
		authAllowedEmails: env.AUTH_ALLOWED_EMAILS,
		googleClientId: env.GOOGLE_CLIENT_ID,
		googleClientSecret: env.GOOGLE_CLIENT_SECRET,
		githubClientId: env.GITHUB_CLIENT_ID,
		githubClientSecret: env.GITHUB_CLIENT_SECRET,
		syncTokenSecret: env.SYNC_TOKEN_SECRET,
		syncTokenTtlSeconds: env.SYNC_TOKEN_TTL_SECONDS,
		clientIpHeader: env.CLIENT_IP_HEADER,
		blob: parseBlobConfig(env),
	};
}

function parseBlobConfig(env: z.infer<typeof nodeEnvSchema>): NodeBlobConfig {
	if (env.BLOB_STORAGE === "disk") {
		return {
			kind: "disk",
			directory: env.BLOB_DISK_DIR ?? `${env.DATA_DIR}/blobs`,
		};
	}

	return {
		kind: "s3",
		endpoint: requireValue("S3_ENDPOINT", env.S3_ENDPOINT),
		bucket: requireValue("S3_BUCKET", env.S3_BUCKET),
		region: env.S3_REGION,
		accessKeyId: requireValue("S3_ACCESS_KEY_ID", env.S3_ACCESS_KEY_ID),
		secretAccessKey: requireValue("S3_SECRET_ACCESS_KEY", env.S3_SECRET_ACCESS_KEY),
	};
}

function requireValue(name: string, value: string | undefined): string {
	if (!value) {
		throw new Error(`${name} is required when BLOB_STORAGE=s3`);
	}
	return value;
}

function parseUrl(name: string, value: string): string {
	try {
		new URL(value);
		return value;
	} catch {
		throw new Error(`${name} must be a valid URL`);
	}
}
