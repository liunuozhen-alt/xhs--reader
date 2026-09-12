import { fetchDirect, fetchTikHubImage, fetchComments, fetchTikHubVideo, getTikHubApiKey, CORS_HEADERS, json } from './_lib/xhs.mts'

export default async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ ok: false, error: 'Method Not Allowed' }, 405)

  try {
    const body = await req.json() as any

    console.log('[xhs-card] request body:', JSON.stringify(body))

    let noteId: string = body.noteId || ''
    const shareText: string = body.shareText || ''
    let shareUrl = ''

    const commentCount: number = body.commentCount || 10
    const commentSort: string = body.commentSort || 'latest_v2'
    const fetchCommentFlag: boolean = body.fetchComments !== false

    if (!noteId && shareText) {
      const m1 = shareText.match(/https?:\/\/xhslink\.cn\/[a-zA-Z0-9/]+/)
      if (m1) shareUrl = m1[0]

      const m2 = shareText.match(/xiaohongshu\.com\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/)
      if (m2) noteId = m2[1]
    }

    console.log('[xhs-card] parsed:', {
      noteId,
      shareUrl
    })

    if (!shareUrl && !noteId) {
      return json({ ok: false, error: '缺少参数' })
    }

    let note = null

    try {
      note = await fetchDirect(noteId, shareUrl, commentCount)
      console.log('[xhs-card] fetchDirect:', note ? 'success' : 'null')
    } catch (e: any) {
      console.log('[xhs-card] fetchDirect error:', e?.message || String(e))
    }

    const apiKey = getTikHubApiKey()

    if (!note && apiKey) {
      try {
        note = await fetchTikHubImage(noteId, shareUrl || shareText)
        console.log('[xhs-card] tikhub:', note ? 'success' : 'null')
      } catch (e: any) {
        console.log('[xhs-card] tikhub error:', e?.message || String(e))
      }
    }

    if (!note) {
      console.log('[xhs-card] all failed', {
        noteId,
        shareUrl,
        hasApiKey: !!apiKey
      })

      return json({ ok: false, error: '无法获取笔记' })
    }

    const rid = note.noteId || noteId

    if (
      rid &&
      fetchCommentFlag &&
      apiKey &&
      (!note.comments || note.comments.length === 0)
    ) {
      try {
        const cmts = await fetchComments(rid, commentCount, commentSort)
        if (cmts.length > 0) note.comments = cmts
      } catch (e: any) {
        console.log('[xhs-card] comments error:', e?.message || String(e))
      }
    }

    if (note.type === 'video' && !note.videoUrl && rid && apiKey) {
      try {
        note.videoUrl = await fetchTikHubVideo(rid)
      } catch (e: any) {
        console.log('[xhs-card] video error:', e?.message || String(e))
      }
    }

    return json({
      ok: true,
      note,
      source: note._source || 'unknown'
    })

  } catch (e: any) {
    console.log('[xhs-card] fatal error:', e?.message || String(e))
    return json({
      ok: false,
      error: e.message
    })
  }
}
