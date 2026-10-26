# syntax=docker/dockerfile:1
# Pin the scanned base; Dependabot proposes updates to this digest.
ARG NODE_IMAGE=node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ARG SOURCE_REVISION=local
LABEL org.opencontainers.image.source="https://github.com/luzmo-official/excalidraw-room" \
      org.opencontainers.image.revision=$SOURCE_REVISION
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# Remove bundled package managers from the runtime filesystem.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-v* /root/.npm /root/.cache \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
       /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node public ./public
COPY --chown=node:node LICENSE ./LICENSE
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
