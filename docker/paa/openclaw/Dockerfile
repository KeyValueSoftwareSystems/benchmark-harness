# PAA container: OpenClaw + mock services + chat adapter.
#
# Each job gets one container from this image.  Inside it:
#   - mock services  (ports 9100-9134, fixture-driven Express servers)
#   - OpenClaw       (port 18789, the PA under test)
#   - chat adapter   (port 8090, translates benchmark protocol <-> OpenAI format)
#
# The entrypoint boots all three in order and waits.

# ---- stage 1: install Node.js deps for our code ----
FROM node:24-bookworm-slim AS deps
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- stage 2: final image based on OpenClaw ----
FROM ghcr.io/openclaw/openclaw:2026.10.10

# Switch to root for setup (OpenClaw image runs as non-root by default)
USER root

# Curl is needed by the entrypoint for health-check polling
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /paa

# Copy Node.js runtime from the builder (in case the OpenClaw image
# ships an older version or none at all)
COPY --from=deps /usr/local/bin/node /usr/local/bin/node

# Copy npm deps and our source code
COPY --from=deps /build/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src/pa/mock-services ./src/pa/mock-services
COPY src/pa/chat-adapter  ./src/pa/chat-adapter
COPY src/pa/paa-info ./src/pa/paa-info
COPY src/pa/constants.ts ./src/pa/constants.ts

# Entrypoint script
COPY --chmod=755 docker/paa/openclaw/entrypoint.sh /usr/local/bin/paa-entrypoint.sh

# Ensure the OpenClaw writable directory exists and is owned by node. It is the only
# writable path at runtime, so the world directory (WORLD_DIR=/pa/world) points into it.
RUN mkdir -p /home/node/.openclaw /pa && chown -R node:node /home/node/.openclaw \
  && chown -R node:node /paa \
  && ln -s /home/node/.openclaw/world /pa/world

USER node

# The root filesystem is read-only at runtime and OpenClaw rejects the world-writable /tmp
# for its private temp dir, so keep its cache inside the writable scratch directory.
ENV XDG_CACHE_HOME=/home/node/.openclaw/cache

ENTRYPOINT ["/usr/local/bin/paa-entrypoint.sh"]
