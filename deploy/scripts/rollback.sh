#!/usr/bin/env bash
# Hoàn lại bản ứng dụng trước, không gián đoạn: chỉ đổi ảnh api, worker, scribe, web theo cách cuốn chiếu (KHÔNG chạy lại migrate, KHÔNG đụng CSDL).
# An toàn nhờ quy tắc mở rộng rồi thu hẹp (SPEC 12.3): bản api cũ chạy được trên CSDL đã migrate. Nếu bản vừa triển khai
# có migration THU HẸP (bỏ cột, bỏ bảng) hoặc migration làm hỏng dữ liệu thì không hoàn lại bằng script này mà khôi phục
# sao lưu (docs/ops/runbook.md, mục Hoàn lại).
#   deploy/scripts/rollback.sh [tag]   không đưa tag thì dùng bản ngay trước (ghi ở previous-tag)
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

need_cmd docker
check_env_file
acquire_deploy_lock
CURRENT="$(cat "$STATE_DIR/current-tag" 2>/dev/null || true)"
TARGET="${1:-$(cat "$STATE_DIR/previous-tag" 2>/dev/null || true)}"
[ -n "$TARGET" ] || die "không biết hoàn lại về bản nào. Dùng: rollback.sh <tag>"
[ "$TARGET" != "$CURRENT" ] || die "bản $TARGET đang chạy rồi"
export TAG="$TARGET"
START=$(date +%s)

log "Hoàn lại $CURRENT -> $TARGET"
dc pull --quiet api web
assert_free_memory
# Cuốn chiếu như deploy.sh: bản cũ chạy song song với bản đang chạy, chờ khoẻ rồi mới tắt bản đang chạy. Không gián đoạn.
rollout_all || die "bản $TARGET không khoẻ; các dịch vụ chưa đổi vẫn chạy $CURRENT. Xem docs/ops/runbook.md, mục Sự cố"

wait_for 180 "/readyz (CSDL và nhịp tim worker)" readyz_internal || die "readyz không đạt sau khi hoàn lại; xem docs/ops/runbook.md, mục Sự cố"

echo "$CURRENT" > "$STATE_DIR/previous-tag"
echo "$TARGET" > "$STATE_DIR/current-tag"
log "Xong sau $(( $(date +%s) - START )) giây. Đang chạy $TARGET."
dc ps
