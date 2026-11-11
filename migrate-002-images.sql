-- v0.4 加圖片欄位. 執行一次: npx wrangler d1 execute anon-box-db --remote --file=migrate-002-images.sql
ALTER TABLE submissions ADD COLUMN images TEXT NOT NULL DEFAULT '[]';  -- R2 物件 key 的 JSON 陣列
