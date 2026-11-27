FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS base
WORKDIR /app

FROM base AS manifests
COPY package.json package-lock.json ./
COPY apps/mcp/package.json apps/mcp/

FROM manifests AS build
RUN npm ci --ignore-scripts
COPY apps apps
RUN npm test

FROM manifests AS runtime-deps
RUN npm ci --omit=dev --ignore-scripts --workspace @kanban/mcp

FROM base AS runtime
LABEL org.opencontainers.image.source="https://github.com/reisguilherme/homelab-kanban"
ENV NODE_ENV=production
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/mcp/src ./apps/mcp/src
COPY --from=build /app/apps/mcp/package.json ./apps/mcp/package.json
COPY --from=build /app/package.json ./package.json
USER 1000:1000
EXPOSE 6062
CMD ["node", "apps/mcp/src/main.mjs"]
