#!/usr/bin/env bash
# Hàm dùng chung của các script triển khai. Được `source`, không chạy trực tiếp.
# Biến: MIHATO_ENV_FILE (mặc định /etc/mihato/production.env), MIHATO_COMPOSE_FILE, MIHATO_STATE_DIR (mặc định /var/lib/mihato).
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${MIHATO_ENV_FILE:-/etc/mihato/production.env}"
COMPOSE_FILE="${MIHATO_COMPOSE_FILE:-$DEPLOY_DIR/compose.production.yml}"
STATE_DIR="${MIHATO_STATE_DIR:-/var/lib/mihato}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "LỖI: $*" >&2; exit 1; }

# Đọc một biến từ tệp môi trường mà KHÔNG thực thi tệp (giá trị có thể chứa ký tự đặc biệt). In giá trị, bỏ cặp nháy bao ngoài.
envval() {
  local v
  v="$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

# docker compose với tệp môi trường ngoài repo; TAG phải được export trước (deploy.sh, rollback.sh đặt).
# Tệp compose bổ sung: dòng MIHATO_COMPOSE_EXTRA trong tệp môi trường, các tên cách nhau bằng dấu cách, tính từ thư mục deploy/
# (ví dụ `compose.edge.yml` khi chạy sau proxy chung). Đặt ở tệp môi trường để không phải nhớ export mỗi lần triển khai.
dc() {
  local args=(--env-file "$ENV_FILE" -f "$COMPOSE_FILE") extra f
  extra="$(envval MIHATO_COMPOSE_EXTRA)"
  # shellcheck disable=SC2086  # cố ý tách từ: danh sách tên tệp
  for f in $extra; do args+=(-f "$DEPLOY_DIR/$f"); done
  docker compose "${args[@]}" "$@"
}

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "thiếu lệnh '$1'"; }

check_env_file() {
  [ -r "$ENV_FILE" ] || die "không đọc được $ENV_FILE (xem deploy/production.env.example)"
  if [ "$(uname -s)" = "Linux" ]; then
    local mode owner
    mode="$(stat -c %a "$ENV_FILE")"; owner="$(stat -c %U "$ENV_FILE")"
    [ "$mode" = "600" ] || die "$ENV_FILE phải có quyền 600 (đang $mode): chmod 600 $ENV_FILE"
    [ "$owner" = "root" ] || log "CẢNH BÁO: $ENV_FILE nên thuộc root (đang $owner)"
  fi
}

# Chờ tới khi lệnh trả 0, tối đa $1 giây. Dùng: wait_for 120 "mô tả" lệnh...
wait_for() {
  local limit="$1" what="$2"; shift 2
  local t=0
  until "$@" >/dev/null 2>&1; do
    t=$((t + 3))
    [ "$t" -le "$limit" ] || die "quá $limit giây chờ: $what"
    sleep 3
  done
  log "đạt: $what"
}

readyz_internal() { dc exec -T api wget -q -O /dev/null http://127.0.0.1:3100/readyz; }

# ───────────────────────── Triển khai cuốn chiếu (không gián đoạn) ─────────────────────────
# Với từng dịch vụ: chạy bản MỚI song song với bản cũ, chờ bản mới khoẻ, rồi mới tắt bản cũ. Bản mới không khoẻ thì gỡ bản mới
# và giữ nguyên bản cũ: người dùng không thấy gì. Điều kiện để chạy song song an toàn: migration theo kiểu mở rộng rồi thu hẹp
# (bản cũ chạy được trên CSDL mới; deploy/ci/migration-guard.mjs chặn migration phá vỡ), api và worker không giữ trạng thái trong bộ nhớ
# (SSE đi qua pg_notify, hàng đợi dùng SKIP LOCKED). Chỉ đụng tới dự án compose này, không đụng ứng dụng khác trên máy chủ.
HEALTH_TIMEOUT="${MIHATO_HEALTH_TIMEOUT:-180}"
STOP_TIMEOUT="${MIHATO_STOP_TIMEOUT:-40}"
MIN_FREE_MEM_MB="${MIHATO_MIN_FREE_MEM_MB:-1024}"
ROLLOUT_SERVICES="${MIHATO_ROLLOUT_SERVICES:-api worker scribe web}"

# Hai lần triển khai (hay triển khai với hoàn lại) cùng lúc sẽ giẫm lên nhau: giữ khoá, lần sau thấy khoá thì dừng ngay.
acquire_deploy_lock() {
  if command -v flock >/dev/null 2>&1; then
    exec 8>"$STATE_DIR/deploy.lock"
    flock -n 8 || die "đang có một lần triển khai hoặc hoàn lại khác chạy (khoá $STATE_DIR/deploy.lock)"
  fi
}

# Mã các container đang có của một dịch vụ, cách nhau bằng dấu cách.
container_ids() { dc ps -q "$1" 2>/dev/null | tr '\n' ' '; }

# healthy | starting | unhealthy | running (không có healthcheck) | exited | gone
health_of() {
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || echo gone
}

# Chờ mọi container trong danh sách khoẻ. 0 = khoẻ cả; 1 = có cái hỏng hoặc quá hạn.
wait_ids_healthy() {
  local limit="$1" t=0 id st all
  shift
  while [ "$t" -lt "$limit" ]; do
    all=1
    for id in "$@"; do
      st="$(health_of "$id")"
      case "$st" in
        healthy | running) ;;
        unhealthy | exited | dead | gone) return 1 ;;
        *) all=0 ;;
      esac
    done
    [ "$all" = 1 ] && return 0
    sleep 2
    t=$((t + 2))
  done
  return 1
}

# Bộ nhớ trống (MB) của máy chủ. Chạy song song cần thêm chỗ cho một bản của dịch vụ lớn nhất: thiếu chỗ thì dừng TRƯỚC khi đụng
# vào gì, để không làm các ứng dụng khác trên máy chủ bị ép bộ nhớ.
free_mem_mb() { awk '/^MemAvailable:/ { printf "%d", $2 / 1024 }' /proc/meminfo 2>/dev/null || echo 999999; }
assert_free_memory() {
  local free
  free="$(free_mem_mb)"
  [ -n "$free" ] || free=999999
  [ "$free" -ge "$MIN_FREE_MEM_MB" ] || die "bộ nhớ trống chỉ còn ${free} MB (cần ít nhất ${MIN_FREE_MEM_MB} MB để chạy bản mới song song); chưa đụng vào dịch vụ nào"
}

# Mã băm cấu hình hiện tại của dịch vụ (cùng giá trị compose ghi vào nhãn com.docker.compose.config-hash của container).
service_config_hash() { dc config --hash "$1" 2>/dev/null | awk -v s="$1" '$1 == s { print $2 }'; }
container_config_hash() { docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$1" 2>/dev/null || true; }

# 0 nếu mọi container đang chạy của dịch vụ đã đúng cấu hình và ảnh mới (không cần làm gì).
rollout_unchanged() {
  local svc="$1" ids="$2" want have id
  want="$(service_config_hash "$svc")"
  [ -n "$want" ] || return 1
  for id in $ids; do
    have="$(container_config_hash "$id")"
    [ "$have" = "$want" ] || return 1
  done
  return 0
}

# 0 nếu container có cổng mở ra máy chủ (không chạy hai bản cùng lúc được vì trùng cổng).
has_host_ports() {
  local id n
  for id in $1; do
    n="$(docker inspect -f '{{len .HostConfig.PortBindings}}' "$id" 2>/dev/null || echo 0)"
    [ "${n:-0}" -eq 0 ] || return 0
  done
  return 1
}

# Đổi một dịch vụ sang bản mới mà không gián đoạn. 0 = xong (hoặc không có gì đổi); 1 = bản mới không khoẻ, bản cũ vẫn chạy.
rollout_service() {
  local svc="$1" old count new="" id n
  old="$(container_ids "$svc")"
  count="$(printf '%s' "$old" | wc -w | tr -d ' ')"

  if [ "$count" -eq 0 ]; then
    log "  $svc: chưa chạy, khởi động"
    dc up -d --no-deps "$svc"
    # shellcheck disable=SC2046
    wait_ids_healthy "$HEALTH_TIMEOUT" $(container_ids "$svc") || return 1
    return 0
  fi
  if rollout_unchanged "$svc" "$old"; then
    log "  $svc: không đổi, giữ nguyên"
    return 0
  fi
  if has_host_ports "$old"; then
    log "  $svc: đang mở cổng ra máy chủ nên không chạy song song được; tạo lại (gián đoạn ngắn). Bật MIHATO_COMPOSE_EXTRA=compose.edge.yml để không gián đoạn"
    dc up -d --no-deps "$svc"
    return 0
  fi

  log "  $svc: chạy bản mới song song với $count bản cũ"
  dc up -d --no-deps --no-recreate --scale "$svc=$((count * 2))" "$svc"
  for id in $(container_ids "$svc"); do
    case " $old " in *" $id "*) ;; *) new="$new $id" ;; esac
  done
  [ -n "${new// /}" ] || { log "  $svc: không tạo được container mới"; return 1; }

  # shellcheck disable=SC2086
  if ! wait_ids_healthy "$HEALTH_TIMEOUT" $new; then
    log "  $svc: bản mới KHÔNG khoẻ sau ${HEALTH_TIMEOUT}s; gỡ bản mới, bản cũ vẫn phục vụ. Xem: docker logs <container>"
    # shellcheck disable=SC2086
    docker rm -f $new >/dev/null 2>&1 || true
    return 1
  fi

  log "  $svc: bản mới đã khoẻ, tắt bản cũ (chờ tối đa ${STOP_TIMEOUT}s cho việc đang chạy xong)"
  # shellcheck disable=SC2086
  docker stop -t "$STOP_TIMEOUT" $old >/dev/null
  # shellcheck disable=SC2086
  docker rm $old >/dev/null
  # Chuẩn hoá số lượng (không tạo lại container nào).
  n="$count"
  dc up -d --no-deps --no-recreate --scale "$svc=$n" "$svc"
  return 0
}

# Cuốn chiếu mọi dịch vụ người dùng thấy, theo thứ tự api, worker, scribe, web; ops-alert thì tạo lại bình thường (không phục vụ ai).
# Dừng ở dịch vụ đầu tiên hỏng và trả 1: các dịch vụ sau chưa bị đụng tới.
rollout_all() {
  local svc
  for svc in $ROLLOUT_SERVICES; do
    rollout_service "$svc" || return 1
  done
  dc up -d --no-deps ops-alert
}

mkdir -p "$STATE_DIR" 2>/dev/null || true
