-- v1.3 第二版: 已經跑過 migrate-007 (只有 tg_error) 的才需要跑這個. 執行一次: npx wrangler d1 execute anon-box-db --remote --file=migrate-008-fb-error.sql
ALTER TABLE submissions ADD COLUMN fb_error TEXT;   -- 最後一次發到粉專失敗的原因, 成功後清空
