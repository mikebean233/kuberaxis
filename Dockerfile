# syntax=docker/dockerfile:1
# Builds the images the Helm chart deploys, from the repo root:
#
#   docker build --target api -t kuberaxis-api .
#   docker build --target web -t kuberaxis-web .

ARG NODE_VERSION=22

# All dependencies, for building. Manifests are copied first so the install layer is cached until they change.
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/parser/package.json packages/parser/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm install --no-audit --no-fund

FROM deps AS build
COPY packages packages
COPY apps apps
RUN npm run build -w @kuberaxis/api && npm run build -w @kuberaxis/web

# The API's runtime dependencies only. The parser is bundled into the API, so its workspace link is dropped.
FROM node:${NODE_VERSION}-bookworm-slim AS api-deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/parser/package.json packages/parser/
COPY apps/api/package.json apps/api/
RUN npm install --omit=dev --workspace @kuberaxis/api --no-audit --no-fund && rm -rf node_modules/@kuberaxis

FROM node:${NODE_VERSION}-bookworm-slim AS api
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
WORKDIR /app
COPY --from=api-deps /app/node_modules node_modules
COPY --from=build /app/apps/api/dist dist
# Resolved relative to dist/index.js, as in the source tree.
COPY apps/api/migrations migrations
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]

FROM nginxinc/nginx-unprivileged:1.27-alpine AS web
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
