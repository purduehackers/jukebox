# syntax=docker/dockerfile:1
FROM node:26-bookworm-slim AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY app ./app
COPY src ./src
COPY vite.config.ts ./
RUN npm run build:app

FROM node:26-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates ffmpeg python3 python3-venv tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/jukebox
COPY requirements.txt ./
RUN python3 -m venv .venv \
    && .venv/bin/pip install --no-cache-dir -r requirements.txt
COPY --from=frontend /build/dist/app ./dist/app
COPY src ./src
COPY jukebox ./jukebox
COPY package.json ./
COPY scripts/run-production ./scripts/run-production
RUN chmod +x scripts/run-production \
    && mkdir -p /var/lib/jukebox/service /var/lib/jukebox/worker \
    && chown -R node:node /var/lib/jukebox
ENV NODE_ENV=production \
    JUKEBOX_SERVICE_DATA=/var/lib/jukebox/service \
    JUKEBOX_WORKER_DATA=/var/lib/jukebox/worker \
    JUKEBOX_SERVICE_HOST=0.0.0.0 \
    JUKEBOX_SERVICE_PORT=8080 \
    JUKEBOX_WORKER_PORT=8971
USER node
EXPOSE 8080
VOLUME /var/lib/jukebox
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s \
    CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/jukebox/scripts/run-production"]
