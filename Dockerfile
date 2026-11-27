# syntax=docker/dockerfile:1

# --- build: install everything, compile, then drop dev dependencies ---
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
# Workspace discovery accepts new apps/packages without editing this Dockerfile.
COPY apps/ apps/
COPY packages/ packages/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY scripts/ scripts/
RUN npm run build && npm prune --omit=dev --ignore-scripts

# --- runtime: compiled output and production dependencies only, as a non-root user ---
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules/ node_modules/
COPY --from=build --chown=node:node /app/packages/ packages/
COPY --from=build --chown=node:node /app/apps/ apps/
RUN find apps packages -name src -type d -prune -exec rm -rf {} + \
 && find apps packages -name '*.test.js' -delete
USER node
CMD ["node", "apps/api-gateway/dist/main.js"]
