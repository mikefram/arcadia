#!/usr/bin/env bash
# Thiết lập MỘT lần để CI tự triển khai (docs/ops/auto-deploy.md). Chạy NGAY TRÊN MÁY CHỦ (VPS), MỘT lệnh, không cần máy tính cá nhân.
# Làm gì: (1) chép cửa vào khoá cứng /usr/local/sbin/mihato-remote-deploy; (2) tạo khoá SSH riêng cho CI NGAY TRÊN MÁY CHỦ và cho phép nó
# CHỈ chạy cửa vào đó (restrict + lệnh bắt buộc: không có shell, không chuyển cổng); (3) lấy dấu máy chủ; (4) kiểm máy chủ đã sẵn sàng;
# (5) tự kiểm đường SSH từ đầu tới cuối; (6) in (hoặc tự đặt) các secret GitHub cần có, rồi XOÁ khoá riêng khỏi máy chủ.
#
# Trước khi PR được gộp (tệp này mới nằm ở nhánh PR), một lệnh duy nhất:
#   cd ~/virtual-asisstant && git fetch -q origin && REF=origin/claude/sweet-davinci-o5ren6 \
#     bash <(git show origin/claude/sweet-davinci-o5ren6:deploy/scripts/setup-ci-deploy.sh)
# Sau khi đã gộp vào main:
#   cd ~/virtual-asisstant && git pull && bash deploy/scripts/setup-ci-deploy.sh
# Chạy lại được: mỗi lần chạy xoay khoá mới (khoá cũ bị gỡ) và in lại secret. Gỡ hẳn: thêm --revoke.
#
# Biến tuỳ chọn: GH_TOKEN (token GitHub quyền `repo` + cài sẵn `gh`: script tự đặt secret, khỏi dán tay); DEPLOY_HOST (địa chỉ để CI SSH tới,
# mặc định tự dò IP công khai); REF (nơi lấy mã cửa vào, mặc định origin/main); SSH_PORT (mặc định lấy từ sshd).
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || echo /root/virtual-asisstant)}"
REF="${REF:-origin/main}"
SSH_DIR="${SSH_DIR:-/root/.ssh}"
SBIN_DIR="${SBIN_DIR:-/usr/local/sbin}"
ENTRY="$SBIN_DIR/mihato-remote-deploy"
ENV_FILE="${MIHATO_ENV_FILE:-/etc/mihato/production.env}"
HOST_KEY_PUB="${HOST_KEY_PUB:-/etc/ssh/ssh_host_ed25519_key.pub}"
KEY_COMMENT="mihato-ci-deploy"

say() { printf '%s\n' "$*"; }
ok() { printf '  \033[32mđạt\033[0m  %s\n' "$*"; }
warn() { printf '  \033[33mCHÚ Ý\033[0m %s\n' "$*"; WARNINGS=$((WARNINGS + 1)); }
die() { printf '\033[31mLỖI:\033[0m %s\n' "$*" >&2; exit 1; }
WARNINGS=0

[ "$(id -u)" = 0 ] || die "chạy bằng root (sudo -i)"
for c in git ssh-keygen; do command -v "$c" >/dev/null 2>&1 || die "thiếu lệnh '$c'"; done

authorized_without_ci_key() {
  [ -f "$SSH_DIR/authorized_keys" ] || return 0
  grep -v " $KEY_COMMENT\$" "$SSH_DIR/authorized_keys" || true
}

if [ "${1:-}" = "--revoke" ]; then
  if [ -f "$SSH_DIR/authorized_keys" ]; then
    authorized_without_ci_key > "$SSH_DIR/authorized_keys.new"
    cat "$SSH_DIR/authorized_keys.new" > "$SSH_DIR/authorized_keys"
    rm -f "$SSH_DIR/authorized_keys.new"
  fi
  rm -f "$ENTRY"
  say "Đã gỡ khoá CI khỏi authorized_keys và xoá $ENTRY. Xoá thêm 3 secret DEPLOY_* ở GitHub."
  exit 0
fi

say "== 1. Cửa vào triển khai =="
[ -d "$REPO_DIR/.git" ] || die "không thấy repo ở $REPO_DIR (đặt REPO_DIR=...)"
[[ "$REPO_DIR" =~ ^[A-Za-z0-9_./-]+$ ]] || die "đường dẫn repo có ký tự lạ: $REPO_DIR"
git -C "$REPO_DIR" fetch --quiet origin || die "git fetch lỗi: máy chủ cần quyền đọc repo (như khi git pull)"
git -C "$REPO_DIR" cat-file -e "$REF:deploy/scripts/remote-deploy.sh" 2>/dev/null \
  || die "không thấy deploy/scripts/remote-deploy.sh ở $REF. Chưa gộp PR? Đặt REF=origin/claude/sweet-davinci-o5ren6"
TMP="$(mktemp -d "${TMPDIR:-/dev/shm}/mihato-ci.XXXXXX" 2>/dev/null || mktemp -d)"
cleanup() { [ -d "$TMP" ] && { find "$TMP" -type f -exec shred -u {} + 2>/dev/null || true; rm -rf "$TMP"; }; }
trap cleanup EXIT
git -C "$REPO_DIR" show "$REF:deploy/scripts/remote-deploy.sh" > "$TMP/entry"
sed -i "s|^REPO_DEFAULT=\"\"|REPO_DEFAULT=\"$REPO_DIR\"|" "$TMP/entry"
grep -q "^REPO_DEFAULT=\"$REPO_DIR\"" "$TMP/entry" || die "không điền được thư mục repo vào cửa vào"
bash -n "$TMP/entry" || die "cửa vào có lỗi cú pháp"
install -d -m 755 "$SBIN_DIR"
install -m 755 -o root -g root "$TMP/entry" "$ENTRY"
ok "đã chép $ENTRY (thuộc root, nằm ngoài thư mục repo; lấy từ $REF)"

say "== 2. Khoá SSH riêng cho CI (tạo ngay trên máy chủ) =="
ssh-keygen -q -t ed25519 -N "" -C "$KEY_COMMENT" -f "$TMP/key"
install -d -m 700 "$SSH_DIR"
touch "$SSH_DIR/authorized_keys"
chmod 600 "$SSH_DIR/authorized_keys"
authorized_without_ci_key > "$TMP/authorized_keys.new"
printf '%s\n' "restrict,command=\"$ENTRY\" $(cat "$TMP/key.pub")" >> "$TMP/authorized_keys.new"
cat "$TMP/authorized_keys.new" > "$SSH_DIR/authorized_keys"
ok "đã cho phép khoá CI trong $SSH_DIR/authorized_keys, CHỈ chạy $ENTRY (restrict: không shell, không chuyển cổng)"

SSH_PORT="${SSH_PORT:-}"
if command -v sshd >/dev/null 2>&1; then
  SSHD_CFG="$(sshd -T 2>/dev/null || true)"
  [ -n "$SSH_PORT" ] || SSH_PORT="$(printf '%s\n' "$SSHD_CFG" | awk '$1 == "port" { print $2; exit }')"
  case "$(printf '%s\n' "$SSHD_CFG" | awk '$1 == "permitrootlogin" { print $2 }')" in
    no) warn "sshd đang cấm root đăng nhập (PermitRootLogin no): khoá CI sẽ không vào được. Đặt 'PermitRootLogin prohibit-password' trong /etc/ssh/sshd_config rồi 'systemctl reload ssh'" ;;
  esac
  [ "$(printf '%s\n' "$SSHD_CFG" | awk '$1 == "pubkeyauthentication" { print $2 }')" = "no" ] && warn "sshd đang tắt đăng nhập bằng khoá (PubkeyAuthentication no)"
fi
SSH_PORT="${SSH_PORT:-22}"

say "== 3. Dấu máy chủ (để CI không bị đánh lừa) =="
[ -r "$HOST_KEY_PUB" ] || die "không đọc được $HOST_KEY_PUB (khoá máy chủ ed25519)"
HOST="${DEPLOY_HOST:-}"
if [ -z "$HOST" ]; then
  HOST="$(curl -fsS --max-time 6 https://api.ipify.org 2>/dev/null || true)"
  [ -n "$HOST" ] || HOST="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i == "src") print $(i + 1) }' | head -1)"
fi
[ -n "$HOST" ] || die "không dò được địa chỉ máy chủ; đặt DEPLOY_HOST=<IP hoặc tên miền>"
if [ "$SSH_PORT" = 22 ]; then KNOWN_HOST="$HOST"; else KNOWN_HOST="[$HOST]:$SSH_PORT"; fi
KNOWN_LINE="$KNOWN_HOST $(awk '{ print $1 " " $2 }' "$HOST_KEY_PUB")"
ok "địa chỉ CI sẽ SSH tới: $HOST (cổng $SSH_PORT). Nếu sai (máy chủ sau NAT, hoặc muốn dùng tên miền) chạy lại với DEPLOY_HOST=..."

say "== 4. Máy chủ đã sẵn sàng cho triển khai tự động? =="
if [ -r "$ENV_FILE" ]; then
  [ "$(stat -c %a "$ENV_FILE")" = 600 ] && ok "$ENV_FILE có quyền 600" || warn "$ENV_FILE phải có quyền 600"
  grep -Eq '^AGE_RECIPIENT=.+|^GPG_RECIPIENT=.+' "$ENV_FILE" && ok "đã cấu hình mã hoá sao lưu" || warn "chưa có AGE_RECIPIENT hay GPG_RECIPIENT: sao lưu trước migrate sẽ thất bại và chặn triển khai"
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'edge-caddy'; then
    grep -Eq '^MIHATO_COMPOSE_EXTRA=.*compose\.edge\.yml' "$ENV_FILE" && ok "chạy sau edge-caddy (compose.edge.yml bật)" || warn "có edge-caddy nhưng chưa bật MIHATO_COMPOSE_EXTRA=compose.edge.yml: web sẽ tranh cổng 80/443"
  fi
  DOMAIN_VALUE="$(grep -E '^DOMAIN=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"'"'" || true)"
else
  warn "không đọc được $ENV_FILE"
fi
grep -q 'ghcr.io' "${DOCKER_CONFIG:-/root/.docker}/config.json" 2>/dev/null && ok "đã docker login ghcr.io" || warn "chưa docker login ghcr.io: không kéo được ảnh (nếu gói GHCR công khai thì bỏ qua)"
command -v flock >/dev/null 2>&1 && ok "có flock" || warn "thiếu flock (apt install util-linux): không có khoá chống hai lần triển khai cùng lúc"
[ -z "$(git -C "$REPO_DIR" status --porcelain --untracked-files=no)" ] && ok "thư mục triển khai không có thay đổi chưa commit" || warn "thư mục $REPO_DIR có thay đổi chưa commit: cửa vào sẽ từ chối triển khai cho tới khi bạn git stash hoặc git checkout -- ."
[ "$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)" = main ] && ok "thư mục triển khai đang ở nhánh main" || warn "thư mục triển khai không ở nhánh main ($(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)); cửa vào sẽ chuyển về main khi triển khai"

say "== 5. Tự kiểm đường SSH từ đầu tới cuối =="
if [ -n "${SKIP_SSH_TEST:-}" ]; then
  say "  (bỏ qua theo SKIP_SSH_TEST)"
else
  OUT="$(ssh -i "$TMP/key" -p "$SSH_PORT" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 root@127.0.0.1 ping 2>&1 || true)"
  case "$OUT" in
    *"mihato-remote-deploy ok"*) ok "khoá CI vào được và chỉ chạy cửa vào triển khai" ;;
    *) warn "tự kiểm SSH không đạt (sshd chưa chạy ở cổng $SSH_PORT, hoặc cấm root/khoá?): ${OUT:0:200}" ;;
  esac
  # Khoá phải KHÔNG mở được shell: lệnh bất kỳ chỉ nhận cùng một phản hồi từ chối.
  OUT2="$(ssh -i "$TMP/key" -p "$SSH_PORT" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 root@127.0.0.1 'id' 2>&1 || true)"
  case "$OUT2" in
    *uid=*) warn "NGUY HIỂM: khoá CI chạy được lệnh tuỳ ý. Kiểm $SSH_DIR/authorized_keys" ;;
    *"mihato-remote-deploy ok"*) ;;
    *) ok "lệnh tuỳ ý bị từ chối (không có shell)" ;;
  esac
fi

PUBLIC_URL="${PUBLIC_URL:-${DOMAIN_VALUE:+https://$DOMAIN_VALUE}}"
GH_REPO="$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null | sed -E 's#^(https://github.com/|git@github.com:)##; s#\.git$##' || true)"

say "== 6. Secret GitHub =="
# Tự đặt chỉ khi có gh, có GH_TOKEN và origin đúng dạng chủ/repo GitHub. Lỗi ở đâu thì rơi về in ra để dán tay: khoá riêng bị xoá khi script
# kết thúc nên KHÔNG được thoát giữa chừng mà chưa đưa khoá cho người dùng.
AUTO_SET=0
if command -v gh >/dev/null 2>&1 && [ -n "${GH_TOKEN:-}" ] && [[ "$GH_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  if gh secret set DEPLOY_HOST --repo "$GH_REPO" --body "$HOST" >/dev/null 2>&1 \
    && gh secret set DEPLOY_KNOWN_HOSTS --repo "$GH_REPO" --body "$KNOWN_LINE" >/dev/null 2>&1 \
    && gh secret set DEPLOY_SSH_KEY --repo "$GH_REPO" < "$TMP/key" >/dev/null 2>&1; then
    [ -z "$PUBLIC_URL" ] || gh variable set PUBLIC_URL --repo "$GH_REPO" --body "$PUBLIC_URL" >/dev/null 2>&1 || warn "không đặt được biến PUBLIC_URL (không bắt buộc)"
    [ "$SSH_PORT" = 22 ] || gh variable set DEPLOY_PORT --repo "$GH_REPO" --body "$SSH_PORT" >/dev/null 2>&1 || warn "không đặt được biến DEPLOY_PORT: đặt tay (cổng SSH $SSH_PORT)"
    AUTO_SET=1
    ok "đã tự đặt 3 secret ở $GH_REPO (khoá riêng không in ra màn hình)"
  else
    warn "GH_TOKEN không đặt được secret (thiếu quyền repo?): rơi về cách dán tay bên dưới"
  fi
fi
if [ "$AUTO_SET" != 1 ]; then
  say "Mở https://github.com/${GH_REPO:-<chủ>/<repo>}/settings/secrets/actions, bấm New repository secret, tạo ĐÚNG 3 secret sau"
  say "(sao chép nguyên văn từng khối; khoá riêng chỉ hiện MỘT lần ở đây và đã bị xoá khỏi máy chủ sau khi in):"
  say ""
  say "----- Tên: DEPLOY_HOST -----"
  say "$HOST"
  say ""
  say "----- Tên: DEPLOY_KNOWN_HOSTS -----"
  say "$KNOWN_LINE"
  say ""
  say "----- Tên: DEPLOY_SSH_KEY (chép cả dòng BEGIN và END) -----"
  cat "$TMP/key"
  say "----- hết -----"
  say ""
  say "Rồi tab Variables cùng trang: PUBLIC_URL = ${PUBLIC_URL:-https://<tên-miền>}$([ "$SSH_PORT" = 22 ] || printf ', DEPLOY_PORT = %s' "$SSH_PORT")"
  say "(Muốn khỏi dán tay lần sau: cài gh và chạy với GH_TOKEN=<token quyền repo>.)"
fi

say ""
say "Xong$( [ "$WARNINGS" -eq 0 ] || printf ' (có %s mục CHÚ Ý ở trên, nên xử lý trước lần triển khai đầu)' "$WARNINGS" )."
say "Tiếp theo: gộp PR; CI xanh thì workflow deploy tự chạy. Lần đầu nên mở Actions để xem. Gỡ khoá: bash <script> --revoke"
