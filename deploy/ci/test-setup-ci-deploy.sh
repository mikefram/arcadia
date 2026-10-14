#!/usr/bin/env bash
# Kiểm đầu-cuối thiết lập tự triển khai bằng sshd THẬT trên cổng cục bộ (cần root và sshd; thiếu thì bỏ qua).
# Chạy: sudo bash deploy/ci/test-setup-ci-deploy.sh
# Chứng minh: setup-ci-deploy.sh dùng một lệnh dựng được cửa vào + khoá CI; khoá đó CHỈ chạy được deploy/rollback/ping, không có shell;
# deploy chỉ tiến tới (fast-forward) trên main, từ chối thư mục có thay đổi chưa commit; chạy lại xoay khoá; --revoke thu hồi.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ "$(id -u)" = 0 ] || { echo "bỏ qua: cần root"; exit 0; }
command -v sshd >/dev/null 2>&1 && command -v ssh-keygen >/dev/null 2>&1 || { echo "bỏ qua: thiếu sshd hoặc ssh-keygen"; exit 0; }
T="$(mktemp -d)"
PORT="${TEST_SSH_PORT:-2299}"
cleanup() { [ -f "$T/sshd.pid" ] && kill "$(cat "$T/sshd.pid")" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
FAIL=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; FAIL=1; }
check() { local n="$1"; shift; if "$@"; then ok "$n"; else bad "$n"; fi; }
has_in() { grep -q -- "$1" <<<"$2"; }
not_in() { ! grep -q -- "$1" <<<"$2"; }
G() { git -c user.name=t -c user.email=t@t "$@"; }

# ── repo giả: origin trần + bản làm việc của máy chủ + bản của nhà phát triển ──
git init -q --bare -b main "$T/origin.git"
git clone -q "$T/origin.git" "$T/work" 2>/dev/null
mkdir -p "$T/work/deploy/scripts"
cp "$ROOT/deploy/scripts/remote-deploy.sh" "$T/work/deploy/scripts/"
printf '#!/usr/bin/env bash\necho "STUB-DEPLOY tag=$1 head=$(git rev-parse HEAD)"\n' > "$T/work/deploy/scripts/deploy.sh"
printf '#!/usr/bin/env bash\necho "STUB-ROLLBACK tag=$1"\n' > "$T/work/deploy/scripts/rollback.sh"
chmod +x "$T/work/deploy/scripts/"*.sh
(cd "$T/work" && G checkout -q -b main 2>/dev/null; G add -A && G commit -q -m c1 && G push -q origin main)
git clone -q "$T/origin.git" "$T/dev"
(cd "$T/dev" && echo more > f.txt && G add -A && G commit -q -m c2 && G push -q origin main)
SHA2="$(git -C "$T/dev" rev-parse HEAD)"
(cd "$T/dev" && G checkout -q -b evil HEAD~1 && echo evil > e.txt && G add -A && G commit -q -m evil && G push -q origin evil)
SHA_EVIL="$(git -C "$T/dev" rev-parse HEAD)"

# ── sshd thật ──
mkdir -p /run/sshd "$T/ssh" "$T/sbin"
ssh-keygen -q -t ed25519 -N "" -f "$T/hostkey"
cat > "$T/sshd_config" <<CFG
Port $PORT
ListenAddress 127.0.0.1
HostKey $T/hostkey
PidFile $T/sshd.pid
AuthorizedKeysFile $T/ssh/authorized_keys
PermitRootLogin prohibit-password
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
CFG
"$(command -v sshd)" -f "$T/sshd_config" -E "$T/sshd.log" || { echo "không chạy được sshd"; exit 1; }
sleep 1

run_setup() {
  env -u GH_TOKEN -u GITHUB_TOKEN REPO_DIR="$T/work" REF=origin/main SSH_DIR="$T/ssh" SBIN_DIR="$T/sbin" HOST_KEY_PUB="$T/hostkey.pub" DEPLOY_HOST=127.0.0.1 SSH_PORT="$PORT" \
    MIHATO_ENV_FILE="$T/none.env" DOCKER_CONFIG="$T/nodocker" TMPDIR="$T" bash "$ROOT/deploy/scripts/setup-ci-deploy.sh" "$@" 2>&1
}
ci() { ssh -i "$1" -p "$PORT" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=8 root@127.0.0.1 "${@:2}" 2>&1; }
extract_key() { awk '/BEGIN OPENSSH PRIVATE KEY/ {p=1} p {print} /END OPENSSH PRIVATE KEY/ {p=0}' <<<"$1"; }

echo "1. chạy setup một lệnh"
OUT1="$(run_setup)"
echo "$OUT1" | sed 's/^/     | /' | grep -E "đạt|CHÚ Ý|LỖI" | head -20
check "tự kiểm SSH đầu-cuối đạt" has_in "khoá CI vào được và chỉ chạy cửa vào" "$OUT1"
check "lệnh tuỳ ý bị từ chối" has_in "lệnh tuỳ ý bị từ chối" "$OUT1"
check "in khoá riêng đúng một lần" test "$(grep -c 'BEGIN OPENSSH PRIVATE KEY' <<<"$OUT1")" -eq 1
check "in dòng known_hosts đúng" grep -q "^\[127.0.0.1\]:$PORT ssh-ed25519 " <<<"$OUT1"
check "authorized_keys có restrict và lệnh bắt buộc" grep -q "^restrict,command=\"$T/sbin/mihato-remote-deploy\" ssh-ed25519 .* mihato-ci-deploy\$" "$T/ssh/authorized_keys"
check "cửa vào đã điền thư mục repo" grep -q "^REPO_DEFAULT=\"$T/work\"" "$T/sbin/mihato-remote-deploy"
check "cửa vào thuộc root, không ai khác ghi được" test "$(stat -c '%U %a' "$T/sbin/mihato-remote-deploy")" = "root 755"
check "không còn khoá riêng nằm lại ở thư mục tạm" bash -c "! find '$T' -name 'key' -o -name 'key.pub' | grep -q ."
extract_key "$OUT1" > "$T/ci_key1"; chmod 600 "$T/ci_key1"

echo "2. dùng khoá như CI sẽ dùng"
check "ping" test "$(ci "$T/ci_key1" ping)" = "mihato-remote-deploy ok"
OUT_ID="$(ci "$T/ci_key1" id)"
check "lệnh 'id' không chạy được" not_in "uid=" "$OUT_ID"
OUT_T="$(ci "$T/ci_key1" "deploy bad/tag $SHA2")"
check "tag sai bị từ chối" has_in "tag không hợp lệ" "$OUT_T"
OUT_D="$(ci "$T/ci_key1" "deploy v1.0.0 $SHA2")"
check "deploy tiến tới commit mới rồi chạy deploy.sh với đúng tag" grep -q "STUB-DEPLOY tag=v1.0.0 head=$SHA2" <<<"$OUT_D"
check "thư mục triển khai nằm trên nhánh main (không tách HEAD)" test "$(git -C "$T/work" rev-parse --abbrev-ref HEAD)" = main
check "git pull bằng tay vẫn chạy được" git -C "$T/work" pull -q --ff-only
OUT_E="$(ci "$T/ci_key1" "deploy sha-abcdef0 $SHA_EVIL")"
check "commit không tiến tới từ main bị từ chối" grep -q "không tiến tới" <<<"$OUT_E"
check "và không chạy deploy.sh" not_in "STUB-DEPLOY" "$OUT_E"
echo "tracked change" >> "$T/work/f.txt"
OUT_F="$(ci "$T/ci_key1" "deploy v1.0.1 $SHA2")"
check "thư mục có thay đổi chưa commit bị từ chối" grep -q "thay đổi chưa commit" <<<"$OUT_F"
git -C "$T/work" checkout -q -- f.txt
check "rollback chạy rollback.sh" grep -q "STUB-ROLLBACK tag=v1.0.0" <<<"$(ci "$T/ci_key1" "rollback v1.0.0")"

echo "3. chạy lại xoay khoá"
OUT2="$(run_setup)"
extract_key "$OUT2" > "$T/ci_key2"; chmod 600 "$T/ci_key2"
check "khoá mới vào được" test "$(ci "$T/ci_key2" ping)" = "mihato-remote-deploy ok"
check "khoá cũ không còn vào được" not_in "mihato-remote-deploy ok" "$(ci "$T/ci_key1" ping)"
check "chỉ còn đúng một dòng khoá CI" test "$(grep -c ' mihato-ci-deploy$' "$T/ssh/authorized_keys")" -eq 1

echo "4. --revoke"
run_setup --revoke >/dev/null
check "khoá không còn vào được" not_in "mihato-remote-deploy ok" "$(ci "$T/ci_key2" ping)"
check "cửa vào đã gỡ" test ! -e "$T/sbin/mihato-remote-deploy"

echo
[ "$FAIL" -eq 0 ] && echo "TẤT CẢ ĐẠT" || { echo "CÓ LỖI"; exit 1; }
