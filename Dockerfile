# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/patch-zimmerframe.js ./scripts/patch-zimmerframe.js
RUN npm ci
COPY . .
RUN npm run build:web
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
MOUAIF_HOME=/data \
MOUAIF_ALLOW_ANY_ROOT=1 \
MOUAIF_CHROME_URL=http://127.0.0.1:9222 \
PUPPETEER_DANGEROUS_NO_SANDBOX=true
WORKDIR /app
# Ship a headless-capable Chrome so an agent session inside the container can
# drive and inspect the UI through the chrome-debug MCP server and the
# Inspector tab. chrome-devtools-mcp resolves its `stable` channel to
# /opt/google/chrome/chrome on Linux, so the Google build (not Debian's
# Chromium) is exactly what it launches. PUPPETEER_DANGEROUS_NO_SANDBOX is set
# because Docker's default seccomp profile blocks the namespace sandbox, and
# MOUAIF_CHROME_URL points the Inspector/webpreview at the same CDP endpoint.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        fonts-liberation \
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
