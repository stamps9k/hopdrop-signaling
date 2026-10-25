# --- Build stage -----------------------------------------------------
# Has TypeScript, tsx, and every devDependency. Discarded after this
# stage - none of it becomes part of the shipped image.
FROM node:22-slim AS builder
WORKDIR /app

# Copied separately from the rest of the source so `npm ci` is cached
# across rebuilds whenever only source files change, not package.json.
COPY package.json package-lock.json ./
# --ignore-scripts skips "prepare": "husky" - this stage has no use for
# git-hook setup, and there's no .git in the build context anyway.
RUN npm ci --ignore-scripts

# The build only needs config/ (tsconfig.build.json and the base it
# extends) and src/. The root tsconfig.json just points VS Code at
# config/tsconfig.dev.json, so it isn't copied.
COPY config ./config
COPY src ./src

# "build": "tsc -p config/tsconfig.build.json" - emits to dist/
RUN npm run build

# --- Runtime stage -----------------------------------------------------
# Only what's needed to actually run the compiled output: no compiler,
# no devDependencies, no source .mts files.
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# ws's native accelerators (bufferutil, utf-8-validate) are optional
# peer dependencies, which npm doesn't install unless asked, and ws
# falls back to its pure-JS implementation without them. --omit=optional
# is belt-and-braces against anything optional needing a native compile
# step in this slim image. --ignore-scripts skips husky's prepare.
RUN npm ci --omit=dev --omit=optional --ignore-scripts

COPY --from=builder /app/dist ./dist

# Run as the unprivileged "node" user that ships with the official
# image, rather than root. The app only reads its own files and binds
# a port above 1024, so it needs no extra permissions.
USER node

# Matches the PORT default in index.mts. EXPOSE is documentation only -
# it doesn't publish the port itself; actual mapping happens via
# docker-compose's `ports:` or `docker run -p`.
EXPOSE 7420

CMD ["node", "dist/index.mjs"]

