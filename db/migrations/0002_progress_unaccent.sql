-- Tìm theo tên không phân biệt dấu (SPEC 10.3: "không phân biệt dấu"): unaccent là extension tin cậy từ PostgreSQL 13,
-- chủ CSDL (app_owner) tự bật được. Quy tắc mặc định đổi cả "đ" thành "d".
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint

-- Tiến độ của lượt chạy: tổng số việc tính cả việc bị huỷ cùng lượt chạy (chỉ loại việc "Không cần làm"),
-- để lượt đã huỷ hiện "4 trên 6 việc đã xong" thay vì "4 trên 4".
CREATE OR REPLACE VIEW v_run_progress WITH (security_invoker = true) AS
SELECT r.id AS run_id, r.org_id,
       count(*) FILTER (WHERE s.kind IN ('task','approval') AND s.state <> 'skipped') AS total,
       count(*) FILTER (WHERE s.kind IN ('task','approval') AND s.state = 'done') AS done,
       count(*) FILTER (WHERE s.kind IN ('task','approval') AND s.state IN ('unassigned','ready','in_progress') AND app_now() > s.due_at) AS overdue,
       min(s.due_at) FILTER (WHERE s.kind IN ('task','approval') AND s.state IN ('unassigned','ready','in_progress') AND app_now() > s.due_at) AS earliest_overdue_due_at
FROM process_runs r LEFT JOIN step_runs s ON s.run_id = r.id
GROUP BY r.id, r.org_id;
