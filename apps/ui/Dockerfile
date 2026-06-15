# tsumugi UI multi-stage Dockerfile
#
# Stages:
#   1. builder : pnpm workspace の UI + shared を install + build
#   2. runtime : nginx で dist/ を配信、/api と /mcp は tsumugi-server に proxy

ARG NODE_VERSION=22-bookworm-slim
ARG PNPM_VERSION=11.6.0
ARG NGINX_VERSION=1.27-alpine

# --- Stage 1: builder ---
FROM node:${NODE_VERSION} AS builder
ARG PNPM_VERSION
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# 依存解決メタデータ
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/ui/package.json ./apps/ui/

# UI + shared のみ install (server を巻き込まない)
RUN pnpm install --frozen-lockfile --filter @tsumugi/ui...

COPY packages/shared ./packages/shared
COPY apps/ui ./apps/ui

RUN pnpm --filter @tsumugi/ui... -r build

# --- Stage 2: runtime ---
FROM nginx:${NGINX_VERSION} AS runtime
COPY --from=builder /workspace/apps/ui/dist /usr/share/nginx/html
COPY apps/ui/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

# nginx の default CMD で起動
