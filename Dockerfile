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
    MOUAIF_ALLOW_ANY_ROOT=1
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
