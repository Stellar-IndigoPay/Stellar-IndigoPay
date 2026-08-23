# Test stage — devDependencies for jest in docker-compose.test.yml
# Pinned to a current LTS (Node 22). For digest pinning (recommended
# for prod), compute the real digest with:
#   docker buildx imagetools inspect node:22.14.0-alpine
# and append `@sha256:<digest>` to each `FROM` below. Do NOT fabricate
# a digest — a fake SHA breaks `docker build` immediately.
#
# Build context is the REPO ROOT (not backend/), because
# src/validators/schemas.js requires ../../../shared/validation.js
# (Issue #90-follow-up: shared validation module). Root package.json's
# only dependency is `zod`, installed at / so shared/validation.js's
# own require("zod") resolves the same way it does in Dockerfile.test.
FROM node:22-alpine AS test

WORKDIR /app

COPY package*.json /
RUN cd / && npm ci --omit=dev

COPY shared/ /shared/

COPY backend/package*.json ./
RUN npm ci

COPY backend/ ./

CMD ["npm", "test"]

# 1. Builder Stage
# Pinned to a current LTS (Node 22) with a SHA256 digest for reproducibility.
FROM node:22-alpine AS builder

WORKDIR /app

COPY backend/package*.json ./

RUN npm ci --omit=dev

# 2. Production Runner Stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV production

COPY package*.json /
RUN cd / && npm ci --omit=dev

COPY shared/ /shared/

# Copy package files and production dependencies
COPY backend/package*.json ./
COPY --from=builder /app/node_modules ./node_modules

# Copy source code
COPY backend/ ./

EXPOSE 4000

# Run Node.js directly as PID 1 (best practice)
CMD ["node", "src/server.js"]
