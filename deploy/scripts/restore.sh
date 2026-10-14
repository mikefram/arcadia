#!/usr/bin/env bash
# Khôi phục từ bản sao lưu của backup.sh (SPEC 12.5, 12.7 điều 3). Hai chế độ:
#   DIỄN TẬP (mặc định, an toàn): khôi phục CSDL vào một CSDL phụ `<APP_DB>_restore`, giải nén tệp ra thư mục tạm trên máy chủ,
#     in số liệu để đối chiếu. Không đụng CSDL và kho tệp đang chạy. Chạy mỗi quý, ghi biên bản (docs/ops/runbook.md).
#   THẬT (--replace-live): thay CSDL đang dùng và kho tệp bằng bản sao lưu. Phải dừng api, worker, scribe trước. Dùng khi máy sạch
#     hoặc dữ liệu hỏng; trên máy sạch: dựng postgres (deploy.sh bước đầu) rồi chạy lệnh này.
#
#   deploy/scripts/restore.sh --db mihato-db-<mốc>.dump.age [--files mihato-files-<mốc>.tar.gz.age] [--age-identity khoá-riêng.txt]
#                             [--replace-live --yes]
#   .gpg dùng khoá gpg của người chạy; tệp không mã hoá (.dump, .tar.gz) dùng được ngay.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DB_FILE=""; FILES_FILE=""; IDENTITY=""; LIVE=false; YES=false
while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB_FILE="$2"; shift 2 ;;
    --files) FILES_FILE="$2"; shift 2 ;;
    --age-identity) IDENTITY="$2"; shift 2 ;;
    --replace-live) LIVE=true; shift ;;
    --yes) YES=true; shift ;;
    *) die "tham số lạ: $1" ;;
  esac
done
[ -n "$DB_FILE" ] && [ -r "$DB_FILE" ] || die "thiếu hoặc không đọc được --db"
need_cmd docker
[ -r "$ENV_FILE" ] || die "không đọc được $ENV_FILE"
export TAG="${TAG:-$(cat "$STATE_DIR/current-tag" 2>/dev/null || echo unknown)}"
APP_DB="$(envval APP_DB)"; APP_DB="${APP_DB:-mihato}"

umask 077
WORK="$(mktemp -d "${TMPDIR:-/var/tmp}/mihato-restore-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
START=$(date +%s)

decrypt() { # $1 vào, $2 ra
  case "$1" in
    *.age) need_cmd age; [ -n "$IDENTITY" ] || die "tệp .age cần --age-identity <khoá riêng>"; age -d -i "$IDENTITY" -o "$2" "$1" ;;
    *.gpg) need_cmd gpg; gpg --batch --yes -o "$2" -d "$1" ;;
    *) cp "$1" "$2" ;;
  esac
}

# Kiểm tổng băm nếu có SHA256SUMS cùng mốc.
verify_sum() {
  local dir base sums
  dir="$(cd "$(dirname "$1")" && pwd)"; base="$(basename "$1")"
  for sums in "$dir"/SHA256SUMS-*; do
    [ -r "$sums" ] || continue
    if grep -q " $base\$" "$sums"; then (cd "$dir" && grep " $base\$" "$sums" | sha256sum -c -) || die "tổng băm $base không khớp"; return; fi
  done
  log "CẢNH BÁO: không có SHA256SUMS cho $base"
}

verify_sum "$DB_FILE"
decrypt "$DB_FILE" "$WORK/db.dump"
log "Đã giải mã CSDL ($(wc -c < "$WORK/db.dump") byte)"

dc up -d postgres >/dev/null
wait_for 120 "postgres sẵn sàng" dc exec -T postgres pg_isready -U postgres

if [ "$LIVE" = "true" ]; then
  [ "$YES" = "true" ] || die "khôi phục THẬT sẽ XOÁ CSDL '$APP_DB' hiện tại. Thêm --yes nếu chắc chắn"
  RUNNING="$(dc ps --status running --services 2>/dev/null | grep -E '^(api|worker|scribe)$' || true)"
  [ -z "$RUNNING" ] || die "dừng trước: docker compose ... stop api worker scribe web ops-alert (đang chạy: $(echo "$RUNNING" | tr '\n' ' '))"
  TARGET="$APP_DB"
  log "Xoá và dựng lại CSDL $TARGET"
  dc exec -T postgres dropdb -U postgres --if-exists --force "$TARGET"
else
  TARGET="${APP_DB}_restore"
  log "Diễn tập: khôi phục vào CSDL phụ $TARGET (CSDL đang chạy không bị đụng)"
  dc exec -T postgres dropdb -U postgres --if-exists --force "$TARGET"
fi
dc exec -T postgres createdb -U postgres -O app_owner "$TARGET" || die "không tạo được CSDL $TARGET (vai trò app_owner đã có chưa? chạy deploy.sh bước đầu để init-roles.sh chạy)"
dc exec -T postgres pg_restore -U postgres -d "$TARGET" --exit-on-error --single-transaction < "$WORK/db.dump" || die "pg_restore thất bại"
log "CSDL đã khôi phục. Đối chiếu:"
for t in organizations users process_runs step_runs files effects audit_log; do
  printf '  %-16s %s\n' "$t" "$(dc exec -T postgres psql -U postgres -d "$TARGET" -tAc "select count(*) from $t" | tr -d '\r')"
done
printf '  %-16s %s\n' "migrations" "$(dc exec -T postgres psql -U postgres -d "$TARGET" -tAc 'select count(*) from drizzle.__drizzle_migrations' | tr -d '\r')"
printf '  %-16s %s\n' "mốc mới nhất" "$(dc exec -T postgres psql -U postgres -d "$TARGET" -tAc 'select max(at) from audit_log' | tr -d '\r')"

if [ -n "$FILES_FILE" ]; then
  [ -r "$FILES_FILE" ] || die "không đọc được --files"
  verify_sum "$FILES_FILE"
  decrypt "$FILES_FILE" "$WORK/files.tar.gz"
  gzip -t "$WORK/files.tar.gz" || die "tệp nén kho tệp hỏng"
  if [ "$LIVE" = "true" ]; then
    log "Giải nén kho tệp vào volume mihato_files"
    dc run --rm --no-deps -T --entrypoint tar api -C /data/files -xzf - < "$WORK/files.tar.gz"
  else
    OUT="$STATE_DIR/restore-drill-files"
    rm -rf "$OUT"; mkdir -p "$OUT"
    tar -C "$OUT" -xzf "$WORK/files.tar.gz"
    log "Kho tệp giải ra $OUT: $(find "$OUT" -type f | wc -l) tệp (đối chiếu với dòng files ở trên; có thể dư tệp mồ côi, không được thiếu)"
  fi
fi

log "Xong sau $(( $(date +%s) - START )) giây."
if [ "$LIVE" = "true" ]; then
  log "Bước tiếp: deploy/scripts/deploy.sh <tag> để chạy migrate (nếu bản sao lưu cũ hơn) và khởi động lại dịch vụ."
else
  log "Dọn CSDL diễn tập khi xong: docker compose ... exec postgres dropdb -U postgres ${TARGET}"
fi
