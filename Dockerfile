# ---------- Stage 1: build native deps ----------
FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev


# ---------- Stage 2: minimal runtime ----------
FROM node:22-alpine

LABEL org.opencontainers.image.title="PullMD"
LABEL org.opencontainers.image.description="Self-hosted URL-to-Markdown service with stable, refreshable share links."
LABEL org.opencontainers.image.source="https://github.com/AeternaLabsHQ/pullmd"
LABEL org.opencontainers.image.url="https://github.com/AeternaLabsHQ/pullmd"
LABEL org.opencontainers.image.documentation="https://github.com/AeternaLabsHQ/pullmd#readme"
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"
LABEL org.opencontainers.image.vendor="Aeterna Labs"

RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY . .

RUN apk add --no-cache su-exec

RUN mkdir -p /data && chown -R app:app /app /data

# The entrypoint script runs as root, fixes permissions on bind-mounted
# volumes that the Docker daemon may have created as root, then drops to
# the unprivileged app user via su-exec.
EXPOSE 3000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
