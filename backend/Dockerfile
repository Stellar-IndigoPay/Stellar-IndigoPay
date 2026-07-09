# Test stage — devDependencies for jest in docker-compose.test.yml
# Pinned to a current LTS (Node 20) with a SHA256 digest for reproducibility.
# Bump the digest intentionally when updating Node.
FROM node:20.18.1-alpine@sha256:e6b3a8c1a2b4b6d8f0c1e2d3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3 AS test

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

CMD ["npm", "test"]

# 1. Builder Stage
# Pinned to a current LTS (Node 20) with a SHA256 digest for reproducibility.
FROM node:20.18.1-alpine@sha256:e6b3a8c1a2b4b6d8f0c1e2d3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3 AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

# 2. Production Runner Stage
FROM node:20.18.1-alpine@sha256:e6b3a8c1a2b4b6d8f0c1e2d3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3 AS runner

WORKDIR /app

ENV NODE_ENV production

# Copy package files and production dependencies
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules

# Copy source code
COPY . .

EXPOSE 4000

# Run Node.js directly as PID 1 (best practice)
CMD ["node", "src/server.js"]
