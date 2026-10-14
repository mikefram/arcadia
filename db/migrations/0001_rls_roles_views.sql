-- Migration viết tay (SPEC 5.4, 5.5, 11.3): RLS, quyền của ba vai trò CSDL, trigger chặn sửa xoá, hàm và view.
-- Ba vai trò app_owner, app_user, app_scan do quản trị CSDL tạo trước (db/init/00_roles.sql ở máy phát triển):
-- chỉ superuser mới cấp được BYPASSRLS cho app_scan.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') OR NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_scan') THEN
    RAISE EXCEPTION 'Thiếu vai trò CSDL app_user hoặc app_scan. Chạy db/init/00_roles.sql bằng tài khoản quản trị trước.';
  END IF;
END $$;
--> statement-breakpoint

-- Đồng hồ của CSDL. Môi trường thử nghiệm đặt `SET LOCAL app.now` để điều khiển đồng hồ giả (SPEC 13.1);
-- khi chạy thật biến này không được đặt và hàm trả now().
CREATE FUNCTION app_now() RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('app.now', true), '')::timestamptz, now())
$$;
--> statement-breakpoint

-- RLS cho mọi bảng có cột org_id: truy vấn quên đặt tổ chức không thấy dòng nào và không lỗi ép kiểu.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT c.table_name FROM information_schema.columns c
           JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
           WHERE c.table_schema = 'public' AND c.column_name = 'org_id' AND tb.table_type = 'BASE TABLE' LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS org_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON %I
      USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
      WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
--> statement-breakpoint

-- organizations không có org_id: chính cột id là khoá.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_self ON organizations
  USING (id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint

-- Quyền: app_user chịu RLS và không sở hữu bảng; app_scan chỉ SELECT và UPDATE trên timers, effects.
GRANT USAGE ON SCHEMA public TO app_user, app_scan;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON run_events FROM app_user;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON audit_log FROM app_user;
--> statement-breakpoint
GRANT SELECT, UPDATE ON timers, effects TO app_scan;
--> statement-breakpoint

-- Lớp phòng thủ thứ hai: trigger chặn sửa xoá trên bảng chỉ thêm.
-- Chủ sở hữu (app_owner, không dùng lúc chạy) được xoá để dọn audit_log sau thời hạn lưu (SPEC 11.4).
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'audit_log' AND current_user = 'app_owner' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Bảng % chỉ thêm, không sửa, không xoá', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER run_events_append_only BEFORE UPDATE OR DELETE ON run_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint

-- Phiên bản đã xuất bản là bất biến (SPEC 4.1).
CREATE FUNCTION forbid_published_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'Phiên bản mẫu đã xuất bản là bất biến' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER template_versions_immutable BEFORE UPDATE OR DELETE ON process_template_versions FOR EACH ROW EXECUTE FUNCTION forbid_published_change();
--> statement-breakpoint

-- Đăng nhập web chưa biết tổ chức: tìm người theo email qua hàm SECURITY DEFINER, đặt app.org_id lần lượt
-- cho từng tổ chức nên vẫn đi qua RLS. Chỉ trả id, không trả dữ liệu hồ sơ.
CREATE FUNCTION auth_find_login(p_email text, p_org_code text DEFAULT NULL)
RETURNS TABLE (org_id uuid, user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o record;
  prev text := coalesce(current_setting('app.org_id', true), '');
BEGIN
  FOR o IN SELECT id FROM organizations WHERE p_org_code IS NULL OR code = p_org_code ORDER BY code LOOP
    PERFORM set_config('app.org_id', o.id::text, true);
    RETURN QUERY SELECT u.org_id, u.id FROM users u WHERE lower(u.email) = lower(p_email);
  END LOOP;
  PERFORM set_config('app.org_id', prev, true);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_find_login(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_find_login(text, text) TO app_user;
--> statement-breakpoint

-- Worker cần danh sách tổ chức để chạy các việc định kỳ theo từng tổ chức (bản tin sáng, hết hạn đề xuất, dọn dẹp).
CREATE FUNCTION list_org_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM organizations ORDER BY code
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION list_org_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION list_org_ids() TO app_user;
--> statement-breakpoint

-- View báo cáo dùng chung (SPEC 5.5): web, bản tóm tắt của AI và trang Tiến độ đọc cùng một nguồn.
-- security_invoker để view chịu RLS của người gọi.
CREATE VIEW v_step_status WITH (security_invoker = true) AS
SELECT s.id, s.org_id, s.run_id, r.title AS run_title, r.target_at, r.initiator_id,
       s.node_id, s.kind, s.title, s.state, s.assignee_id, s.on_behalf_of_id, s.due_at, s.due_original_at,
       s.activated_at, s.blocked_reason,
       (s.state IN ('unassigned','ready','in_progress') AND app_now() > s.due_at) AS is_overdue,
       GREATEST(0, floor(extract(epoch FROM (app_now() - s.due_at)) / 86400))::int AS calendar_days_late
FROM step_runs s JOIN process_runs r ON r.id = s.run_id
WHERE r.state = 'running' AND s.kind IN ('task','approval');
--> statement-breakpoint

CREATE VIEW v_run_progress WITH (security_invoker = true) AS
SELECT r.id AS run_id, r.org_id,
       count(*) FILTER (WHERE s.kind IN ('task','approval') AND s.state NOT IN ('skipped','cancelled')) AS total,
       count(*) FILTER (WHERE s.kind IN ('task','approval') AND s.state = 'done') AS done,
       count(*) FILTER (WHERE s.kind IN ('task','approval') AND s.state IN ('unassigned','ready','in_progress') AND app_now() > s.due_at) AS overdue,
       min(s.due_at) FILTER (WHERE s.kind IN ('task','approval') AND s.state IN ('unassigned','ready','in_progress') AND app_now() > s.due_at) AS earliest_overdue_due_at
FROM process_runs r LEFT JOIN step_runs s ON s.run_id = r.id
GROUP BY r.id, r.org_id;
--> statement-breakpoint

CREATE VIEW v_workload_by_user WITH (security_invoker = true) AS
SELECT s.org_id, s.assignee_id AS user_id,
       count(*) FILTER (WHERE s.state IN ('ready','in_progress')) AS open,
       count(*) FILTER (WHERE s.state IN ('ready','in_progress') AND app_now() > s.due_at) AS overdue
FROM step_runs s JOIN process_runs r ON r.id = s.run_id
WHERE r.state = 'running' AND s.kind IN ('task','approval') AND s.assignee_id IS NOT NULL
GROUP BY s.org_id, s.assignee_id;
--> statement-breakpoint

-- Tỷ lệ đúng hạn theo hạn gốc (due_original_at), theo người và theo đơn vị (SPEC 9.6).
CREATE VIEW v_on_time_rate WITH (security_invoker = true) AS
SELECT s.org_id, s.assignee_id AS user_id, u.unit_id,
       count(*) AS completed,
       count(*) FILTER (WHERE s.completed_at <= s.due_original_at) AS on_time_original,
       count(*) FILTER (WHERE s.completed_at <= s.due_at) AS on_time_current
FROM step_runs s LEFT JOIN users u ON u.id = s.assignee_id
WHERE s.state = 'done' AND s.kind IN ('task','approval') AND s.due_original_at IS NOT NULL
GROUP BY s.org_id, s.assignee_id, u.unit_id;
--> statement-breakpoint
GRANT SELECT ON v_step_status, v_run_progress, v_workload_by_user, v_on_time_rate TO app_user;
