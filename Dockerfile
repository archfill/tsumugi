# Tsumugi multi-stage Dockerfile
#
# Stages:
#   1. builder : pnpm workspace 全体を install + UI / server を build
#   2. runtime : 必要な node_modules + dist + 静的 UI のみコピー
#
# Image 完成後のサイズ目安: 600-800MB（@xenova/transformers + onnxruntime-node 含む）

# onnxruntime-node の native binding は glibc 前提のため Debian ベース
ARG NODE_VERSION=22-bookworm-slim
ARG PNPM_VERSION=11.6.0

# --- Stage 1: builder ---
FROM node:${NODE_VERSION} AS builder
ARG PNPM_VERSION
WORKDIR /workspace

# corepack で pnpm 固定（pnpm install を走らせる前に PATH に通す）
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# 依存解決に必要な metadata を一式コピー（layer cache 効かせる）
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/ui/package.json ./apps/ui/

# 全 workspace の依存をインストール
# native build 許可は pnpm-workspace.yaml の allowBuilds が効く
RUN pnpm install --frozen-lockfile

# ソース一式コピー
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
COPY apps/ui ./apps/ui

# 全 workspace を build
RUN pnpm -r build

# --- Stage 2: runtime ---
FROM node:${NODE_VERSION} AS runtime
ARG PNPM_VERSION
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8000

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# server の deploy（prod 依存のみ抽出）
COPY --from=builder /workspace/pnpm-workspace.yaml /workspace/pnpm-lock.yaml /workspace/package.json /workspace/tsconfig.base.json ./
COPY --from=builder /workspace/packages/shared ./packages/shared
COPY --from=builder /workspace/apps/server ./apps/server
COPY --from=builder /workspace/apps/ui/dist ./apps/ui/dist

# server の prod 依存だけインストール
RUN pnpm install --frozen-lockfile --filter @tsumugi/server... --prod

EXPOSE 8000

# HF キャッシュは volume にマウント想定
ENV HF_CACHE=/app/.cache/huggingface

# HTTP モードで起動（stdio が必要なら CMD override）
CMD ["node", "apps/server/dist/index.js", "--http"]
