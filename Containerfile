FROM docker.io/oven/bun:1.4.4 AS build
WORKDIR /opt/jukebox
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY astro.config.mjs postcss.config.js tsconfig.json ./
COPY app ./app
COPY src ./src
RUN bun run build

FROM docker.io/oven/bun:1.4.4 AS runtime
COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /usr/local/bin/uv
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates ffmpeg python3 tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/jukebox
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY pyproject.toml uv.lock ./
ENV UV_PYTHON_DOWNLOADS=never UV_NO_CACHE=1
RUN uv sync --locked --no-dev --python /usr/bin/python3
COPY --from=build /opt/jukebox/dist ./dist
COPY src ./src
COPY jukebox ./jukebox
COPY scripts/run-production scripts/start-web.ts scripts/launch.ts ./scripts/
RUN chmod +x scripts/run-production \
    && mkdir -p /var/lib/jukebox/service /var/lib/jukebox/worker \
    && chown -R bun:bun /var/lib/jukebox
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 \
    JUKEBOX_SERVICE_DATA=/var/lib/jukebox/service \
    JUKEBOX_WORKER_DATA=/var/lib/jukebox/worker \
    JUKEBOX_WORKER_PORT=8971
USER bun
EXPOSE 8080
VOLUME /var/lib/jukebox
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s \
    CMD bun --no-env-file -e "fetch('http://127.0.0.1:'+process.env.PORT+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/jukebox/scripts/run-production"]
