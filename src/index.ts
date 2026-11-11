// 匿名投稿 v0.7: 文字 + 最多 5 張圖 + 撤回碼 + 審核後台 + Turnstile 防灌 + TG 新稿通知
//              + 發文流水號 (後台設定) + 每日自動清理 + 隱私頁 + 一鍵發到 FB 粉專 + 同步到 TG 頻道 + 新介面.
// 不存 IP, 不存任何身分資料, 圖片清掉 EXIF/GPS.

interface Env {
  DB: D1Database
  IMAGES: R2Bucket
  // 以下都用 npx wrangler secret put <名稱> 設定, 不寫在程式碼裡
  ADMIN_PASSWORD: string
  TURNSTILE_SITE_KEY?: string // 沒設定時跳過人機驗證 (只適合開發中)
  TURNSTILE_SECRET?: string
  TG_BOT_TOKEN?: string // 沒設定時不發通知
  TG_CHAT_ID?: string
  FB_PAGE_ID?: string // 兩個都設定了, 後台才會出現「發布到粉專」
  FB_PAGE_TOKEN?: string
  TG_CHANNEL_ID?: string // 設定了才會同步到 TG 頻道 (@頻道帳號 或 -100 開頭的 id), 用 TG_BOT_TOKEN 那隻 bot 發
}

// ===== 可自訂的文字 =====
const SITE_NAME = '匿名投稿'
const SUCCESS_MESSAGE = '投稿成功! 審核通過後會發布到粉專.'
const MAX_LENGTH = 3000
const MAX_IMAGES = 5
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const FB_API = 'https://graph.facebook.com/v27.0' // Graph API 版本, 照 Graph API Explorer 顯示的改
// ========================

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url)
    const route = `${req.method} ${url.pathname}`
    try {
      if (route === 'GET /') return html(submitPage(env))
      if (route === 'POST /submit') return await submit(req, env, ctx, url)
      if (route === 'GET /withdraw') return html(withdrawPage())
      if (route === 'POST /withdraw') return await withdraw(req, env)
      if (route === 'GET /privacy') return html(await privacyPage(env))
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return await admin(req, env, url)
      return html(page('找不到頁面', '<p>這個網址不存在.</p><p><a href="/">回投稿頁</a></p>'), 404)
    } catch (e) {
      console.error(e)
      return html(page('出錯了', '<p>系統發生錯誤, 請稍後再試.</p>'), 500)
    }
  },
  // 每天自動清理, 時間在 wrangler.jsonc 的 triggers.crons 設定
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanup(env))
  },
} satisfies ExportedHandler<Env>

async function submit(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const form = await req.formData()
  const body = String(form.get('body') ?? '').trim()
  const files = form.getAll('images').filter((f): f is File => f instanceof File && f.size > 0)
  const fail = (msg: string) => html(submitPage(env, msg + (files.length ? ' (圖片需要重新選擇)' : ''), body), 400)

  if (!body && !files.length) return fail('內容不能是空的.')
  if (body.length > MAX_LENGTH) return fail(`內容超過 ${MAX_LENGTH} 字.`)
  if (files.length > MAX_IMAGES) return fail(`圖片最多 ${MAX_IMAGES} 張.`)

  // 先檢查並清理所有圖片, 全部合格才往下走
  const images: Uint8Array[] = []
  for (const f of files) {
    if (f.size > MAX_IMAGE_BYTES) return fail(`每張圖片不能超過 ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`)
    const clean = stripMetadata(new Uint8Array(await f.arrayBuffer()))
    if (!clean) return fail('只接受 JPEG 或 PNG 圖片.')
    images.push(clean)
  }

  if (!(await humanCheck(env, String(form.get('cf-turnstile-response') ?? '')))) {
    return fail('人機驗證沒有通過, 請再試一次.')
  }

  const keys: string[] = []
  for (const img of images) {
    const ext = img[0] === 0xff ? 'jpg' : 'png'
    const key = `${crypto.randomUUID()}.${ext}`
    await env.IMAGES.put(key, img, { httpMetadata: { contentType: ext === 'jpg' ? 'image/jpeg' : 'image/png' } })
    keys.push(key)
  }

  const code = newCode()
  const r = await env.DB.prepare('INSERT INTO submissions (body, withdraw_hash, images) VALUES (?, ?, ?)')
    .bind(body, await sha256(code), JSON.stringify(keys))
    .run()
  ctx.waitUntil(notifyAdmin(env, r.meta.last_row_id, url.origin))

  return html(page('投稿成功', `
    <div class="panel done">
      <p>${esc(SUCCESS_MESSAGE)}</p>
      <p class="small">你的撤回碼, 只會顯示這一次, 請截圖或抄下來:</p>
      <div class="code" id="code">${code}</div>
      <button type="button" class="ghost" onclick="navigator.clipboard.writeText('${code}').then(() => this.textContent = '已複製 ✓')">複製撤回碼</button>
      <p class="small">發布前想收回, 到 <a href="/withdraw">撤回頁</a> 輸入這組碼.</p>
    </div>
    <footer><a href="/">再投一篇</a></footer>`, { hero: '<header class="hero"><div class="logo">✅</div><h1>投稿成功</h1></header>' }))
}

async function withdraw(req: Request, env: Env): Promise<Response> {
  const form = await req.formData()
  const code = String(form.get('code') ?? '').trim().toUpperCase().replace(/[^A-Z2-9]/g, '')
  if (!code) return html(withdrawPage('請輸入撤回碼.'), 400)

  // 只能撤回還沒發布的; 撤回直接刪掉整筆和圖片, 不留內容
  const gone = await env.DB.prepare(
    "DELETE FROM submissions WHERE withdraw_hash = ? AND status IN ('pending', 'approved') AND fb_post_id IS NULL RETURNING images",
  ).bind(await sha256(code)).first<{ images: string }>()

  if (gone) {
    await deleteImages(env, gone.images)
    return html(page('已撤回', '<div class="panel done"><p>投稿已撤回, 文字和圖片都已刪除.</p></div><footer><a href="/">回投稿頁</a></footer>', { hero: '<header class="hero"><div class="logo">🗑️</div><h1>已撤回</h1></header>' }))
  }
  return html(withdrawPage('找不到這組撤回碼, 或這篇已經發布 (已發布的請私訊粉專處理).'), 404)
}

// ---------- 圖片 ----------

// 清掉圖片裡的中繼資料 (EXIF 含 GPS 座標, 機型, 拍攝時間). 不是 JPEG/PNG 就回 null.
function stripMetadata(b: Uint8Array): Uint8Array | null {
  if (b[0] === 0xff && b[1] === 0xd8) return stripJpeg(b)
  if (b.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return stripPng(b)
  return null
}

// JPEG: 丟掉 APP1~APP15 (EXIF, XMP, IPTC...) 和註解段, 其他原樣保留
function stripJpeg(b: Uint8Array): Uint8Array | null {
  const out: Uint8Array[] = [b.subarray(0, 2)]
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null
    const m = b[i + 1]
    if (m === 0xff) { i++; continue } // 填充位元組
    if (m === 0xda) { out.push(b.subarray(i)); return concat(out) } // 影像資料開始, 後面全收
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { out.push(b.subarray(i, i + 2)); i += 2; continue }
    const end = i + 2 + ((b[i + 2] << 8) | b[i + 3])
    if (end > b.length) return null
    if (!((m >= 0xe1 && m <= 0xef) || m === 0xfe)) out.push(b.subarray(i, end))
    i = end
  }
  return null
}

// PNG: 丟掉文字, EXIF, 時間 chunk
function stripPng(b: Uint8Array): Uint8Array | null {
  const drop = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME'])
  const out: Uint8Array[] = [b.subarray(0, 8)]
  let i = 8
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7])
    const end = i + 12 + len
    if (end > b.length) return null
    if (!drop.has(type)) out.push(b.subarray(i, end))
    i = end
    if (type === 'IEND') return concat(out)
  }
  return null
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

function parseKeys(json: string): string[] {
  try { return (JSON.parse(json) as string[]).filter(k => /^[0-9a-f-]{36}\.(jpg|png)$/.test(k)) } catch { return [] }
}

async function deleteImages(env: Env, json: string): Promise<void> {
  const keys = parseKeys(json)
  if (keys.length) await env.IMAGES.delete(keys)
}

// ---------- 防灌與通知 ----------

// Turnstile 驗證. 刻意不傳 remoteip, 維持不碰 IP.
async function humanCheck(env: Env, token: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true
  if (!token) return false
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token }),
  })
  const data = await res.json<{ success: boolean }>()
  return data.success === true
}

// 新稿通知: 只說「有新稿」和後台連結, 不把投稿內文送進 Telegram.
async function notifyAdmin(env: Env, id: number, origin: string): Promise<void> {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return
  try {
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM submissions WHERE status = 'pending'").first<{ n: number }>())!
    const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: `📮 新投稿 #${id}, 目前待審 ${n} 篇\n${origin}/admin` }),
    })
    if (!res.ok) console.error('TG 通知失敗', res.status, await res.text())
  } catch (e) {
    console.error('TG 通知失敗', e)
  }
}

// ---------- 設定 (存在 D1 的 settings 表, 後台可改) ----------

type Settings = {
  post_title: string     // 投稿名稱, 例: 匿名投稿
  number_digits: string  // 流水號位數, 3 → 001
  next_no: string        // 下一個要配的號碼
  tpl_facebook: string   // 粉專標題格式
  tpl_other: string      // 其他平台標題格式 (之後同步用)
  keep_rejected_days: string
  keep_pending_days: string
  keep_published_images_days: string
}
const DEFAULT_SETTINGS: Settings = {
  post_title: '匿名投稿', number_digits: '3', next_no: '1',
  tpl_facebook: '#{名稱}{編號}', tpl_other: '{名稱}{編號}',
  keep_rejected_days: '30', keep_pending_days: '90', keep_published_images_days: '30',
}
const SETTING_LABELS: Record<keyof Settings, string> = {
  post_title: '投稿名稱', number_digits: '流水號位數', next_no: '下一個發文編號',
  tpl_facebook: '粉專標題格式', tpl_other: '其他平台標題格式',
  keep_rejected_days: '退回稿保留天數', keep_pending_days: '待審稿保留天數', keep_published_images_days: '已發布圖片保留天數',
}

async function loadSettings(env: Env): Promise<Settings> {
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>()
  const s = { ...DEFAULT_SETTINGS }
  for (const r of rows.results) if (r.key in s) (s as Record<string, string>)[r.key] = r.value
  return s
}

// 標題: 例 #匿名投稿001 (粉專) / 匿名投稿001 (其他平台)
function postTitle(s: Settings, no: number, platform: 'facebook' | 'other'): string {
  const num = String(no).padStart(Number(s.number_digits) || 1, '0')
  return (platform === 'facebook' ? s.tpl_facebook : s.tpl_other).replaceAll('{名稱}', s.post_title).replaceAll('{編號}', num)
}

// 貼文全文 = 標題 + 空一行 + 內文
function postText(s: Settings, r: Row, platform: 'facebook' | 'other'): string {
  const title = r.post_no != null ? postTitle(s, r.post_no, platform) : `(發布時配號, 預計 ${postTitle(s, Number(s.next_no), platform)})`
  return r.body ? `${title}\n\n${r.body}` : title
}

// ---------- 自動清理 (每天排程跑一次) ----------

async function cleanup(env: Env): Promise<void> {
  const s = await loadSettings(env)
  const ago = (days: string) => `-${Math.max(1, Number(days) || 30)} days`
  // 退回稿, 久未處理的待審稿: 整筆連圖刪掉
  for (const [status, days] of [['rejected', s.keep_rejected_days], ['pending', s.keep_pending_days]] as const) {
    const gone = await env.DB.prepare(
      "DELETE FROM submissions WHERE status = ? AND COALESCE(status_at, created_at) < datetime('now', ?) RETURNING images",
    ).bind(status, ago(days)).all<{ images: string }>()
    for (const g of gone.results) await deleteImages(env, g.images)
    if (gone.results.length) console.log(`清理 ${status} ${gone.results.length} 篇`)
  }
  // 已發布: 只刪圖 (粉專上已經有了), 文字和編號留著
  const old = await env.DB.prepare(
    "SELECT id, images FROM submissions WHERE status = 'published' AND images != '[]' AND COALESCE(status_at, created_at) < datetime('now', ?)",
  ).bind(ago(s.keep_published_images_days)).all<{ id: number; images: string }>()
  for (const o of old.results) {
    await deleteImages(env, o.images)
    await env.DB.prepare("UPDATE submissions SET images = '[]' WHERE id = ?").bind(o.id).run()
  }
  if (old.results.length) console.log(`清理已發布圖片 ${old.results.length} 篇`)
}

// ---------- 審核後台 ----------

type Row = { id: number; body: string; status: string; created_at: string; images: string; post_no: number | null; fb_post_id?: string | null; tg_msg_id?: string | null }
const STATUS_TEXT: Record<string, string> = { pending: '待審', approved: '已通過, 待發布', rejected: '已退回', published: '已發布' }

async function admin(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.ADMIN_PASSWORD) return html(page('後台未設定', '<p>還沒設定 ADMIN_PASSWORD.</p>'), 503)
  if (!(await authorized(req, env.ADMIN_PASSWORD))) {
    return new Response('需要登入', { status: 401, headers: { 'www-authenticate': 'Basic realm="admin", charset="UTF-8"' } })
  }

  // 後台看圖 (圖片不公開, 要登入才看得到)
  if (req.method === 'GET' && url.pathname.startsWith('/admin/img/')) {
    const key = url.pathname.slice('/admin/img/'.length)
    if (!parseKeys(JSON.stringify([key])).length) return new Response('Not found', { status: 404 })
    const obj = await env.IMAGES.get(key)
    if (!obj) return new Response('Not found', { status: 404 })
    return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream', 'cache-control': 'private, max-age=3600' } })
  }

  if (req.method === 'POST') {
    // 擋跨站偽造請求: 只接受從自己網站送出的表單
    if (req.headers.get('origin') !== url.origin) return new Response('Forbidden', { status: 403 })
    const form = await req.formData()
    if (url.pathname === '/admin/settings') return await saveSettings(env, url, form)
    if (url.pathname === '/admin/action') return await doAction(env, url, form)
  }

  if (req.method === 'GET' && url.pathname === '/admin') {
    const s = await loadSettings(env)
    const tab = url.searchParams.get('tab') ?? 'pending'
    const counts = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM submissions GROUP BY status').all<{ status: string; n: number }>()
    const count = (st: string) => counts.results.find(c => c.status === st)?.n ?? 0
    const tabs = Object.entries(STATUS_TEXT).map(([st, label]) =>
      `<a class="tab${st === tab ? ' on' : ''}" href="/admin?tab=${st}">${label} (${count(st)})</a>`).join('')
      + `<a class="tab${tab === 'settings' ? ' on' : ''}" href="/admin?tab=settings">⚙ 設定</a>`
    const content = tab === 'settings' ? settingsForm(s, url.searchParams.has('saved')) : STATUS_TEXT[tab] ? await listTab(env, s, tab, Number(url.searchParams.get('hl')), fbReady(env), tgReady(env), url.searchParams.get('tgerr')) : '<p>沒有這個分頁.</p>'
    return html(page('審核後台', `<nav>${tabs}</nav>${content}${ADMIN_SCRIPT}`, { wide: true }))
  }
  return html(page('找不到頁面', '<p><a href="/admin">回後台</a></p>'), 404)
}

async function doAction(env: Env, url: URL, form: FormData): Promise<Response> {
  const id = Number(form.get('id'))
  const action = String(form.get('action'))
  const now = "datetime('now')"
  let goTo = String(form.get('tab') ?? 'pending')
  const next: Record<string, [string, string[]]> = {
    approve: ['approved', ['pending', 'rejected']],
    reject: ['rejected', ['pending', 'approved']],
    unpublish: ['approved', ['published']],
  }
  if (action === 'delete') {
    const gone = await env.DB.prepare("DELETE FROM submissions WHERE id = ? AND status = 'rejected' RETURNING images")
      .bind(id).first<{ images: string }>()
    if (gone) await deleteImages(env, gone.images)
  } else if (action === 'publish' || action === 'publish_fb') {
    if (!(await assignNumber(env, id))) {
      return html(page('發布失敗', '<p>發文編號撞號了, 到 <a href="/admin?tab=settings">設定</a> 把「下一個發文編號」調大再試.</p>'), 409)
    }
    if (action === 'publish_fb') {
      const err = await publishToFacebook(env, id)
      if (err) return html(page('發到粉專失敗', `<p class="err">${esc(err)}</p><p>這篇維持「已通過」, 號碼已保留, 修好後再按一次就好.</p><p><a href="/admin?tab=approved">回後台</a></p>`), 502)
    }
    await env.DB.prepare(`UPDATE submissions SET status = 'published', status_at = ${now} WHERE id = ? AND status = 'approved'`).bind(id).run()
    // 同步到 TG 頻道; 失敗不影響粉專, 之後可以在「已發布」補發
    if (tgReady(env)) {
      const err = await publishToTelegram(env, id)
      if (err) console.error('TG 頻道同步失敗', err)
      if (err) return Response.redirect(`${url.origin}/admin?tab=published&hl=${id}&tgerr=${encodeURIComponent(err)}`, 303)
    }
    goTo = `published&hl=${id}`
  } else if (action === 'publish_tg') {
    const err = await publishToTelegram(env, id)
    goTo = `published&hl=${id}` + (err ? `&tgerr=${encodeURIComponent(err)}` : '')
  } else if (next[action]) {
    const [to, from] = next[action]
    await env.DB.prepare(`UPDATE submissions SET status = ?, status_at = ${now} WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`)
      .bind(to, id, ...from).run()
  }
  return Response.redirect(`${url.origin}/admin?tab=${goTo}`, 303)
}

// 第一次發布才配號 (同一個交易: 號碼寫進這篇, 下一號 +1); 已經有號碼就沿用. 撞號回 false, 整批不生效.
async function assignNumber(env: Env, id: number): Promise<boolean> {
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE submissions SET post_no = (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'next_no') WHERE id = ? AND status = 'approved' AND post_no IS NULL`).bind(id),
      env.DB.prepare(`UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'next_no' AND EXISTS (SELECT 1 FROM submissions WHERE id = ? AND status = 'approved' AND post_no = CAST(value AS INTEGER))`).bind(id),
    ])
    return true
  } catch (e) {
    console.error(e)
    return false
  }
}

// ---------- 發到 FB 粉專 ----------

const fbReady = (env: Env) => Boolean(env.FB_PAGE_ID && env.FB_PAGE_TOKEN)
const isSending = (v: string | null | undefined) => Boolean(v?.startsWith('sending:'))
const fbPosted = (v: string | null | undefined) => Boolean(v && !isSending(v))

// 成功回 null, 失敗回錯誤說明. 先把這篇鎖成 'sending:<時間>', 連按兩下也只會發一次;
// 萬一程式中途掛掉, 鎖超過 3 分鐘就視為失效, 可以重按.
async function publishToFacebook(env: Env, id: number): Promise<string | null> {
  if (!fbReady(env)) return '還沒設定 FB_PAGE_ID / FB_PAGE_TOKEN.'
  const now = Date.now()
  const lock = await env.DB.prepare(
    "UPDATE submissions SET fb_post_id = ? WHERE id = ? AND status = 'approved' AND (fb_post_id IS NULL OR (fb_post_id LIKE 'sending:%' AND CAST(substr(fb_post_id, 9) AS INTEGER) < ?))",
  ).bind(`sending:${now}`, id, now - 180_000).run()
  if (lock.meta.changes !== 1) {
    const cur = await env.DB.prepare('SELECT fb_post_id FROM submissions WHERE id = ?').bind(id).first<{ fb_post_id: string | null }>()
    if (cur?.fb_post_id && !isSending(cur.fb_post_id)) return null // 已經發過了, 直接當成功
    return '這篇正在發送中, 或狀態不是「已通過」. 等幾秒重新整理看看.'
  }
  try {
    const r = (await env.DB.prepare('SELECT id, body, status, created_at, images, post_no FROM submissions WHERE id = ?').bind(id).first<Row>())!
    const message = postText(await loadSettings(env), r, 'facebook')
    // 貼 secret 時常多帶空白, 換行或 JSON 的引號, 先清掉
    const clean = (v: string) => v.trim().replace(/^["']|["']$/g, '').trim()
    const page = clean(env.FB_PAGE_ID!)
    const token = clean(env.FB_PAGE_TOKEN!)
    const media: string[] = []
    for (const key of parseKeys(r.images)) {
      const obj = await env.IMAGES.get(key)
      if (!obj) continue
      const fd = new FormData()
      fd.set('published', 'false') // 先上傳不公開, 最後跟文字一起發成一篇
      fd.set('access_token', token)
      fd.set('source', new Blob([await obj.arrayBuffer()], { type: obj.httpMetadata?.contentType ?? 'image/jpeg' }), key)
      media.push((await fbCall(`${FB_API}/${page}/photos`, fd)).id)
    }
    const body = new URLSearchParams({ message, access_token: token })
    media.forEach((m, i) => body.set(`attached_media[${i}]`, JSON.stringify({ media_fbid: m })))
    const post = await fbCall(`${FB_API}/${page}/feed`, body)
    await env.DB.prepare('UPDATE submissions SET fb_post_id = ? WHERE id = ?').bind(post.id, id).run()
    return null
  } catch (e) {
    await env.DB.prepare('UPDATE submissions SET fb_post_id = NULL WHERE id = ? AND fb_post_id = ?').bind(id, `sending:${now}`).run()
    return e instanceof Error ? e.message : String(e)
  }
}

// ---------- 同步到 TG 頻道 ----------

const tgReady = (env: Env) => Boolean(env.TG_BOT_TOKEN && env.TG_CHANNEL_ID)

// 成功回 null, 失敗回錯誤說明. 跟粉專一樣先上鎖, 連按兩下只會發一次.
async function publishToTelegram(env: Env, id: number): Promise<string | null> {
  if (!tgReady(env)) return '還沒設定 TG_CHANNEL_ID.'
  const now = Date.now()
  const lock = await env.DB.prepare(
    "UPDATE submissions SET tg_msg_id = ? WHERE id = ? AND status = 'published' AND (tg_msg_id IS NULL OR (tg_msg_id LIKE 'sending:%' AND CAST(substr(tg_msg_id, 9) AS INTEGER) < ?))",
  ).bind(`sending:${now}`, id, now - 180_000).run()
  if (lock.meta.changes !== 1) {
    const cur = await env.DB.prepare('SELECT tg_msg_id FROM submissions WHERE id = ?').bind(id).first<{ tg_msg_id: string | null }>()
    if (cur?.tg_msg_id && !isSending(cur.tg_msg_id)) return null
    return '這篇正在同步中, 或還沒發布.'
  }
  try {
    const r = (await env.DB.prepare('SELECT id, body, status, created_at, images, post_no FROM submissions WHERE id = ?').bind(id).first<Row>())!
    const text = postText(await loadSettings(env), r, 'other') // 其他平台格式, 不帶 #
    const chat = env.TG_CHANNEL_ID!.trim()
    const api = `https://api.telegram.org/bot${env.TG_BOT_TOKEN!.trim()}`
    const photos: Blob[] = []
    for (const key of parseKeys(r.images)) {
      const obj = await env.IMAGES.get(key)
      if (obj) photos.push(new Blob([await obj.arrayBuffer()], { type: obj.httpMetadata?.contentType ?? 'image/jpeg' }))
    }
    // 圖片說明最多 1024 字; 太長就圖片先發, 文字另外一則
    const captionFits = text.length <= 1024
    let msgId = ''
    if (photos.length) {
      const fd = new FormData()
      fd.set('chat_id', chat)
      if (photos.length === 1) {
        fd.set('photo', photos[0], 'p0.jpg')
        if (captionFits) fd.set('caption', text)
        msgId = String((await tgCall(`${api}/sendPhoto`, fd)).message_id)
      } else {
        fd.set('media', JSON.stringify(photos.map((_, i) => ({ type: 'photo', media: `attach://p${i}`, ...(i === 0 && captionFits ? { caption: text } : {}) }))))
        photos.forEach((p, i) => fd.set(`p${i}`, p, `p${i}.jpg`))
        msgId = String((await tgCall(`${api}/sendMediaGroup`, fd)).message_id)
      }
    }
    if (!photos.length || !captionFits) {
      const fd = new FormData()
      fd.set('chat_id', chat)
      fd.set('text', text)
      const m = String((await tgCall(`${api}/sendMessage`, fd)).message_id)
      msgId ||= m
    }
    await env.DB.prepare('UPDATE submissions SET tg_msg_id = ? WHERE id = ?').bind(msgId, id).run()
    return null
  } catch (e) {
    await env.DB.prepare('UPDATE submissions SET tg_msg_id = NULL WHERE id = ? AND tg_msg_id = ?').bind(id, `sending:${now}`).run()
    return e instanceof Error ? e.message : String(e)
  }
}

async function tgCall(url: string, body: FormData): Promise<{ message_id: number }> {
  const res = await fetch(url, { method: 'POST', body })
  const data = await res.json<{ ok: boolean; result?: { message_id: number } | { message_id: number }[]; description?: string }>()
  if (!data.ok || !data.result) throw new Error(`Telegram 回應錯誤: ${data.description ?? res.status}`)
  return Array.isArray(data.result) ? data.result[0] : data.result
}

async function fbCall(url: string, body: FormData | URLSearchParams): Promise<{ id: string }> {
  const res = await fetch(url, { method: 'POST', body })
  const data = await res.json<{ id?: string; error?: { message: string; code: number } }>()
  if (!res.ok || !data.id) throw new Error(`Facebook 回應錯誤 (${data.error?.code ?? res.status}): ${data.error?.message ?? '沒有回傳貼文 id'}`)
  return { id: data.id }
}

async function saveSettings(env: Env, url: URL, form: FormData): Promise<Response> {
  const stmts = []
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    let v = String(form.get(key) ?? '').trim()
    if (!v) continue
    if (key !== 'post_title' && !key.startsWith('tpl_') && !/^\d{1,6}$/.test(v)) continue // 數字欄位只收數字
    if (key === 'number_digits') v = String(Math.min(8, Math.max(1, Number(v))))
    stmts.push(env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(key, v))
  }
  if (stmts.length) await env.DB.batch(stmts)
  return Response.redirect(`${url.origin}/admin?tab=settings&saved=1`, 303)
}

function settingsForm(s: Settings, saved: boolean): string {
  const field = (k: keyof Settings, hint = '') =>
    `<label>${SETTING_LABELS[k]}<input name="${k}" value="${esc(s[k])}">${hint ? `<span class="small">${hint}</span>` : ''}</label>`
  const no = Number(s.next_no)
  return `
    ${saved ? '<p class="ok">已儲存.</p>' : ''}
    <form method="post" action="/admin/settings" class="settings">
      <h2>發文標題</h2>
      ${field('post_title')}
      ${field('number_digits', '3 → 001, 4 → 0001')}
      ${field('next_no', '下一篇發布時拿到的號碼. 改小可能跟已發布的撞號, 撞號時發布會失敗.')}
      ${field('tpl_facebook', '{名稱} 和 {編號} 會被替換')}
      ${field('tpl_other', '其他平台不帶 #')}
      <p>預覽: 粉專 <b>${esc(postTitle(s, no, 'facebook'))}</b> / 其他平台 <b>${esc(postTitle(s, no, 'other'))}</b></p>
      <h2>自動清理 (每天一次)</h2>
      ${field('keep_rejected_days', '退回後幾天整筆刪除')}
      ${field('keep_pending_days', '一直沒審的稿幾天後刪除')}
      ${field('keep_published_images_days', '發布後幾天刪圖 (文字留著). 之後要同步其他平台, 得在這之前同步.')}
      <button type="submit">儲存</button>
    </form>`
}

async function listTab(env: Env, s: Settings, tab: string, hl: number, fb: boolean, tg: boolean, tgErr: string | null): Promise<string> {
  const order = tab === 'pending' ? 'ASC' : 'DESC' // 待審從最舊的開始看
  const rows = await env.DB.prepare(`SELECT id, body, status, created_at, images, post_no, fb_post_id, tg_msg_id FROM submissions WHERE status = ? ORDER BY id ${order} LIMIT 100`)
    .bind(tab).all<Row>()
  const btn = (r: Row, action: string, label: string, cls = '') =>
    `<form method="post" action="/admin/action" class="inline"><input type="hidden" name="id" value="${r.id}"><input type="hidden" name="tab" value="${tab}"><button name="action" value="${action}" class="${cls}">${label}</button></form>`
  const copy = (r: Row) => `<button type="button" onclick="copyPost(${r.id})">複製貼文</button>`
  const actions: Record<string, (r: Row) => string> = {
    pending: r => btn(r, 'approve', '通過') + btn(r, 'reject', '退回', 'gray'),
    approved: r => (fb ? btn(r, 'publish_fb', '發布到粉專') + btn(r, 'publish', '只配號 (手動貼)', 'gray') : btn(r, 'publish', '發布 (配號)')) + btn(r, 'reject', '退回', 'gray'),
    rejected: r => btn(r, 'approve', '改為通過') + btn(r, 'delete', '永久刪除', 'red'),
    published: r => (fbPosted(r.fb_post_id) ? `<a class="fblink" href="https://www.facebook.com/${esc(r.fb_post_id)}" target="_blank" rel="noopener">看粉專貼文</a>` : '') + copy(r)
      + (tg && !fbPosted(r.tg_msg_id) ? btn(r, 'publish_tg', '補發到 TG 頻道') : '')
      + btn(r, 'unpublish', '撤銷發布 (保留號碼)', 'gray'),
  }
  const hint = tab === 'approved' ? `<p class="small">${fb ? '「發布到粉專」會配號並直接發文 (文字 + 圖片). 「只配號」是給想自己手動貼的情況.' : '按「發布」會配發文編號, 接著到「已發布」複製貼文貼到粉專.'}</p>` : ''
  const list = rows.results.map(r => `
    <div class="card${r.id === hl ? ' hl' : ''}">
      <div class="meta">#${r.id} · ${toTaipei(r.created_at)}${r.post_no != null ? ` · 發文編號 <b>${esc(postTitle(s, r.post_no, 'facebook'))}</b>` : ''}${tab === 'published' && tg ? (fbPosted(r.tg_msg_id) ? ' · TG ✓' : ' · TG 未同步') : ''}</div>
      ${r.id === hl ? `<p class="ok">${fbPosted(r.fb_post_id) ? '已發到粉專.' : '已配號, 按「複製貼文」貼到粉專.'}${tg && fbPosted(r.tg_msg_id) ? ' 已同步到 TG 頻道.' : ''}</p>` : ''}
      ${r.id === hl && tgErr ? `<p class="err">TG 頻道同步失敗: ${esc(tgErr)}. 修好後按「補發到 TG 頻道」.</p>` : ''}
      <div class="body" id="post-${r.id}">${esc(postText(s, r, 'facebook'))}</div>
      ${thumbs(r)}
      <div>${actions[tab](r)}</div>
    </div>`).join('') || '<p class="small">目前沒有稿件.</p>'
  return hint + list
}

const ADMIN_SCRIPT = `
  <dialog id="lb" onclick="if (event.target === this) this.close()">
    <img id="lb-img" alt="">
    <div class="lb-bar">
      <button type="button" onclick="step(-1)">‹ 上一張</button>
      <span id="lb-n"></span>
      <button type="button" onclick="step(1)">下一張 ›</button>
      <a id="lb-dl" download>下載</a>
      <button type="button" class="gray" onclick="lb.close()">關閉</button>
    </div>
  </dialog>
  <script>
    function copyPost(id) {
      navigator.clipboard.writeText(document.getElementById('post-' + id).innerText)
        .then(() => alert('已複製, 去粉專貼上吧'), () => alert('複製失敗, 請手動選取'))
    }
    // 看圖: 點縮圖放大, 左右鍵或按鈕換張, Esc 或點背景關閉
    const lb = document.getElementById('lb')
    let group = [], cur = 0
    function viewer(img) { group = [...img.parentElement.querySelectorAll('img')]; show(+img.dataset.i); lb.showModal() }
    function show(i) {
      cur = (i + group.length) % group.length
      const g = group[cur]
      document.getElementById('lb-img').src = g.src
      document.getElementById('lb-n').textContent = (cur + 1) + ' / ' + group.length
      const dl = document.getElementById('lb-dl'); dl.href = g.src; dl.download = g.dataset.dl
    }
    function step(d) { show(cur + d) }
    document.addEventListener('keydown', e => { if (lb.open && e.key === 'ArrowLeft') step(-1); if (lb.open && e.key === 'ArrowRight') step(1) })
  </script>`

// 縮圖, 點一下在頁面上放大瀏覽 (已清過 EXIF)
function thumbs(r: Row): string {
  const keys = parseKeys(r.images)
  if (!keys.length) return ''
  return `<div class="thumbs" data-post="${r.id}">${keys.map((k, i) =>
    `<img src="/admin/img/${k}" alt="圖 ${i + 1}" data-i="${i}" data-dl="${r.id}-${i + 1}.${k.split('.').pop()}" onclick="viewer(this)">`).join('')}</div>`
}

// D1 存的是 UTC, 顯示成台灣時間
function toTaipei(utc: string): string {
  const d = new Date(utc.replace(' ', 'T') + 'Z')
  return d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })
}

async function authorized(req: Request, password: string): Promise<boolean> {
  const h = req.headers.get('authorization') ?? ''
  if (!h.startsWith('Basic ')) return false
  let pass = ''
  try { pass = atob(h.slice(6)).split(':').slice(1).join(':') } catch { return false }
  // 比對雜湊, 避免用回應時間猜密碼
  const [a, b] = await Promise.all([sha256(pass), sha256(password)])
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ---------- 頁面 ----------

function submitPage(env: Env, error = '', body = ''): string {
  const turnstile = env.TURNSTILE_SITE_KEY
    ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
      <div class="cf-turnstile" data-sitekey="${esc(env.TURNSTILE_SITE_KEY)}"></div>`
    : ''
  return page(SITE_NAME, `
    ${error ? `<p class="err">${esc(error)}</p>` : ''}
    <form method="post" action="/submit" enctype="multipart/form-data" id="f" class="panel">
      <textarea name="body" id="body" maxlength="${MAX_LENGTH}" placeholder="想說什麼都可以. 不用登入, 不會記錄你的身分.">${esc(body)}</textarea>
      <div class="row"><span class="small">文字和圖片至少一樣</span><span class="small" id="count">0 / ${MAX_LENGTH}</span></div>
      <div class="picker">
        <div class="small">圖片 (選填, 最多 ${MAX_IMAGES} 張, 位置等拍攝資訊會自動移除)</div>
        <div class="pick-grid" id="grid">
          <label class="add" id="add"><span>＋</span>新增圖片<input type="file" accept="image/*" multiple id="pick" hidden></label>
        </div>
        <input type="file" name="images" multiple id="imgs" hidden>
      </div>
      ${turnstile}
      <button type="submit" id="send" class="block">送出投稿</button>
    </form>
    <footer>本站不蒐集姓名, 帳號, IP 等身分資料<br><a href="/privacy">隱私與投稿規範</a> · <a href="/withdraw">撤回投稿</a></footer>
    <script>
      const MAX = ${MAX_IMAGES}
      const f = document.getElementById('f'), body = document.getElementById('body'), count = document.getElementById('count')
      const grid = document.getElementById('grid'), add = document.getElementById('add'), pick = document.getElementById('pick')
      const imgs = document.getElementById('imgs'), send = document.getElementById('send')
      let files = []
      const upd = () => { count.textContent = body.value.length + ' / ${MAX_LENGTH}' }
      body.addEventListener('input', upd); upd()

      // 選圖: 可以分次加, 有預覽, 可以刪
      function render() {
        grid.querySelectorAll('.ph').forEach(e => e.remove())
        files.forEach((file, i) => {
          const d = document.createElement('div'); d.className = 'ph'
          const img = document.createElement('img'); img.src = URL.createObjectURL(file); img.alt = ''
          const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.title = '移除'
          x.onclick = () => { files.splice(i, 1); render() }
          d.append(img, x); grid.insertBefore(d, add)
        })
        add.style.display = files.length >= MAX ? 'none' : ''
      }
      pick.addEventListener('change', () => {
        const picked = [...pick.files]
        if (files.length + picked.length > MAX) alert('圖片最多 ' + MAX + ' 張, 多的不會加入')
        files = files.concat(picked).slice(0, MAX); pick.value = ''; render()
      })

      // 送出前在瀏覽器裡把圖片重畫一次: 拿掉 EXIF/GPS, 修正方向, 縮到 2048px 以內, 轉成 JPEG.
      // 伺服器會再清一次, 這裡做不到 (例如舊瀏覽器) 也不影響安全.
      async function clean(file, i) {
        try {
          const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
          const s = Math.min(1, 2048 / Math.max(bmp.width, bmp.height))
          const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s)
          c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)
          const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9))
          return blob ? new File([blob], 'image' + (i + 1) + '.jpg', { type: 'image/jpeg' }) : file
        } catch { return file }
      }
      f.addEventListener('submit', async e => {
        e.preventDefault()
        if (!body.value.trim() && !files.length) { alert('寫點什麼, 或附一張圖吧'); return }
        send.disabled = true; send.textContent = files.length ? '處理圖片中...' : '送出中...'
        if (files.length) {
          const dt = new DataTransfer()
          const ok = window.createImageBitmap ? await Promise.all(files.map(clean)) : files
          ok.forEach(x => dt.items.add(x))
          imgs.files = dt.files
        }
        send.textContent = '送出中...'
        f.submit()
      })
    </script>`, { hero: `<header class="hero"><div class="logo">📮</div><h1>${esc(SITE_NAME)}</h1><p>匿名投稿到粉專, 不記錄你的身分</p></header>` })
}

async function privacyPage(env: Env): Promise<string> {
  const s = await loadSettings(env)
  return page('隱私與投稿規範', `<div class="panel">
    <h2 style="margin-top:0">我們不蒐集你的身分</h2>
    <ul class="clean">
      <li>投稿不需要登入, 也不會要你填姓名, email, 電話.</li>
      <li>本站的資料庫不儲存你的 IP. 網站架在 Cloudflare 上, 連線經過 Cloudflare 時, 他們的系統可能有短期的技術與安全紀錄, 這部分不在本站控制內.</li>
      <li>圖片在你的瀏覽器裡會先重畫一次, 上傳後伺服器再清一次, 拍攝位置 (GPS), 機型, 拍攝時間等資訊都會移除.</li>
      <li>人機驗證使用 Cloudflare Turnstile, 不用解圖形驗證碼.</li>
    </ul>
    <h2>資料保留多久</h2>
    <ul class="clean">
      <li>未審核的稿件: ${esc(s.keep_pending_days)} 天後自動刪除.</li>
      <li>未通過的稿件: ${esc(s.keep_rejected_days)} 天後自動刪除.</li>
      <li>已發布的稿件: 圖片在 ${esc(s.keep_published_images_days)} 天後刪除, 文字保留作為發文紀錄.</li>
    </ul>
    <h2>撤回</h2>
    <p>投稿成功後會給你一組撤回碼, 本站只存它的雜湊值, 無法從資料庫反推回你. 發布前可以到 <a href="/withdraw">撤回頁</a> 自行撤回, 撤回會連同圖片整筆刪除. 已發布的請私訊粉專處理.</p>
    <h2>不接受的內容</h2>
    <p>以下內容會被退回: 個人資料 (姓名, 電話, 地址, 帳號等可辨識他人的資訊), 未經同意曝光他人, 威脅, 騷擾, 仇恨言論, 色情或裸露, 違法或侵權內容.</p>
    </div>
    <footer><a href="/">回投稿頁</a></footer>`, { hero: '<header class="hero"><div class="logo">🔒</div><h1>隱私與投稿規範</h1></header>' })
}

function withdrawPage(error = ''): string {
  return page('撤回投稿', `
    ${error ? `<p class="err">${esc(error)}</p>` : ''}
    <form method="post" action="/withdraw" class="panel">
      <input name="code" required placeholder="輸入撤回碼" autocomplete="off" autocapitalize="characters">
      <button type="submit" class="block">撤回</button>
      <p class="small">只能撤回還沒發布的稿件, 撤回會連同圖片整筆刪除.</p>
    </form>
    <footer><a href="/">回投稿頁</a></footer>`, { hero: '<header class="hero"><div class="logo">↩️</div><h1>撤回投稿</h1></header>' })
}

function page(title: string, content: string, opts: { wide?: boolean; hero?: string } = {}): string {
  return `<!doctype html>
<html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
  :root {
    --bg: #f4f1ec; --panel: #fffdfa; --text: #2b2622; --muted: #8a8079; --line: #e6dfd6;
    --accent: #d9534f; --accent-text: #fff; --accent-soft: #fbe9e7; --ok: #2f8f5b; --err: #c0392b; --gray: #8a8079;
    --radius: 14px; --shadow: 0 1px 2px rgba(60,40,20,.06), 0 8px 24px rgba(60,40,20,.06);
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1b1917; --panel: #25221f; --text: #ece6df; --muted: #a39a91; --line: #3a3530;
      --accent: #ef6f6a; --accent-soft: #3a2725; --ok: #5cc28a; --err: #ff7b6e; --gray: #6f6760; --shadow: none; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); line-height: 1.7;
    font-family: system-ui, -apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif; }
  .wrap { max-width: ${opts.wide ? 880 : 600}px; margin: 0 auto; padding: 32px 16px 48px; }
  header.hero { text-align: center; margin-bottom: 20px; }
  header.hero .logo { font-size: 2.4rem; line-height: 1; }
  h1 { font-size: 1.6rem; margin: 8px 0 4px; letter-spacing: .02em; }
  header.hero p { margin: 0; color: var(--muted); }
  h2 { font-size: 1.1rem; margin: 1.6em 0 .4em; }
  a { color: var(--accent); }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 20px; box-shadow: var(--shadow); }
  textarea, input:not([type=file]):not([type=hidden]) { width: 100%; padding: 12px 14px; font: inherit; color: var(--text);
    background: var(--bg); border: 1px solid var(--line); border-radius: 10px; outline: none; transition: border-color .15s; }
  textarea:focus, input:focus { border-color: var(--accent); }
  textarea { min-height: 200px; resize: vertical; }
  button, .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 10px 20px; font: inherit; font-weight: 600;
    border: 0; border-radius: 10px; background: var(--accent); color: var(--accent-text); cursor: pointer; text-decoration: none; transition: filter .15s, transform .05s; }
  button:hover, .btn:hover { filter: brightness(1.05); } button:active { transform: translateY(1px); }
  button:disabled { opacity: .6; cursor: wait; }
  button.block { width: 100%; padding: 14px; font-size: 1.05rem; margin-top: 16px; }
  button.gray { background: var(--gray); } button.red { background: var(--err); }
  button.ghost { background: transparent; color: var(--accent); border: 1px solid var(--line); }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 6px; }
  .small { font-size: .85rem; color: var(--muted); }
  .err { color: var(--err); background: var(--accent-soft); padding: 10px 14px; border-radius: 10px; }
  .ok { color: var(--ok); }
  footer { text-align: center; margin-top: 24px; font-size: .85rem; color: var(--muted); }
  footer a { color: var(--muted); }
  /* 投稿頁: 圖片 */
  .picker { margin-top: 16px; }
  .pick-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); gap: 8px; margin-top: 8px; }
  .pick-grid .ph { position: relative; aspect-ratio: 1; border-radius: 10px; overflow: hidden; background: var(--bg); border: 1px solid var(--line); }
  .pick-grid .ph img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .pick-grid .ph button { position: absolute; top: 4px; right: 4px; width: 26px; height: 26px; padding: 0; border-radius: 50%; background: rgba(0,0,0,.55); font-size: 1rem; }
  .pick-grid label.add { aspect-ratio: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; border: 2px dashed var(--line);
    border-radius: 10px; color: var(--muted); cursor: pointer; font-size: .85rem; }
  .pick-grid label.add span { font-size: 1.8rem; line-height: 1; }
  .pick-grid label.add:hover { border-color: var(--accent); color: var(--accent); }
  .cf-turnstile { margin-top: 16px; }
  /* 成功頁 */
  .done { text-align: center; }
  .done .icon { font-size: 3rem; }
  .code { font: 600 1.7rem ui-monospace, Menlo, Consolas, monospace; letter-spacing: .18em; background: var(--bg); padding: 14px; border-radius: 10px;
    border: 2px dashed var(--line); margin: 8px 0; user-select: all; }
  ul.clean { padding-left: 1.2em; } ul.clean li { margin: 4px 0; }
  /* 後台 */
  nav { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; position: sticky; top: 0; padding: 10px 0; background: var(--bg); z-index: 1; }
  .tab { padding: 6px 14px; border-radius: 999px; background: var(--panel); border: 1px solid var(--line); color: var(--text); text-decoration: none; font-size: .9rem; }
  .tab.on { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 18px; margin: 12px 0; box-shadow: var(--shadow); }
  .card.hl { border: 2px solid var(--accent); }
  .card .meta { font-size: .85rem; color: var(--muted); }
  .card .body { white-space: pre-wrap; margin: 8px 0; }
  .card button { margin: 6px 8px 0 0; padding: 7px 14px; font-size: .9rem; }
  .inline { display: inline; }
  a.fblink { margin-right: 8px; font-size: .9rem; }
  .thumbs { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
  .thumbs img { width: 96px; height: 96px; object-fit: cover; border-radius: 8px; border: 1px solid var(--line); cursor: zoom-in; }
  dialog#lb { max-width: 96vw; max-height: 96vh; padding: 12px; border: 0; border-radius: 12px; background: #111; color: #eee; }
  dialog#lb::backdrop { background: rgba(0,0,0,.8); }
  #lb-img { display: block; max-width: 92vw; max-height: 80vh; margin: 0 auto; object-fit: contain; }
  .lb-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: center; margin-top: 8px; }
  .lb-bar button { margin: 0; padding: 6px 14px; }
  .lb-bar a { color: #93c5fd; }
  form.settings label { display: block; margin: 12px 0; font-weight: 600; }
  form.settings label input { margin-top: 4px; font-weight: normal; }
  form.settings .small { display: block; font-weight: normal; }
</style></head>
<body><div class="wrap">
${opts.hero ?? `<h1>${esc(title)}</h1>`}
${content}
</div></body></html>`
}

// ---------- 工具 ----------

function html(s: string, status = 200): Response {
  return new Response(s, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

// 12 碼撤回碼, 去掉容易看錯的 0 O 1 I L
function newCode(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, b => chars[b % chars.length]).join('')
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('')
}
