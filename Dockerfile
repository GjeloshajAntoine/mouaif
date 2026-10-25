# syntax=docker/dockerfile:1
# Both later stages start FROM base, so BuildKit must finish this layer before
# it starts the npm install / Vite build. With two independent stages it ran
# the Chrome install and the Vite build at the same time, and on a 2-CPU /
# 4 GiB host the pair ran out of memory and stalled the machine for minutes.
FROM node:24-bookworm-slim AS base
# Ship a headless-capable Chrome so an agent session inside the container can
# drive and inspect the UI through the chrome-debug MCP server and the
# Inspector tab. chrome-devtools-mcp resolves its `stable` channel to
# /opt/google/chrome/chrome on Linux, so the Google build (not Debian's
# Chromium) is exactly what it launches. PUPPETEER_DANGEROUS_NO_SANDBOX is set
# because Docker's default seccomp profile blocks the namespace sandbox, and
# MOUAIF_CHROME_URL points the Inspector/webpreview at the same CDP endpoint.
# git is installed for the chat's Git sheet and for the git commands the
# assistant runs through the shell tool; without it both fail with ENOENT.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        fonts-liberation \
        git \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libglib2.0-0 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libx11-6 \
        libxcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        libxss1 \
        wget \
    && wget -q -O /tmp/google-chrome-stable.deb \
        https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y --no-install-recommends /tmp/google-chrome-stable.deb \
    && rm -f /tmp/google-chrome-stable.deb \
    && rm -rf /var/lib/apt/lists/* \
    && google-chrome --version

FROM base AS build

# BuildKit cannot cap a build's CPU or memory, so the build keeps itself small
# instead: a bounded V8 heap fails fast with an out-of-memory error rather than
# pushing a small host into swap, GOMAXPROCS=1 keeps Vite's esbuild on one
# core, and the heavy steps run at low priority so the host stays responsive.
# Raise the heap with `--build-arg BUILD_HEAP_MB=2048` if the bundle outgrows it.
ARG BUILD_HEAP_MB=1024
ENV NODE_OPTIONS=--max-old-space-size=${BUILD_HEAP_MB} \
GOMAXPROCS=1 \
UV_THREADPOOL_SIZE=2

WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` runs the package lifecycle scripts here, so both files they need must
# exist before the install: `postinstall` runs scripts/patch-zimmerframe.js and
# `prepare` runs scripts/prepare-web.js. Copy exactly those two (not all of
# scripts/) so the cached install layer only invalidates when they change.
COPY scripts/patch-zimmerframe.js scripts/prepare-web.js ./scripts/
RUN nice -n 10 npm ci --maxsockets=4
COPY . .
RUN nice -n 10 npm run build:web
RUN npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production \
MOUAIF_HOME=/data \
MOUAIF_ALLOW_ANY_ROOT=1 \
MOUAIF_CHROME_URL=http://127.0.0.1:9222 \
PUPPETEER_DANGEROUS_NO_SANDBOX=true
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/bin ./bin
COPY --from=build /app/src ./src
COPY --from=build /app/frontend/dist ./frontend/dist
COPY --from=build /app/node_modules ./node_modules
RUN mkdir -p /data /workspace && chown -R node:node /data /workspace
USER node
EXPOSE 5732
VOLUME ["/data", "/workspace"]
CMD ["node", "bin/mouaif.js", "serve", "--host", "0.0.0.0", "--port", "5732"]
