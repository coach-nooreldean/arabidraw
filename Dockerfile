FROM --platform=${BUILDPLATFORM} node:20 AS dependencies

WORKDIR /opt/node_app

COPY . .

# do not ignore optional dependencies:
# Error: Cannot find module @rollup/rollup-linux-x64-gnu
RUN --mount=type=cache,target=/root/.cache/yarn \
    yarn --frozen-lockfile --network-timeout 600000

FROM dependencies AS server-build

RUN yarn build:server

FROM node:20-alpine AS drawings-api

WORKDIR /opt/drawings-api
COPY --from=server-build /opt/node_app/server/dist ./dist
ENV NODE_ENV=production DRAWINGS_DIR=/data/drawings PORT=3001
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "const s = require('node:net').connect(3001, '127.0.0.1', () => { s.end(); }); s.on('error', () => process.exit(1));"
CMD ["node", "dist/index.js"]

FROM dependencies AS build

ARG NODE_ENV=production
RUN yarn build:app:docker

FROM nginx:1.27-alpine AS frontend

COPY --from=build /opt/node_app/excalidraw-app/build /usr/share/nginx/html
COPY server/nginx.conf /etc/nginx/conf.d/default.conf

HEALTHCHECK CMD wget -q -O /dev/null http://localhost || exit 1
