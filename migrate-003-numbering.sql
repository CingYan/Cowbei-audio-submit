-- v0.5 發文流水號 + 狀態時間 + 設定表. 執行一次: npx wrangler d1 execute anon-box-db --remote --file=migrate-003-numbering.sql
ALTER TABLE submissions ADD COLUMN post_no INTEGER;     -- 發文編號, 按「發布」時才配
ALTER TABLE submissions ADD COLUMN status_at TEXT;      -- 最後一次改狀態的時間 (UTC), 自動清理用
CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_post_no ON submissions (post_no);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO settings (key, value) VALUES ('post_title', '匿名投稿'), ('number_digits', '3'), ('next_no', '1');
