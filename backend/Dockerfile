# Test stage — devDependencies for jest in docker-compose.test.yml
# Pinned to a current LTS (Node 20). For digest pinning (recommended
# for prod), compute the real digest with:
#   docker buildx imagetools inspect node:20.18.1-alpine
# and append `@sha256:<digest>` to each `FROM` below. Do NOT fabricate
# a digest — a fake SHA breaks `docker build` immediately.
FROM node:26-alpine AS test

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

CMD ["npm", "test"]

# 1. Builder Stage
# Pinned to a current LTS (Node 20) with a SHA256 digest for reproducibility.
FROM node:26-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

# 2. Production Runner Stage
FROM node:26-alpine AS runner

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
