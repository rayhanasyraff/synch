# SilverBullet + Synch CLI: a browser editor kept in sync with an existing
# Synch remote vault. Independent of the API image (apps/api/Dockerfile).
#
# Build context is the repository root (the CLI is built from the workspace):
#
#   docker build -f deploy/silverbullet/Dockerfile -t synch-silverbullet .
#
# See deploy/silverbullet/README.md for the Railway setup and the one-time,
# manual vault connection procedure. Nothing here creates or initializes a vault.
#
# Base images are pinned to multi-arch index digests for reproducible builds.
# To update one, read the current digest of its tag (for example
# `docker buildx imagetools inspect node:24-bookworm-slim`, field "Digest"),
# replace it below, rebuild, and rerun deploy/silverbullet's tests.

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587

FROM ${NODE_IMAGE} AS cli-build
RUN corepack enable
WORKDIR /app
# Copy only what the CLI bundle needs, never the whole working tree, so
# unrelated local files (and any secrets among them) cannot enter the build.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/tsconfig/package.json packages/tsconfig/base.json packages/tsconfig/
COPY packages/vault-crypto/package.json packages/vault-crypto/tsconfig.json packages/vault-crypto/
COPY packages/sync-client/package.json packages/sync-client/tsconfig.json packages/sync-client/
COPY apps/cli/package.json apps/cli/tsconfig.json apps/cli/esbuild.config.mjs apps/cli/
RUN pnpm install --frozen-lockfile --filter @synch/cli...
COPY packages/vault-crypto/src packages/vault-crypto/src
COPY packages/sync-client/src packages/sync-client/src
COPY apps/cli/src apps/cli/src
# Bundle only; type checking belongs to the repository's own checks.
RUN cd apps/cli && node esbuild.config.mjs

FROM ${DEBIAN_IMAGE} AS silverbullet
# Pinned release asset and its published SHA-256 digest. Upgrade both together.
# 2.12.1 is the first release whose filesystem API refuses dot-prefixed paths,
# which keeps the CLI's .synch/ state out of reach of the browser.
ARG SILVERBULLET_VERSION=2.12.1
ARG SILVERBULLET_SHA256=0ea5c0575021de354b79bf53fb85f170aca93e228b5593959869ff8841dbb1d3
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl unzip \
	&& rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/silverbullet.zip \
		"https://github.com/silverbulletmd/silverbullet/releases/download/${SILVERBULLET_VERSION}/silverbullet-server-linux-x86_64.zip" \
	&& echo "${SILVERBULLET_SHA256}  /tmp/silverbullet.zip" | sha256sum -c - \
	&& unzip -q /tmp/silverbullet.zip -d /tmp/silverbullet \
	&& install -m 0755 /tmp/silverbullet/silverbullet /usr/local/bin/silverbullet \
	&& /usr/local/bin/silverbullet --version

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
	&& apt-get install -y --no-install-recommends tini ca-certificates \
	&& rm -rf /var/lib/apt/lists/*
# Process isolation: the CLI (which holds the decrypted vault key) and
# SilverBullet run as different users that only share the notes folder via
# the `notes` group. The entrypoint stays root only to prepare the volume.
RUN groupadd --gid 10000 notes \
	&& useradd --uid 10001 --user-group --groups notes --home-dir /home/synch --create-home --shell /usr/sbin/nologin synch \
	&& useradd --uid 10002 --user-group --groups notes --home-dir /home/silverbullet --create-home --shell /usr/sbin/nologin silverbullet \
	&& chmod 0700 /home/synch /home/silverbullet \
	&& find / -xdev -perm /6000 -type f -exec chmod a-s {} +
COPY --from=silverbullet /usr/local/bin/silverbullet /usr/local/bin/silverbullet
COPY --from=cli-build /app/apps/cli/dist/synch.js /opt/synch/synch.js
COPY deploy/silverbullet/entrypoint.sh /opt/notes/entrypoint.sh
COPY deploy/silverbullet/lib /opt/notes/lib
COPY deploy/silverbullet/bin /opt/notes/bin
# Operator commands (used through `railway ssh`, which is root) re-launch
# themselves as `synch`, so files on the volume keep the expected ownership.
# `synch` on PATH is the guarded wrapper (bin/synch); the unguarded CLI entry
# (lib/synch-unguarded) is used only by the entrypoint and synch-first-sync.
RUN chmod 0755 /opt/notes/entrypoint.sh /opt/notes/lib/as-synch /opt/notes/lib/synch-unguarded /opt/notes/bin/* \
	&& for tool in synch synch-first-sync synch-list-vaults synch-preflight; do \
		printf '#!/bin/sh\nexec /opt/notes/lib/as-synch /opt/notes/bin/%s "$@"\n' "$tool" > "/usr/local/bin/$tool"; \
	done \
	&& chmod 0755 /usr/local/bin/synch /usr/local/bin/synch-first-sync /usr/local/bin/synch-list-vaults /usr/local/bin/synch-preflight

# The notes folder and the CLI credentials both live on the service volume,
# with credentials kept outside the folder SilverBullet serves.
ENV NODE_ENV=production \
	NOTES_HOME=/opt/notes \
	DATA_ROOT=/data \
	SB_FOLDER=/data/space \
	XDG_CONFIG_HOME=/data/synch-config \
	SB_HOSTNAME=0.0.0.0

EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/notes/entrypoint.sh"]
