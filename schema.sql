-- 投稿資料表. 執行: npx wrangler d1 execute anon-box-db --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS submissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  body          TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'published')),
  withdraw_hash TEXT    NOT NULL UNIQUE,   -- 撤回碼的 SHA-256, 不存原碼
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions (status, created_at);
