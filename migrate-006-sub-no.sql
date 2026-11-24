-- v1.2 投稿編號可以自訂 (跟資料庫 id 分開). 執行一次: npx wrangler d1 execute anon-box-db --remote --file=migrate-006-sub-no.sql
ALTER TABLE submissions ADD COLUMN sub_no INTEGER;   -- 投稿編號, 投稿進來時從 settings.next_sub_no 配
UPDATE submissions SET sub_no = id;                   -- 舊稿沿用原本的號碼
INSERT OR IGNORE INTO settings (key, value) SELECT 'next_sub_no', COALESCE(MAX(id), 0) + 1 FROM submissions;
