# 1. Builder Stage
# Pinned to a current LTS (Node 22). Replace with
#   node:22.14.0-alpine@sha256:<digest>
# once you have computed the digest via:
#   docker buildx imagetools inspect node:22.14.0-alpine
# Pinning to a digest prevents a compromised upstream from silently
# shipping a new image under the same tag.
#
# Build context is the REPO ROOT (not frontend/), because
# lib/validation/schemas.ts imports @shared/validation (Issue
# #90-follow-up: shared validation module). Next.js bundles this into
# .next at build time, so the runner stage below needs neither
# shared/ nor the root node_modules at runtime.
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json /
RUN cd / && npm ci --omit=dev

COPY shared/ /shared/

COPY frontend/package*.json ./
RUN npm ci --legacy-peer-deps

COPY frontend/ ./
RUN npm run build

# 2. Production Runner Stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV production

# Copy package files and install only production dependencies
COPY frontend/package*.json ./
RUN npm ci --omit=dev --legacy-peer-deps

# Copy built assets and configuration from builder
COPY --from=builder /app/next.config.mjs ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public

EXPOSE 3000

CMD ["npm", "run", "start"]
