# Built from the repository root: the server compiles src/ and shared/.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY shared ./shared
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# A fixed uid/gid (1001), so the files the server writes (ticked
# checkboxes, home and favourites, the device registry) have a known
# owner on the host. The vault folder must be writable for this uid or
# group; see the README.
RUN addgroup -g 1001 app && adduser -S app -G app -u 1001
USER app

# VAULT_ROOT is a mounted volume (see docker-compose.yml). AUTH_TOKEN has
# no default on purpose: without it only paired devices get in, and the
# server refuses to start unless the devices file exists (SECRETS_DIR, a
# mounted folder): it never runs open.
ENV PORT=3099
EXPOSE 3099

# The server answers and the vault has entries (GET /health, no token).
# node's own fetch: nothing extra in the image.
HEALTHCHECK --interval=1m --timeout=10s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "dist/src/server.js"]
