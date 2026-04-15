# =============================================================================
# Canvas — Multi-stage Dockerfile
# =============================================================================

# --- Stage 1: Install dependencies ---
FROM node:22-slim AS deps

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# --- Stage 2: Build ---
FROM node:22-slim AS build

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# --- Stage 3: Production ---
FROM node:22-slim AS production

RUN corepack enable && corepack prepare pnpm@latest --activate

# Install wget for health checks
RUN apt-get update && apt-get install -y --no-install-recommends wget && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built output and production dependencies
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# Copy static assets (fonts) and drizzle migrations
COPY --from=build /app/static ./static
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/drizzle.config.ts ./

# Copy dotenv for drizzle-kit CLI
COPY --from=build /app/src/lib/server/db ./src/lib/server/db

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Run migrations then start the server
CMD ["sh", "-c", "npx drizzle-kit migrate && node build/index.js"]
