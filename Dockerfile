# Container image for the CNC Cloud Run service.
#
# Nothing environment-specific is baked in. Every CNC_ value arrives at runtime,
# from Secret Manager or the deploy's --set-env-vars, mounted by the Cloud Run
# deploy step, so the same image is safe to keep, promote and roll back to.

# ---------------------------------------------------------------------------
# Stage 1: builder
# ---------------------------------------------------------------------------
# Keep this major in step with `engines.node` in package.json and with the
# Vercel projects' Node version on the frontends. CI reads the engines field,
# so a bump here that is not mirrored there gives you a green build on one
# runtime and a container running another.
FROM node:22-slim AS builder

# Prisma's tooling dlopens libssl at load time. The slim base does not
# guarantee it, and the failure mode is a runtime error about an undetectable
# OpenSSL version rather than a build failure.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copied before the sources so this layer is reused whenever only src/ changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# MUST run before the build. The Prisma service imports the client from
# ./generated/cnc-client, so without this step there is nothing for tsc to
# resolve and `nest build` fails. It also has to happen inside the image rather
# than being copied in: `generated/` is gitignored and `.dockerignore`d, so a
# developer's copy never reaches the build context; the client that ships is
# the one this line produces from the schema in this commit. (Since Prisma 7
# the client carries a WebAssembly query compiler rather than a native engine,
# so platform mismatch is no longer the reason; reproducibility is.)
#
# Reads `prisma.config.ts` at the repository root, which `COPY . .` above has
# already placed. It needs no database URL to generate.
RUN npx prisma generate

RUN npm run build

# Re-resolve the tree with devDependencies pruned. Done here rather than in the
# runtime stage so that stage installs nothing and stays a pure copy, and so
# no build toolchain, registry credential or npm cache can reach the final
# image.
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Marks the environment as production for the app itself, not just for npm.
# The Swagger setup reads it: the /api/docs UI stays mounted, and the
# openapi-cnc.json export is skipped, which matters because a container
# filesystem is ephemeral and not reliably writable. It also drives the refresh
# cookie's Secure attribute; which deployment this is comes from CNC_ENV, not
# from here.
ENV NODE_ENV=production

WORKDIR /app

# `node` (uid 1000) ships with the base image. Owned by that user so the app
# can read its own files without ever running as root.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/generated ./generated
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/package.json ./package.json

USER node

# Documentation only. Cloud Run injects PORT and the app binds to whatever it
# is given, falling back to 3000 locally.
EXPOSE 8080

# Migrations are never applied from here. `prisma migrate deploy` is run
# deliberately against staging, never as a side effect of a container starting:
# Cloud Run may start several instances at once, and a deploy that migrates on
# boot races itself and gives no one a chance to read the plan first.
CMD ["node", "dist/main"]
