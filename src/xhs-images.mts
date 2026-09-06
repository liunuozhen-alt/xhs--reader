import { UA, CORS_HEADERS, json } from './_lib/xhs.mts'

export default async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ ok: false, error: 'Method Not Allowed' }, 405)
  try {
    const body = await req.json() as any
    if (!body.urls) return json({ ok: false, error: '缺少urls' })
    const urls: string[] = body.urls.slice(0, 10)
    const results = await Promise.all(
      urls.map(async (u) => {
        try {
          const rp = await fetch(u, { headers: { 'User-Agent': UA, Referer: 'https://www.xiaohongshu.com/' } })
          if (!rp.ok) return null
          const buf = await rp.arrayBuffer()
          const bytes = new Uint8Array(buf)
          let bin = ''
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
          return { url: u, base64: btoa(bin), mime: rp.headers.get('content-type') || 'image/webp' }
        } catch { return null }
      }),
    )
    return json({ ok: true, images: results.filter(Boolean) })
  } catch (e: any) {
    return json({ ok: false, error: e.message })
  }
}
