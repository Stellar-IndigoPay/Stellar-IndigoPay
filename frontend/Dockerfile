# 1. Builder Stage
# Pinned to a current LTS (Node 20). Replace with
#   node:20.18.1-alpine@sha256:<digest>
# once you have computed the digest via:
#   docker buildx imagetools inspect node:20.18.1-alpine
# Pinning to a digest prevents a compromised upstream from silently
# shipping a new image under the same tag.
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --legacy-peer-deps

COPY . .
RUN npm run build

# 2. Production Runner Stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV production

# Copy package files and install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built assets and configuration from builder
COPY --from=builder /app/next.config.mjs ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public

EXPOSE 3000

CMD ["npm", "run", "start"]
