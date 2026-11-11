-- v0.7 記錄 TG 頻道訊息 id. 執行一次: npx wrangler d1 execute anon-box-db --remote --file=migrate-005-telegram.sql
ALTER TABLE submissions ADD COLUMN tg_msg_id TEXT;  -- TG 頻道訊息 id; 'sending:<時間>' 代表正在發
