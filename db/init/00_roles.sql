-- Chạy một lần khi dựng container PostgreSQL (môi trường local và ci).
-- Ba vai trò CSDL theo SPEC 5.4 và 11.3. Mật khẩu ở đây CHỈ dùng cho máy phát triển.
CREATE ROLE app_owner LOGIN PASSWORD 'app_owner_dev' CREATEROLE;
CREATE ROLE app_user  LOGIN PASSWORD 'app_user_dev';
CREATE ROLE app_scan  LOGIN PASSWORD 'app_scan_dev' BYPASSRLS;

CREATE DATABASE mihato_dev  OWNER app_owner;
CREATE DATABASE mihato_test OWNER app_owner;
