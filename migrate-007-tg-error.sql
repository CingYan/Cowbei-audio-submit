-- v1.3 保留發送失敗的原因. 執行一次: npx wrangler d1 execute anon-box-db --remote --file=migrate-007-tg-error.sql
ALTER TABLE submissions ADD COLUMN tg_error TEXT;   -- 最後一次 TG 同步失敗的原因, 成功後清空
ALTER TABLE submissions ADD COLUMN fb_error TEXT;   -- 最後一次發到粉專失敗的原因, 成功後清空
