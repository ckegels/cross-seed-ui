# cross-seed-ui: one image, two roles ("hub" = web UI, "agent" = next to cross-seed).
#   docker run ghcr.io/ckegels/cross-seed-ui hub
#   docker run ghcr.io/ckegels/cross-seed-ui agent
# See docs/docker.md and docker-compose.yml.

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/agent/package.json packages/agent/
COPY packages/hub/package.json packages/hub/
COPY packages/web/package.json packages/web/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY scripts scripts
COPY deploy deploy
ARG VERSION=dev
RUN CSUI_VERSION="$VERSION" node scripts/build.mjs

FROM node:22-alpine
ARG VERSION=dev
LABEL org.opencontainers.image.title="cross-seed-ui" \
      org.opencontainers.image.description="Web UI to manage, monitor and get statistics for cross-seed v6" \
      org.opencontainers.image.source="https://github.com/ckegels/cross-seed-ui" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="$VERSION"
WORKDIR /app
COPY --from=build /src/dist/agent.mjs /src/dist/hub.mjs /src/dist/VERSION ./
COPY --from=build /src/dist/web ./web
COPY docker/entrypoint.sh /usr/local/bin/cross-seed-ui
ENV NODE_ENV=production \
    CSUI_STATE_DIR=/state \
    CSUI_WEB_DIR=/app/web \
    CSUI_CROSS_SEED_DIR=/config
RUN mkdir -p /state && chown node:node /state && chmod 755 /usr/local/bin/cross-seed-ui
# the official cross-seed image is usually run as 1000:1000, which is "node" here
USER node
VOLUME /state
EXPOSE 2469 2470
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD cross-seed-ui healthcheck
ENTRYPOINT ["cross-seed-ui"]
CMD ["hub"]
