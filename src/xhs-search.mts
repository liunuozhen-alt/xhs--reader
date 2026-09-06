import { doSearch, extractTitle, getTikHubApiKey, CORS_HEADERS, json } from './_lib/xhs.mts'

export default async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ ok: false, error: 'Method Not Allowed' }, 405)
  try {
    const body = await req.json() as any
    const keyword: string = body.keyword || ''
    const count: number = body.count || 5
    if (!keyword) return json({ ok: false, error: '缺少keyword' })
    if (!getTikHubApiKey()) return json({ ok: false, error: '搜索功能需要TikHub API Key' })

    let items = await doSearch(keyword)
    if ((!items || items.length === 0) && keyword.length > 4) items = await doSearch(keyword.substring(0, Math.ceil(keyword.length / 2)))
    if ((!items || items.length === 0) && keyword.length > 2) items = await doSearch(keyword.substring(0, 2))
    if (!items || items.length === 0) return json({ ok: false, error: '没有找到相关内容' })

    const results = items.slice(0, count).map((item: any) => {
      const note = item.note || {}
      const imgs: string[] = (note.images_list || []).map((i: any) => i.url || i.original || '').filter(Boolean)
      return {
        noteId: note.id || '', title: extractTitle(note.title, note.desc),
        author: note.user?.nickname || note.user?.nickName || note.user?.name || '',
        desc: (note.desc || '').replace(/\[话题\]/g, '').trim(), cover: imgs[0] || '',
        imageCount: imgs.length, likedCount: note.liked_count || 0,
        commentCount: note.comments_count || 0, collectedCount: note.collected_count || 0,
        type: note.type || 'normal', url: 'https://www.xiaohongshu.com/explore/' + (note.id || ''),
      }
    }).filter((r: any) => r.noteId)

    return json({ ok: true, results, total: items.length })
  } catch (e: any) {
    return json({ ok: false, error: e.message })
  }
}
