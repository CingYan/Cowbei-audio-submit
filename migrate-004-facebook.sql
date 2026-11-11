-- v0.6 記錄粉專貼文 id. 執行一次: npx wrangler d1 execute anon-box-db --remote --file=migrate-004-facebook.sql
ALTER TABLE submissions ADD COLUMN fb_post_id TEXT;  -- 粉專貼文 id; 'sending' 代表正在發, 防止重複發文
