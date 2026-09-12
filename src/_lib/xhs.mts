// Shared helpers for the Xiaohongshu (小红书) note-fetching functions.
// TikHub API key is optional. Direct note pages are scraped first; embedded comments
// and the public web comment endpoint are attempted before TikHub is used as fallback.
export type WorkerEnv = { TIKHUB_API_KEY?: string }

let runtimeEnv: WorkerEnv = {}
export function setRuntimeEnv(env: WorkerEnv) { runtimeEnv = env || {} }
export function getTikHubApiKey() { return runtimeEnv.TIKHUB_API_KEY || '' }
export const TIKHUB_API_KEY = ''
export const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

export function extractTitle(title: string | undefined, desc: string | undefined) {
  if (title) return title
  if (!desc) return ''
  let clean = desc.replace(/\[话题\]/g, '').trim()
  if (clean.length > 30) clean = clean.slice(0, 30) + '...'
  return clean
}

export interface NoteComment {
  user: string
  content: string
  ipLocation: string
  likeCount: number
}

export interface Note {
  _source?: string
  noteId: string
  title: string
  author: string
  desc: string
  images: string[]
  imageCount: number
  likedCount: number
  commentCount: number
  collectedCount: number
  comments: NoteComment[]
  tags?: string[]
  type: string
  videoUrl: string | null
  url: string
}

async function tikhubFetch(url: string) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + getTikHubApiKey() } })
  return r.json() as Promise<any>
}

export async function fetchDirect(noteId: string, shareUrl: string, commentCount = 10): Promise<Note | null> {
  if (!noteId && shareUrl) {
    const r = await fetch(shareUrl, { headers: XHS_HEADERS, redirect: 'follow' })
    const m = r.url.match(/xiaohongshu\.com\/(explore|discovery\/item)\/([a-zA-Z0-9]+)/)
    if (m) noteId = m[2]
    if (!noteId) return null
    const html = await r.text()
    console.log('[xhs] final url:', r.url, 'status:', r.status, 'html:', html.slice(0, 300))
    const note = parsePage(html, noteId, r.url, commentCount)
    return await enrichDirectComments(note, noteId, r.url, html, commentCount)
  }
  if (noteId) {
    const r2 = await fetch('https://www.xiaohongshu.com/explore/' + noteId, {
      headers: XHS_HEADERS,
      redirect: 'follow',
    })
    const html = await r2.text()
    console.log('[xhs] explore url:', r2.url, 'status:', r2.status, 'html:', html.slice(0, 300))
    const note = parsePage(html, noteId, r2.url, commentCount)
    return await enrichDirectComments(note, noteId, r2.url, html, commentCount)
  }
  return null
}

function parsePage(html: string, noteId: string, finalUrl: string, commentCount = 10): Note | null {
  const m = html.match(/window\.__INITIAL_STATE__\s*=\s*(.+?)<\/script>/s)
  if (!m) return null
  let state: any
  try {
    state = new Function('return ' + m[1].trim().replace(/;$/, ''))()
  } catch {
    try {
      state = JSON.parse(
        m[1]
          .replace(/\\u002F/g, '/')
          .replace(/:\s*undefined/g, ':null')
          .trim()
          .replace(/;$/, ''),
      )
    } catch {
      return null
    }
  }

  let nd: any = null
  if (state.noteData) {
    nd = state.noteData.data?.noteData || state.noteData.normalNotePreloadData?.noteData || null
    if (!nd && state.noteData.data && typeof state.noteData.data === 'object') {
      for (const k of Object.keys(state.noteData.data)) {
        if (state.noteData.data[k]?.title) {
          nd = state.noteData.data[k]
          break
        }
      }
    }
  }
  if (!nd && state.note?.noteDetailMap) {
    const ks = Object.keys(state.note.noteDetailMap)
    if (ks[0]) nd = state.note.noteDetailMap[ks[0]].note
  }
  if (!nd || (!nd.title && !nd.desc)) return null

  let author = ''
  if (nd.user) author = nd.user.nickName || nd.user.nickname || nd.user.name || nd.user.nick_name || ''
  if (!author && nd.noteUser) author = nd.noteUser.nickName || nd.noteUser.nickname || nd.noteUser.name || ''
  if (!author && state.user) author = state.user.nickName || state.user.nickname || state.user.name || ''
  if (!author) {
    const am = html.match(/name="author"[^>]+content="([^"]*)"/) || html.match(/content="([^"]*)"[^>]+name="author"/)
    if (am) author = am[1]
  }

  const rawDesc = nd.desc || ''
  const title = extractTitle(nd.title, rawDesc)

  const imgs: string[] = (nd.imageList || [])
    .map((i: any) => {
      if (i.infoList?.length > 0) {
        const best = i.infoList.find((x: any) => x.imageScene === 'WB_DFT') || i.infoList[i.infoList.length - 1]
        if (best?.url) {
          let u = best.url
          if (u.startsWith('//')) u = 'https:' + u
          return u
        }
      }
      let u = i.urlDefault || i.url || ''
      if (u.startsWith('//')) u = 'https:' + u
      return u
    })
    .filter(Boolean)

  let videoUrl: string | null = null
  if (nd.video) {
    try {
      videoUrl = nd.video.media?.stream?.h264?.[0]?.masterUrl || nd.video.media?.stream?.h264?.[0]?.master_url || null
      if (!videoUrl && nd.video.consumer?.originVideoKey) videoUrl = 'https://sns-video-bd.xhscdn.com/' + nd.video.consumer.originVideoKey
      if (!videoUrl) videoUrl = nd.video.url || null
    } catch {}
  }

  const cmts = extractEmbeddedComments(state, commentCount)

  return {
    _source: 'direct',
    noteId,
    title,
    author,
    desc: rawDesc.replace(/\[话题\]/g, '').trim(),
    images: imgs,
    imageCount: imgs.length,
    likedCount: nd.interactInfo?.likedCount || 0,
    commentCount: nd.interactInfo?.commentCount || 0,
    collectedCount: nd.interactInfo?.collectedCount || 0,
    comments: cmts,
    type: nd.type || (videoUrl ? 'video' : 'normal'),
    videoUrl,
    url: finalUrl || 'https://www.xiaohongshu.com/explore/' + noteId,
  }
}

function normalizeComment(c: any): NoteComment | null {
  if (!c || typeof c !== 'object') return null
  const userInfo = c.userInfo || c.user_info || c.user || c.user_info_data || {}
  const content = c.content || c.commentContent || c.text || ''
  if (typeof content !== 'string' || !content.trim()) return null
  return {
    user: userInfo.nickName || userInfo.nickname || userInfo.name || c.nickname || '匿名',
    content: content.trim(),
    ipLocation: c.ipLocation || c.ip_location || userInfo.ipLocation || '',
    likeCount: Number(c.likeCount ?? c.like_count ?? 0) || 0,
  }
}

function extractEmbeddedComments(state: any, limit: number): NoteComment[] {
  const out: NoteComment[] = []
  const seen = new Set<any>()
  const max = Math.max(1, Math.min(Number(limit) || 10, 100))

  const addArray = (arr: any[]) => {
    for (const item of arr) {
      const c = normalizeComment(item)
      if (c) out.push(c)
      if (out.length >= max) return
    }
  }

  const preferred = [
    state?.commentData?.comments,
    state?.commentData?.data?.comments,
    state?.commentData?.commentList,
    state?.commentData?.commentListData?.comments,
    state?.noteData?.data?.comments,
    state?.noteData?.data?.noteData?.comments,
    state?.noteData?.normalNotePreloadData?.comments,
    state?.noteData?.normalNotePreloadData?.noteData?.comments,
  ]
  for (const arr of preferred) {
    if (Array.isArray(arr)) {
      addArray(arr)
      if (out.length >= max) return out
    }
  }

  function walk(value: any, depth: number) {
    if (out.length >= max || depth > 8 || value == null || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      addArray(value)
      if (out.length >= max) return
      for (const item of value) walk(item, depth + 1)
      return
    }
    const keys = Object.keys(value)
    for (const key of keys) {
      if (/comment|comments|commentlist|commentdata/i.test(key)) {
        const v = value[key]
        if (Array.isArray(v)) addArray(v)
        else walk(v, depth + 1)
        if (out.length >= max) return
      }
    }
    for (const key of keys) {
      walk(value[key], depth + 1)
      if (out.length >= max) return
    }
  }

  walk(state, 0)
  return out.slice(0, max)
}

function extractXsecToken(html: string, finalUrl: string): string {
  try {
    const u = new URL(finalUrl)
    const token = u.searchParams.get('xsec_token')
    if (token) return token
  } catch {}
  const patterns = [
    /["']xsec_token["']\s*[:=]\s*["']([^"']+)["']/i,
    /["']xsecToken["']\s*[:=]\s*["']([^"']+)["']/i,
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m?.[1]) return m[1]
  }
  return ''
}

async function fetchWebComments(noteId: string, xsecToken: string, count: number, referer: string): Promise<NoteComment[]> {
  const limit = Math.max(1, Math.min(Number(count) || 10, 100))
  const params = new URLSearchParams({
    note_id: noteId,
    cursor: '',
    top_comment_id: '',
    image_formats: 'jpg,webp,avif',
  })
  if (xsecToken) params.set('xsec_token', xsecToken)
  const url = 'https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?' + params.toString()
  const r = await fetch(url, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': UA,
      Origin: 'https://www.xiaohongshu.com',
      Referer: referer || 'https://www.xiaohongshu.com/',
    },
  })
  if (!r.ok) return []
  const d = await r.json() as any
  const data = d?.data || d?.result?.data || {}
  const raw = data.comments || data.comment_list || data.items || data.commentList || []
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeComment).filter(Boolean).slice(0, limit) as NoteComment[]
}

async function enrichDirectComments(note: Note | null, noteId: string, finalUrl: string, html: string, count: number): Promise<Note | null> {
  if (!note || note.comments.length > 0 || note.commentCount <= 0) return note
  const token = extractXsecToken(html, finalUrl)
  try {
    const cmts = await fetchWebComments(noteId, token, count, finalUrl)
    if (cmts.length > 0) note.comments = cmts
  } catch {}
  return note
}

export async function fetchTikHubImage(noteId: string, shareText: string): Promise<Note> {
  let u = 'https://api.tikhub.dev/api/v1/xiaohongshu/app_v2/get_image_note_detail?'
  if (noteId) {
    u += 'note_id=' + encodeURIComponent(noteId)
  } else {
    const m = shareText.match(/https?:\/\/xhslink\.cn\/[a-zA-Z0-9/]+/)
    u += 'share_text=' + encodeURIComponent(m ? m[0] : shareText)
  }
  const d = await tikhubFetch(u)
  if (d.code !== 200 || !d.data || !d.data.success) throw new Error(d.message || 'API失败')

  const n = d.data.data[0].note_list[0]
  const rawDesc = n.desc || ''
  const title = extractTitle(n.title, rawDesc)
  const imgs: string[] = (n.images_list || []).map((i: any) => i.url || i.original || '').filter(Boolean)
  const tags: string[] = (n.hash_tag || []).map((t: any) => t.name).filter(Boolean)

  return {
    _source: 'tikhub',
    noteId: n.id || noteId || '',
    title,
    author: n.user?.nickname || n.user?.nickName || '',
    desc: rawDesc.replace(/\[话题\]/g, '').trim(),
    images: imgs,
    imageCount: imgs.length,
    likedCount: n.liked_count || 0,
    commentCount: n.comments_count || 0,
    collectedCount: n.collected_count || 0,
    comments: [],
    tags,
    type: n.type || 'normal',
    videoUrl: null,
    url: n.share_info?.link || '',
  }
}

export async function fetchComments(noteId: string, count: number, sort: string): Promise<NoteComment[]> {
  const u =
    'https://api.tikhub.dev/api/v1/xiaohongshu/app_v2/get_note_comments?note_id=' +
    encodeURIComponent(noteId) +
    '&index=0&sort_strategy=' +
    encodeURIComponent(sort)
  const d = await tikhubFetch(u)
  if (d.code !== 200 || !d.data?.data) return []
  const cmts = d.data.data.comments || []
  return cmts.slice(0, count).map((c: any) => ({
    user: c.user_info?.nickname || c.user_info?.nickName || '匿名',
    content: c.content || '',
    ipLocation: c.ip_location || '',
    likeCount: c.like_count || 0,
  }))
}

export async function fetchTikHubVideo(noteId: string): Promise<string | null> {
  const u = 'https://api.tikhub.dev/api/v1/xiaohongshu/app_v2/get_video_note_detail?note_id=' + encodeURIComponent(noteId)
  const d = await tikhubFetch(u)
  if (d.code !== 200 || !d.data || !d.data.success) throw new Error(d.message || '视频API失败')
  const s = JSON.stringify(d.data)
  const i = s.indexOf('master_url')
  if (i === -1) return null
  const m = s.substring(i).match(/master_url":"([^"]+)"/)
  return m ? m[1] : null
}

export async function doSearch(keyword: string): Promise<any[] | null> {
  try {
    const u =
      'https://api.tikhub.dev/api/v1/xiaohongshu/app_v2/search_notes?keyword=' +
      encodeURIComponent(keyword) +
      '&page=1&sort_type=general'
    const d = await tikhubFetch(u)
    if (d.code !== 200 || !d.data?.data) return null
    return d.data.data.items || []
  } catch {
    return null
  }
}
