# PAA container: Hermes + mock services + chat adapter.
#
# Each job gets one container from this image.  Inside it:
#   - mock services  (ports 9100-9134, fixture-driven Express servers)
#   - Hermes         (port 8642, loopback only; the PA under test)
#   - chat adapter   (port 8090, translates benchmark protocol <-> OpenAI format)
#
# The entrypoint boots all three in order and waits.

# ---- stage 1: install Node.js deps for our code ----
FROM node:24-bookworm-slim AS deps
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- stage 2: final image based on Hermes ----
FROM nousresearch/hermes-agent:v0.23.1

USER root

# Curl is used by the entrypoint for health-check polling
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /paa

# The base image's Node runs the mock services, the chat adapter and the config writer.
COPY --from=deps /build/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src/pa/mock-services ./src/pa/mock-services
COPY src/pa/chat-adapter  ./src/pa/chat-adapter
COPY src/pa/hermes-config ./src/pa/hermes-config
COPY src/pa/paa-info ./src/pa/paa-info
COPY src/pa/constants.ts ./src/pa/constants.ts

COPY --chmod=755 docker/paa/hermes/entrypoint.sh /usr/local/bin/paa-entrypoint.sh

# /opt/data (HERMES_HOME) is the only writable path at runtime, so the world directory
# (WORLD_DIR=/pa/world) points into it.
RUN mkdir -p /pa && chown -R hermes:hermes /paa \
  && ln -s /opt/data/world /pa/world

# Run the entrypoint directly as the hermes user, skipping the base image's s6 init.
USER hermes

ENTRYPOINT ["/usr/local/bin/paa-entrypoint.sh"]
