#!/usr/bin/env bash
# Cửa vào DUY NHẤT cho CI qua SSH (docs/ops/auto-deploy.md). Đặt làm lệnh bắt buộc (forced command) trong authorized_keys, nên khoá của CI
# chỉ làm được đúng hai việc dưới đây, không mở được shell:
#   deploy <tag> <git-sha-40>   cập nhật mã triển khai về đúng commit đó rồi chạy deploy.sh <tag>
#   rollback <tag>              chạy rollback.sh <tag>
#   ping                        chỉ trả "mihato-remote-deploy ok" (kiểm khoá và lệnh bắt buộc đã nối đúng, không làm gì khác)
# <tag> chỉ nhận dạng v1.2.3 hoặc sha-abcdef0; <git-sha> 40 ký tự hex. Mọi thứ khác bị từ chối.
# Được setup-ci-deploy.sh chép tới /usr/local/sbin/mihato-remote-deploy (thuộc root, nằm NGOÀI thư mục repo mà chính lần triển khai sẽ ghi đè)
# và điền REPO_DEFAULT; chạy thẳng từ repo thì suy ra thư mục repo từ vị trí tệp.
# Viết trong hàm main để bash đọc xong cả tệp trước khi `git checkout` có thể thay nội dung chính tệp này.
set -euo pipefail

REPO_DEFAULT=""                       # setup-ci-deploy.sh điền đường dẫn thư mục repo trên máy chủ
DEPLOY_BRANCH="${MIHATO_DEPLOY_BRANCH:-main}"

main() {
  local repo verb tag sha extra
  repo="${MIHATO_REPO_DIR:-${REPO_DEFAULT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}}"
  read -r verb tag sha extra <<<"${SSH_ORIGINAL_COMMAND:-}"
  if [ "${verb:-}" = ping ] && [ -z "${tag:-}" ]; then echo "mihato-remote-deploy ok"; return 0; fi
  [ -z "${extra:-}" ] || { echo "lệnh thừa" >&2; return 2; }
  [[ "${tag:-}" =~ ^(v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.]+)?|sha-[0-9a-f]{7,40})$ ]] || { echo "tag không hợp lệ" >&2; return 2; }

  case "${verb:-}" in
    deploy)
      [[ "${sha:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "git sha phải đủ 40 ký tự hex" >&2; return 2; }
      cd "$repo"
      # Không ghi đè sửa tay trên máy chủ: có thay đổi chưa commit thì dừng và nói rõ, không âm thầm mất việc của người.
      if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
        echo "Thư mục triển khai $repo có thay đổi chưa commit; dừng để không ghi đè. Chạy git status ở đó." >&2
        return 3
      fi
      git fetch --quiet origin
      # Giữ thư mục trên nhánh main (không tách HEAD) để `git pull` bằng tay vẫn chạy được. Chỉ tiến tới (fast-forward): commit lạ không
      # nằm trên main thì bị từ chối, nên CI không thể đẩy máy chủ về mã không thuộc lịch sử main.
      git checkout --quiet "$DEPLOY_BRANCH"
      git merge --quiet --ff-only "$sha" || { echo "commit $sha không tiến tới từ $DEPLOY_BRANCH trên máy chủ" >&2; return 4; }
      exec "$repo/deploy/scripts/deploy.sh" "$tag"
      ;;
    rollback)
      cd "$repo"
      exec "$repo/deploy/scripts/rollback.sh" "$tag"
      ;;
    *)
      echo "chỉ nhận: deploy <tag> <sha> hoặc rollback <tag>" >&2
      return 2
      ;;
  esac
}

main
exit $?
