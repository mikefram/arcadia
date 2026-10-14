#!/usr/bin/env bash
# Sao lưu production (SPEC 12.5): pg_dump định dạng custom + thư mục tệp đính kèm cùng một mốc giờ, mã hoá bằng age hoặc gpg,
# giữ BACKUP_KEEP_DAYS ngày, đẩy sang nơi khác máy chủ, ghi tệp trạng thái cho ops-alert.
#   deploy/scripts/backup.sh             đầy đủ: CSDL + tệp (chạy hằng ngày, deploy/systemd/mihato-backup.timer)
#   deploy/scripts/backup.sh --db-only   chỉ CSDL (trước migrate; có thể chạy dày hơn, vd mỗi giờ, để RPO nhỏ hơn)
#
# Cấu hình (biến môi trường hoặc trong /etc/mihato/production.env):
#   BACKUP_DIR              thư mục chứa bản sao lưu trên máy chủ (mặc định /var/backups/mihato)
#   BACKUP_KEEP_DAYS        số ngày giữ (mặc định 14)
#   AGE_RECIPIENT           khoá CÔNG KHAI age (age1...) hoặc AGE_RECIPIENTS_FILE; HOẶC GPG_RECIPIENT. Không có thì từ chối,
#                           trừ khi BACKUP_ALLOW_PLAINTEXT=true (chỉ diễn tập). KHOÁ RIÊNG KHÔNG ĐỂ TRÊN MÁY CHỦ NÀY.
#   BACKUP_RCLONE_REMOTE    vd s3remote:mihato-backup/vrg (rclone đã cấu hình), HOẶC
#   BACKUP_RSYNC_TARGET     vd backup@host:/srv/mihato-backup/vrg (qua ssh, khoá riêng của người chạy)
#   BACKUP_REQUIRE_OFFSITE  true (mặc định): thiếu nơi đặt bản sao khác máy chủ thì trạng thái là THẤT BẠI (cảnh báo) dù đã có bản cục bộ
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

cfg() { local v="${!1:-}"; [ -n "$v" ] || v="$(envval "$1")"; printf '%s' "${v:-${2:-}}"; }

MODE=full
[ "${1:-}" = "--db-only" ] && MODE=db
need_cmd docker
[ -r "$ENV_FILE" ] || die "không đọc được $ENV_FILE"

BACKUP_DIR="$(cfg BACKUP_DIR /var/backups/mihato)"
KEEP_DAYS="$(cfg BACKUP_KEEP_DAYS 14)"
APP_DB="$(cfg APP_DB mihato)"
AGE_RECIPIENT="$(cfg AGE_RECIPIENT)"
AGE_RECIPIENTS_FILE="$(cfg AGE_RECIPIENTS_FILE)"
GPG_RECIPIENT="$(cfg GPG_RECIPIENT)"
ALLOW_PLAIN="$(cfg BACKUP_ALLOW_PLAINTEXT false)"
RCLONE_REMOTE="$(cfg BACKUP_RCLONE_REMOTE)"
RSYNC_TARGET="$(cfg BACKUP_RSYNC_TARGET)"
REQUIRE_OFFSITE="$(cfg BACKUP_REQUIRE_OFFSITE true)"
export TAG="${TAG:-$(cat "$STATE_DIR/current-tag" 2>/dev/null || echo unknown)}"

umask 077
mkdir -p "$BACKUP_DIR"
exec 9>"$BACKUP_DIR/.lock"
flock -n 9 || die "một lần sao lưu khác đang chạy"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
WORK="$(mktemp -d "$BACKUP_DIR/.work-XXXXXX")"
DB_OUT=""; FILES_OUT=""; ENCRYPTED=false; OFFSITE=false; ERROR=""

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n'; }

write_status() { # $1 = true|false
  local ok="$1" tmp="$BACKUP_DIR/status.json.tmp"
  printf '{"ok":%s,"mode":"%s","stamp":"%s","startedAt":"%s","finishedAt":"%s","dbFile":"%s","filesFile":"%s","encrypted":%s,"offsite":%s,"error":"%s"}\n' \
    "$ok" "$MODE" "$STAMP" "$STARTED" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "${DB_OUT:-}")" "$(basename "${FILES_OUT:-}")" "$ENCRYPTED" "$OFFSITE" "$(json_escape "$ERROR")" > "$tmp"
  mv "$tmp" "$BACKUP_DIR/status.json"
}

cleanup() {
  local rc=$?
  rm -rf "$WORK"
  if [ "$rc" -ne 0 ]; then
    [ -n "$ERROR" ] || ERROR="lỗi không rõ (mã $rc)"
    write_status false
    log "SAO LƯU THẤT BẠI: $ERROR" >&2
  fi
}
trap cleanup EXIT

fail() { ERROR="$*"; exit 1; }

# Cách mã hoá chọn MỘT lần ở đầu (hàm encrypt chạy trong lệnh con nên không đặt được biến cho tiến trình chính).
if [ -n "$AGE_RECIPIENT" ] || [ -n "$AGE_RECIPIENTS_FILE" ]; then ENC_MODE=age; ENCRYPTED=true; need_cmd age
elif [ -n "$GPG_RECIPIENT" ]; then ENC_MODE=gpg; ENCRYPTED=true; need_cmd gpg
elif [ "$ALLOW_PLAIN" = "true" ]; then ENC_MODE=plain; log "CẢNH BÁO: sao lưu KHÔNG mã hoá (BACKUP_ALLOW_PLAINTEXT=true, chỉ dùng khi diễn tập)" >&2
else fail "chưa cấu hình mã hoá (AGE_RECIPIENT hoặc GPG_RECIPIENT); từ chối sao lưu bản rõ"
fi

# Mã hoá từ tệp $1 ra tệp $2 (thêm đuôi). In đường dẫn tệp kết quả.
encrypt() {
  local in="$1" out="$2"
  case "$ENC_MODE" in
    age)
      if [ -n "$AGE_RECIPIENTS_FILE" ]; then age -R "$AGE_RECIPIENTS_FILE" -o "$out.age" "$in"; else age -r "$AGE_RECIPIENT" -o "$out.age" "$in"; fi
      echo "$out.age" ;;
    gpg)
      gpg --batch --yes --trust-model always -r "$GPG_RECIPIENT" -o "$out.gpg" -e "$in"
      echo "$out.gpg" ;;
    plain) mv "$in" "$out"; echo "$out" ;;
  esac
}

log "Sao lưu ($MODE) mốc $STAMP vào $BACKUP_DIR"

# 1. CSDL: dùng superuser trong container (RLS FORCE chặn cả chủ bảng, chỉ superuser mới dump đủ). Dump -> kiểm danh mục -> mã hoá.
dc exec -T postgres pg_dump -U postgres -d "$APP_DB" -Fc > "$WORK/db.dump" || fail "pg_dump thất bại"
ENTRIES="$(dc exec -T postgres pg_restore --list < "$WORK/db.dump" | grep -c . || true)"
[ "${ENTRIES:-0}" -gt 20 ] || fail "bản dump có vẻ rỗng (chỉ $ENTRIES mục)"
DB_OUT="$(encrypt "$WORK/db.dump" "$BACKUP_DIR/mihato-db-$STAMP.dump")" || fail "mã hoá CSDL thất bại"
rm -f "$WORK/db.dump"
log "CSDL: $(basename "$DB_OUT") ($(stat -c %s "$DB_OUT" 2>/dev/null || wc -c < "$DB_OUT") byte, $ENTRIES mục)"

# 2. Tệp đính kèm cùng mốc giờ. Tệp ghi một lần và không sửa, nên chụp sau CSDL chỉ có thể dư tệp mồ côi, không thiếu tệp.
if [ "$MODE" = "full" ]; then
  dc exec -T api tar -C /data/files -cf - . | gzip -1 > "$WORK/files.tar.gz" || fail "tar kho tệp thất bại"
  gzip -t "$WORK/files.tar.gz" || fail "tệp nén kho tệp hỏng"
  FILES_OUT="$(encrypt "$WORK/files.tar.gz" "$BACKUP_DIR/mihato-files-$STAMP.tar.gz")" || fail "mã hoá kho tệp thất bại"
  rm -f "$WORK/files.tar.gz"
  log "Tệp: $(basename "$FILES_OUT")"
fi

( cd "$BACKUP_DIR" && sha256sum "$(basename "$DB_OUT")" ${FILES_OUT:+"$(basename "$FILES_OUT")"} > "SHA256SUMS-$STAMP" )

# 3. Giữ KEEP_DAYS ngày ở máy chủ.
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'mihato-db-*' -o -name 'mihato-files-*' -o -name 'SHA256SUMS-*' \) -mtime "+$KEEP_DAYS" -delete

# 4. Sang nơi khác máy chủ.
if [ -n "$RCLONE_REMOTE" ]; then
  need_cmd rclone
  rclone copy --include 'mihato-*' --include 'SHA256SUMS-*' "$BACKUP_DIR" "$RCLONE_REMOTE" || fail "rclone copy thất bại"
  rclone delete --min-age "${KEEP_DAYS}d" "$RCLONE_REMOTE" || log "CẢNH BÁO: không dọn được bản cũ ở $RCLONE_REMOTE" >&2
  OFFSITE=true
elif [ -n "$RSYNC_TARGET" ]; then
  need_cmd rsync
  rsync -a --partial --delete-after --exclude '.lock' --exclude '.work-*' --exclude 'status.json*' "$BACKUP_DIR/" "$RSYNC_TARGET/" || fail "rsync thất bại"
  OFFSITE=true
fi
if [ "$OFFSITE" != "true" ] && [ "$REQUIRE_OFFSITE" = "true" ]; then
  fail "chưa cấu hình nơi đặt bản sao khác máy chủ (BACKUP_RCLONE_REMOTE hoặc BACKUP_RSYNC_TARGET); bản cục bộ vẫn có ở $BACKUP_DIR"
fi

write_status true
log "Sao lưu xong. offsite=$OFFSITE encrypted=$ENCRYPTED"
