# Tsumugi multi-stage Dockerfile (placeholder for Phase 1)
#
# Stages:
#   1. ui-builder    : React admin UI を静的ファイルへビルド
#   2. server-builder: server を tsc + bundle
#   3. runtime       : node:22-alpine 上で起動
#
# 完成後の概要サイズ目安: 200-300MB（@xenova/transformers モデルキャッシュ含めて）

# --- Stage 1: UI build ---
FROM node:22-alpine AS ui-builder
WORKDIR /workspace
RUN corepack enable
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/ui ./apps/ui
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @tsumugi/ui build

# --- Stage 2: Server build ---
FROM node:22-alpine AS server-builder
WORKDIR /workspace
RUN corepack enable
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @tsumugi/server build

# --- Stage 3: Runtime ---
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8000
RUN corepack enable
COPY --from=server-builder /workspace/apps/server/dist ./dist
COPY --from=server-builder /workspace/apps/server/package.json ./package.json
COPY --from=ui-builder /workspace/apps/ui/dist ./public
RUN pnpm install --prod --frozen-lockfile
EXPOSE 8000
CMD ["node", "dist/index.js"]
