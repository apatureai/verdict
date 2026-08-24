# Judgment Engine API + worker image. Runtime secrets are injected by Fly;
# credentials and model/capture endpoints are never baked into an image layer.
FROM node:24-trixie-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json vitest.config.ts ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Materialize only the runtime package's production dependency closure. This
# avoids shipping the root test/build toolchain.
RUN pnpm --filter @apatureai/verdict-runtime deploy --prod /prod/runtime

FROM node:24-trixie-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
# npm/corepack are build-time tools. Removing them keeps their dependency trees
# out of the production attack surface.
RUN apt-get update && apt-get install -y --no-install-recommends liblzma5 \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build /prod/runtime ./
EXPOSE 8080
CMD ["node", "dist/api-main.js"]
