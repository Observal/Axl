# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

FROM node:24.13.1-bookworm-slim@sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2 AS build
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/tsconfig.json packages/protocol/tsconfig.build.json ./packages/protocol/
COPY services/control-plane/package.json services/control-plane/tsconfig.json services/control-plane/tsconfig.build.json ./services/control-plane/
RUN pnpm install --frozen-lockfile
COPY packages/protocol/src ./packages/protocol/src
COPY services/control-plane/src ./services/control-plane/src
RUN pnpm --filter @axl/protocol build && pnpm --filter @axl/control-plane build

FROM node:24.13.1-bookworm-slim@sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2 AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /workspace
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/protocol ./packages/protocol
COPY --from=build /workspace/services/control-plane ./services/control-plane
USER node
EXPOSE 8080
CMD ["node", "services/control-plane/dist/deployment-test-runtime.js"]
