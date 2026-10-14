# syntax=docker/dockerfile:1.7
# Ảnh của MIHATO Điều hành (SPEC 12.2). Gói nội bộ xuất thẳng TypeScript nên chạy bằng tsx, không có bước build riêng.
#
# Đích dựng (docker build --target <tên>):
#   runtime  api, worker, scribe và các script (migrate, bootstrap) trong MỘT ảnh; chọn tiến trình bằng `command`.
#            Chỉ phụ thuộc production, chạy bằng người dùng `node` (không root), tini làm PID 1, có HEALTHCHECK.
#   web      Caddy + bản dựng tĩnh của web quản trị + deploy/Caddyfile (TLS tự động, điểm vào duy nhất của hệ thống).
#   dev      đủ phụ thuộc để chạy `vite dev` (chỉ docker-compose.yml local; KHÔNG dùng ở máy chủ).
#
# Tái lập: pnpm install --frozen-lockfile (lockfile là nguồn duy nhất), base ghim digest. Dependabot cập nhật digest
# (.github/dependabot.yml); khi đổi, đổi cả hai chỗ ARG dưới đây.
ARG NODE_IMAGE=node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ARG CADDY_IMAGE=caddy:2-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f

FROM ${NODE_IMAGE} AS base
RUN corepack enable
WORKDIR /repo
ENV CI=1 npm_config_store_dir=/pnpm-store

# Mọi tệp package.json của workspace có trong pnpm-lock.yaml (kể cả hai app Expo và tools): thiếu một workspace là
# pnpm đòi cập nhật lockfile. Lớp này chỉ đổi khi phụ thuộc đổi, nên cài đặt được cache.
FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/scribe/package.json apps/scribe/
COPY apps/web-admin/package.json apps/web-admin/
COPY apps/mobile-staff/package.json apps/mobile-staff/
COPY apps/mobile-executive/package.json apps/mobile-executive/
COPY packages/ai-tools/package.json packages/ai-tools/
COPY packages/api-client/package.json packages/api-client/
COPY packages/backend/package.json packages/backend/
COPY packages/config/package.json packages/config/
COPY packages/domain/package.json packages/domain/
COPY packages/i18n/package.json packages/i18n/
COPY packages/providers/package.json packages/providers/
COPY packages/ui-tokens/package.json packages/ui-tokens/
COPY packages/workflow-engine/package.json packages/workflow-engine/
COPY tools/stt-bench/package.json tools/stt-bench/

# Phụ thuộc production của bốn gói chạy trên máy chủ (không devDependencies: không typescript, eslint, vitest, drizzle-kit, Playwright).
FROM manifests AS deps-prod
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --prod \
      --filter "@mihato/api..." --filter "@mihato/worker..." --filter "@mihato/scribe..." --filter "@mihato/backend..."

# Phụ thuộc đầy đủ cho web quản trị (dựng và dev).
FROM manifests AS deps-web
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --filter "@mihato/web-admin..."

FROM deps-web AS dev
COPY packages ./packages
COPY apps/web-admin ./apps/web-admin
CMD ["pnpm", "--filter", "@mihato/web-admin", "dev", "--host", "0.0.0.0"]

FROM dev AS web-build
# Bản phát hành không mang sourcemap (lộ mã nguồn, nặng thêm).
RUN pnpm --filter @mihato/web-admin build && find apps/web-admin/dist -name '*.map' -delete

FROM ${CADDY_IMAGE} AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /repo/apps/web-admin/dist /srv
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:2019/config/ || exit 1

FROM ${NODE_IMAGE} AS runtime
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="mihato-dieuhanh" org.opencontainers.image.revision="${GIT_SHA}"
RUN apk add --no-cache tini
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=deps-prod /repo ./
# Mã nguồn thuộc root, chỉ đọc với người dùng chạy; tsconfig của gói cần @mihato/config (devDependency, không cài ở đây).
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY apps/scribe ./apps/scribe
COPY db/migrations ./db/migrations
COPY db/seed/templates ./db/seed/templates
COPY deploy/ops ./deploy/ops
RUN mkdir -p node_modules/@mihato && ln -sfn ../../packages/config node_modules/@mihato/config \
 && mkdir -p /data/files && chown node:node /data/files
USER node
ENV PORT=3100
EXPOSE 3100 3200
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]
# Mặc định kiểm api; compose đặt lại healthcheck cho worker và scribe, và tắt cho migrate.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
