#!/usr/bin/env bash
# Triển khai một phiên bản lên máy chủ production KHÔNG GIÁN ĐOẠN: kiểm cấu hình, sao lưu, kéo ảnh, migrate MỘT lần, rồi cuốn chiếu
# từng dịch vụ (chạy bản mới song song bản cũ, chờ khoẻ, mới tắt bản cũ), kiểm /readyz; hỏng thì tự hoàn lại bản trước.
#   deploy/scripts/deploy.sh <tag>            ví dụ v1.0.3 hoặc sha-abcdef0
#   SKIP_BACKUP=1 deploy/scripts/deploy.sh <tag>   bỏ bước sao lưu trước migrate (chỉ lần đầu hoặc diễn tập)
# CI gọi script này qua deploy/scripts/remote-deploy.sh (docs/ops/auto-deploy.md); gõ tay vẫn chạy như cũ.
# Không đụng tới ứng dụng khác trên máy chủ: chỉ dự án compose `mihato`, không prune ảnh, không khởi động lại Docker hay proxy chung.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TAG_ARG="${1:-}"
[ -n "$TAG_ARG" ] || die "thiếu tag. Dùng: deploy.sh <tag>"
export TAG="$TAG_ARG"
START=$(date +%s)
# shellcheck disable=SC2154  # rc được gán bên trong chuỗi trap (nháy đơn) và chỉ chạy lúc thoát
trap 'rc=$?; [ "$rc" -eq 0 ] || log "Triển khai $TAG KHÔNG xong (mã $rc). Bản trước: ${PREV_TAG:-không có}. Hoàn lại tay: deploy/scripts/rollback.sh ${PREV_TAG:-<tag-trước>}; xem docs/ops/runbook.md" >&2' EXIT

need_cmd docker
check_env_file

acquire_deploy_lock

PREV_TAG="$(cat "$STATE_DIR/current-tag" 2>/dev/null || true)"
log "Triển khai $TAG (compose: $COMPOSE_FILE $(envval MIHATO_COMPOSE_EXTRA))"

dc config -q || die "tệp compose hoặc tệp môi trường sai"
assert_free_memory

log "Kéo ảnh"
dc pull --quiet api web
dc pull --quiet --ignore-buildable postgres 2>/dev/null || true

log "Kiểm cấu hình đầy đủ (check-env)"
# Không bao giờ tạo lại postgres trong lúc triển khai (cho dù cấu hình của nó có đổi): CSDL chỉ được khởi động lại có chủ ý, ngoài giờ làm việc.
dc up -d --no-recreate postgres
wait_for 120 "postgres sẵn sàng" dc exec -T postgres pg_isready -U postgres
dc --profile tools run --rm check-env || die "cấu hình production chưa hợp lệ; sửa $ENV_FILE rồi chạy lại"

if [ -z "${SKIP_BACKUP:-}" ] && [ -n "$PREV_TAG" ]; then
  log "Sao lưu CSDL trước khi migrate"
  "$DEPLOY_DIR/scripts/backup.sh" --db-only || die "sao lưu thất bại: không migrate (SKIP_BACKUP=1 nếu chắc chắn)"
elif [ -n "${SKIP_BACKUP:-}" ]; then
  log "CẢNH BÁO: bỏ sao lưu trước migrate (SKIP_BACKUP)"
else
  log "Lần triển khai đầu: chưa có dữ liệu để sao lưu"
fi

# Migration chạy khi bản cũ VẪN đang phục vụ. Có giới hạn chờ khoá (PGOPTIONS ở compose): migration không lấy được khoá trong ít giây thì
# thất bại ngay, không xếp hàng chặn người dùng. Thất bại ở đây = chưa đổi dịch vụ nào.
log "Migrate một lần"
dc run --rm migrate || die "migrate thất bại; bản đang chạy giữ nguyên ($PREV_TAG). Xem docs/ops/runbook.md, mục Nâng cấp"

# Hoàn lại bản trước bằng chính cách cuốn chiếu (không gián đoạn). Dịch vụ chưa đổi thì được bỏ qua.
auto_rollback() {
  if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "$TAG" ]; then
    log "Tự hoàn lại $PREV_TAG"
    export TAG="$PREV_TAG"
    rollout_all || log "CẢNH BÁO: hoàn lại chưa trọn; kiểm: docker compose ps (xem docs/ops/runbook.md)" >&2
  else
    log "Không có bản trước để hoàn lại; các dịch vụ chưa đổi vẫn chạy bản cũ."
  fi
}

log "Cuốn chiếu các dịch vụ (không gián đoạn)"
if ! rollout_all; then
  log "LỖI: bản mới không khoẻ; bản cũ vẫn phục vụ ở dịch vụ chưa đổi."
  auto_rollback
  exit 1
fi

# /readyz cần worker ghi nhịp tim (30 giây) nên chờ lâu hơn. Không dùng wait_for vì nó thoát cả script khi hết hạn: ở đây phải tự hoàn lại.
READY=0
for _ in $(seq 1 40); do
  if readyz_internal >/dev/null 2>&1; then READY=1; break; fi
  sleep 3
done
if [ "$READY" != 1 ]; then
  log "LỖI: /readyz không đạt sau khi đổi bản."
  auto_rollback
  exit 1
fi
log "đạt: /readyz (CSDL và nhịp tim worker)"

echo "$PREV_TAG" > "$STATE_DIR/previous-tag"
echo "$TAG" > "$STATE_DIR/current-tag"
log "Xong sau $(( $(date +%s) - START )) giây. Bản trước: ${PREV_TAG:-không có}. Kiểm ngoài: curl -fsS https://$(envval DOMAIN)/readyz"
dc ps
