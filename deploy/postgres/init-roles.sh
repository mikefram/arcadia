#!/bin/sh
# Chạy MỘT lần khi dựng PostgreSQL trên volume trống (docker-entrypoint-initdb.d). Thay db/init/00_roles.sql của máy phát triển:
# mật khẩu đọc từ biến môi trường, không ghi cứng. Ba vai trò theo SPEC 5.4 và 11.3:
#   app_owner  sở hữu bảng, chỉ chạy migration
#   app_user   chạy api và worker, chịu RLS
#   app_scan   BYPASSRLS, chỉ SELECT và UPDATE trên timers, effects (cấp ở migration 0001)
set -eu

: "${APP_OWNER_PASSWORD:?thiếu APP_OWNER_PASSWORD}"
: "${APP_USER_PASSWORD:?thiếu APP_USER_PASSWORD}"
: "${APP_SCAN_PASSWORD:?thiếu APP_SCAN_PASSWORD}"
APP_DB="${APP_DB:-mihato}"

case "$APP_DB" in
  *_dev|*_test) echo "Tên CSDL production không được có đuôi _dev hoặc _test" >&2; exit 1 ;;
esac

# format(%L) trích dẫn đúng chuỗi; psql -v không đưa mật khẩu vào dòng lệnh của tiến trình khác (chạy trong container, vẫn dùng stdin).
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_pw="$APP_OWNER_PASSWORD" -v user_pw="$APP_USER_PASSWORD" -v scan_pw="$APP_SCAN_PASSWORD" -v appdb="$APP_DB" <<'SQL'
SELECT format('CREATE ROLE app_owner LOGIN PASSWORD %L CREATEROLE', :'owner_pw') \gexec
SELECT format('CREATE ROLE app_user  LOGIN PASSWORD %L', :'user_pw') \gexec
SELECT format('CREATE ROLE app_scan  LOGIN PASSWORD %L BYPASSRLS', :'scan_pw') \gexec
SELECT format('CREATE DATABASE %I OWNER app_owner', :'appdb') \gexec
SQL
echo "Đã tạo vai trò app_owner, app_user, app_scan và CSDL ${APP_DB}"
