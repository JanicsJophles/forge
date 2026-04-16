FROM node:20-slim AS base
WORKDIR /app

# Install git + claude CLI deps
RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Install claude CLI
RUN npm install -g @anthropic-ai/claude-code

# ── Build stage ───────────────────────────────────────────────────────────────
FROM base AS build
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/runner/package.json ./apps/runner/

RUN npm install

COPY packages/shared/ ./packages/shared/
COPY apps/runner/ ./apps/runner/

RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=apps/runner

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM base AS runtime
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/apps/runner/dist ./apps/runner/dist
COPY --from=build /app/apps/runner/package.json ./apps/runner/
COPY --from=build /app/apps/runner/node_modules ./apps/runner/node_modules

WORKDIR /app/apps/runner

EXPOSE 5000

CMD ["node", "dist/index.js"]
