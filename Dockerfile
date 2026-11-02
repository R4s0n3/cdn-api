# Coolify builds this image and routes https://cdn.miomideal.com to port 9001.
# DATABASE_URL below is only a placeholder so `prisma generate` can run at build time.
# Coolify injects the real DATABASE_URL when the container starts.

FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma

ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/cdn

RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY templates ./templates

RUN npm run build \
  && npm prune --omit=dev \
  && rm -rf node_modules/typescript node_modules/@types \
  && npm cache clean --force \
  && node -e "const {PrismaClient}=require('@prisma/client'); if (typeof PrismaClient !== 'function') process.exit(1)"

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=9001 \
    SERVER_ROOT=/data

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data/assets /data/storage

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/templates ./templates
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma ./prisma
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && ln -sf "$(command -v tini)" /usr/local/bin/tini \
  && ln -sf "$(command -v curl)" /usr/local/bin/curl

EXPOSE 9001

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl --fail --silent "http://127.0.0.1:${PORT:-9001}/health" || exit 1

ENTRYPOINT ["/usr/local/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
