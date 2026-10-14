#!/usr/bin/env bash
# Kiểm logic cuốn chiếu của deploy/scripts/lib.sh bằng một `docker` giả (không cần Docker thật). Chạy: bash deploy/ci/test-rollout.sh
# Điều cần chứng minh: bản mới phải KHOẺ trước khi bản cũ bị tắt; bản mới hỏng thì bản cũ không bị đụng; không đổi thì không làm gì.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/state" "$T/s"
: > "$T/env"; : > "$T/compose.yml"

# ── docker giả: trạng thái ở $S (ids.<dịch vụ>, health.<id>, hash.<id>, ports.<id>, newhealth.<dịch vụ>, log) ──
cat > "$T/bin/docker" <<'STUB'
#!/usr/bin/env bash
S="${STUB_STATE:?}"
log() { echo "$*" >> "$S/log"; }
drop() { local id; for id in "$@"; do for f in "$S"/ids.*; do [ -e "$f" ] && tr ' ' '\n' < "$f" | grep -vx "$id" | grep -v '^$' | tr '\n' ' ' > "$f.tmp" && mv "$f.tmp" "$f"; done; done; }
case "$1" in
  compose)
    shift
    while [ $# -gt 0 ]; do case "$1" in --env-file | -f) shift 2 ;; *) break ;; esac; done
    sub="$1"; shift
    case "$sub" in
      ps) svc="${*: -1}"; cat "$S/ids.$svc" 2>/dev/null || true ;;
      config) echo "${*: -1} NEW" ;;
      up)
        svc="${*: -1}"; scale=""
        for a in "$@"; do case "$a" in *=*) scale="${a#*=}" ;; esac; done
        touch "$S/ids.$svc"
        if [ -n "$scale" ]; then
          have="$(wc -w < "$S/ids.$svc" | tr -d ' ')"
          k=0
          while [ "$have" -lt "$scale" ]; do
            k=$((k + 1)); id="$svc-new$k"
            echo "$id" >> "$S/created"
            printf '%s ' "$id" >> "$S/ids.$svc"
            echo NEW > "$S/hash.$id"
            [ -f "$S/newhealth.$svc" ] && cp "$S/newhealth.$svc" "$S/health.$id"
            have=$((have + 1))
          done
          log "scale $svc $scale"
        else
          [ -s "$S/ids.$svc" ] || printf '%s ' "$svc-1" > "$S/ids.$svc"
          log "up $svc"
        fi ;;
    esac ;;
  inspect)
    fmt="$3"; id="$4"
    case "$fmt" in
      *State.Health*) cat "$S/health.$id" 2>/dev/null || echo healthy ;;
      *config-hash*) cat "$S/hash.$id" 2>/dev/null || echo OLD ;;
      *PortBindings*) cat "$S/ports.$id" 2>/dev/null || echo 0 ;;
    esac ;;
  stop) shift; [ "$1" = "-t" ] && shift 2; log "stop $*"; drop "$@" ;;
  rm) shift; [ "$1" = "-f" ] && shift; log "rm $*"; drop "$@" ;;
esac
STUB
printf '#!/bin/sh\nexit 0\n' > "$T/bin/sleep"
chmod +x "$T/bin/docker" "$T/bin/sleep"

export PATH="$T/bin:$PATH" STUB_STATE="$T/s" MIHATO_ENV_FILE="$T/env" MIHATO_COMPOSE_FILE="$T/compose.yml" MIHATO_STATE_DIR="$T/state" TAG=test
# shellcheck source=../scripts/lib.sh
. "$ROOT/deploy/scripts/lib.sh" >/dev/null
log() { :; } # tắt nhật ký của lib trong lúc test
set +e # lib.sh bật `set -e`; ở đây cần đọc mã trả về của hàm thất bại

FAIL=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; FAIL=1; }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
reset() { rm -rf "$T/s"; mkdir -p "$T/s"; }
set_ids() { local svc="$1"; shift; printf '%s ' "$@" > "$T/s/ids.$svc"; }
line_of() { grep -n "$1" "$T/s/log" 2>/dev/null | head -1 | cut -d: -f1; }
has() { grep -q "$1" "$T/s/log" 2>/dev/null; }
ids_of() { cat "$T/s/ids.$1" 2>/dev/null | xargs; }

echo "1. đổi bản bình thường: bản mới khoẻ rồi mới tắt bản cũ"
reset; set_ids api api-old
rollout_service api; rc=$?
check "trả 0" test "$rc" -eq 0
check "chạy song song (scale api 2)" has "scale api 2"
check "bản mới được tạo TRƯỚC khi bản cũ bị tắt" test "$(line_of 'scale api 2')" -lt "$(line_of 'stop api-old')"
check "bản cũ bị tắt và gỡ" has "rm api-old"
check "chuẩn hoá về 1 bản" has "scale api 1"
check "chỉ còn bản mới" test "$(ids_of api)" = "api-new1"

echo "2. bản mới không khoẻ: bản cũ không bị đụng"
reset; set_ids api api-old; echo unhealthy > "$T/s/newhealth.api"
rollout_service api; rc=$?
check "trả 1" test "$rc" -eq 1
check "KHÔNG tắt bản cũ" bash -c "! grep -q 'stop api-old' '$T/s/log'"
check "gỡ bản mới" has "rm api-new1"
check "bản cũ còn chạy" test "$(ids_of api)" = "api-old"

echo "3. không đổi gì thì không làm gì"
reset; set_ids api api-old; echo NEW > "$T/s/hash.api-old"
rollout_service api; rc=$?
check "trả 0" test "$rc" -eq 0
check "không tạo, không tắt" test ! -s "$T/s/log"

echo "4. có cổng mở ra máy chủ: không chạy song song"
reset; set_ids web web-old; echo 2 > "$T/s/ports.web-old"
rollout_service web; rc=$?
check "trả 0" test "$rc" -eq 0
check "tạo lại thường (up web), không scale" bash -c "grep -q '^up web' '$T/s/log' && ! grep -q 'scale web' '$T/s/log'"

echo "5. chưa chạy: khởi động"
reset
rollout_service api; rc=$?
check "trả 0 và có container" bash -c "[ $rc -eq 0 ] && [ -s '$T/s/ids.api' ]"

echo "6. rollout_all: đúng thứ tự, rồi ops-alert"
reset; for s in api worker scribe web; do set_ids "$s" "$s-old"; done
rollout_all; rc=$?
check "trả 0" test "$rc" -eq 0
check "api trước worker" test "$(line_of 'scale api 2')" -lt "$(line_of 'scale worker 2')"
check "worker trước scribe" test "$(line_of 'scale worker 2')" -lt "$(line_of 'scale scribe 2')"
check "scribe trước web" test "$(line_of 'scale scribe 2')" -lt "$(line_of 'scale web 2')"
check "ops-alert cuối" has "up ops-alert"

echo "7. api hỏng: các dịch vụ sau không bị đụng"
reset; for s in api worker scribe web; do set_ids "$s" "$s-old"; done; echo unhealthy > "$T/s/newhealth.api"
rollout_all; rc=$?
check "trả 1" test "$rc" -eq 1
check "worker không bị đụng" bash -c "! grep -q 'worker' '$T/s/log'"
check "web không bị đụng" bash -c "! grep -q 'web' '$T/s/log'"
check "không có bản cũ nào bị tắt" bash -c "! grep -q '^stop' '$T/s/log'"

echo "8. hai bản đang chạy (scale 2) cùng đổi"
reset; set_ids api api-old1 api-old2
rollout_service api; rc=$?
check "trả 0" test "$rc" -eq 0
check "tạo đủ 4 bản trước khi tắt" has "scale api 4"
check "còn đúng 2 bản mới" test "$(ids_of api | wc -w | tr -d ' ')" -eq 2

echo
[ "$FAIL" -eq 0 ] && echo "TẤT CẢ ĐẠT" || { echo "CÓ LỖI"; exit 1; }
