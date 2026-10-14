#!/usr/bin/env bash
# Kiểm tệp môi trường production mà không khởi động hệ thống: quyền tệp, cú pháp compose, rồi chạy packages/backend/scripts/check-env.ts
# trong container (địa chỉ https/wss, khoá đủ mạnh, khoá ES256, nhà cung cấp thật, thư mục tệp ghi được). Không in giá trị bí mật.
#   deploy/scripts/check-env.sh <tag>
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
export TAG="${1:-${TAG:-}}"
[ -n "$TAG" ] || die "thiếu tag. Dùng: check-env.sh <tag>"
need_cmd docker
check_env_file
dc config -q
dc up -d postgres
wait_for 120 "postgres sẵn sàng" dc exec -T postgres pg_isready -U postgres
dc --profile tools run --rm check-env
