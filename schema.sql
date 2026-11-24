-- 完整資料表 (全新安裝用; 已經建過的請跑 migrate-*.sql). 執行: npx wrangler d1 execute anon-box-db --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS submissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  body          TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'published')),
  withdraw_hash TEXT    NOT NULL UNIQUE,   -- 撤回碼的 SHA-256, 不存原碼
  images        TEXT    NOT NULL DEFAULT '[]',  -- R2 物件 key 的 JSON 陣列 (v0.4)
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  post_no       INTEGER,                  -- 發文編號 (v0.5)
  status_at     TEXT,                     -- 最後改狀態時間 (v0.5)
  fb_post_id    TEXT,                     -- 粉專貼文 id (v0.6)
  tg_msg_id     TEXT,                     -- TG 頻道訊息 id (v0.7)
  sub_no        INTEGER,                  -- 投稿編號 (v1.2)
  tg_error      TEXT,                     -- TG 同步失敗原因 (v1.3)
  fb_error      TEXT                      -- 粉專發文失敗原因 (v1.3)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_post_no ON submissions (post_no);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO settings (key, value) VALUES ('post_title', '匿名投稿'), ('number_digits', '3'), ('next_no', '1'), ('next_sub_no', '1');
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions (status, created_at);
