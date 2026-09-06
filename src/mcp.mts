import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import {
  fetchDirect,
  fetchTikHubImage,
  fetchComments,
  fetchTikHubVideo,
  doSearch,
  extractTitle,
  getTikHubApiKey,
} from './_lib/xhs.mts'

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
  'Access-Control-Allow-Headers':
    'Content-Type, Accept, Authorization, MCP-Protocol-Version, MCP-Session-Id',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
}

export default async function handleMcp(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (req.method === 'GET') {
    return new Response(null, {
      status: 405,
      headers: { ...CORS_HEADERS, Allow: 'GET, POST, OPTIONS, DELETE' },
    })
  }

  try {
    const server = new McpServer({ name: 'xiaohongshu-reader', version: '1.0.0' })

    server.registerTool(
      'read_xiaohongshu',
      {
        description:
          '读取小红书笔记，返回标题、作者、正文、图片、点赞/收藏/评论数、标签和视频地址等信息。可传入分享链接文本或笔记 ID。先从小红书页面及其公开 Web 评论接口读取评论，无需 TikHub；TikHub 仅作为增强/fallback。',
        inputSchema: {
          url: z.string().describe('小红书笔记的分享链接/分享文本，或笔记 ID'),
          fetchComments: z
            .boolean()
            .optional()
            .describe('是否获取评论，默认 true'),
          commentCount: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe('获取评论的数量，默认 10'),
          includeImages: z
            .boolean()
            .optional()
            .describe('是否把笔记图片作为真正的 MCP 图片内容返回，默认 true'),
          maxImages: z
            .number()
            .int()
            .min(1)
            .max(12)
            .optional()
            .describe('最多返回多少张图片，默认 8'),
        },
      },
      async (args) => {
        const result = await readNote(args)
        const content: any[] = []

        if (result.ok && result.note && args.includeImages !== false) {
          const maxImages = Math.max(1, Math.min(args.maxImages || 8, 12))
          const imageContents = await fetchMcpImages(
            result.note.images.slice(0, maxImages),
          )

          // Put native MCP image blocks FIRST.
          content.push(...imageContents)
        }

        content.push({
          type: 'text',
          text: JSON.stringify(result, null, 2),
        })

        return { content }
      },
    )

    server.registerTool(
      'test_mcp_image',
      {
        description:
          '测试 MCP 是否能把真实图片内容传递给 ChatGPT 视觉能力。',
        inputSchema: {},
      },
      async () => {
        const imageUrl = 'https://placehold.co/600x400/png'
        const response = await fetch(imageUrl)

        if (!response.ok) {
          throw new Error('测试图片获取失败: ' + response.status)
        }

        const buffer = await response.arrayBuffer()
        const bytes = new Uint8Array(buffer)

        let binary = ''
        const chunkSize = 0x8000

        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(
            ...bytes.subarray(i, i + chunkSize),
          )
        }

        return {
          content: [
            {
              type: 'image',
              data: btoa(binary),
              mimeType:
                response.headers.get('content-type') || 'image/png',
            },
            {
              type: 'text',
              text: 'MCP 图片测试：如果视觉链路正常，你应该能够直接描述这张测试图片的视觉内容。',
            },
          ],
        }
      },
    )


    server.registerTool(
      'diagnose_xhs_image',
      {
        description:
          '诊断小红书第一张图片是否能被 Worker 成功下载。',
        inputSchema: {
          url: z.string().describe('小红书笔记的分享链接/分享文本，或笔记 ID'),
        },
      },
      async (args) => {
        const result = await readNote({
          url: args.url,
          fetchComments: false,
        })

        if (!result.ok || !result.note || !result.note.images?.length) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  { ok: false, stage: 'read_note', result },
                  null,
                  2,
                ),
              },
            ],
          }
        }

        try {
          const r = await fetch(result.note.images[0], {
            headers: {
              'User-Agent': UA,
              Referer: 'https://www.xiaohongshu.com/',
              Accept:
                'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            },
          })
          const mimeType = (
            r.headers.get('content-type') || 'image/jpeg'
          ).split(';')[0]

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ok: r.ok,
                    status: r.status,
                    contentType: mimeType,
                    isImage: mimeType.startsWith('image/'),
                  },
                  null,
                  2,
                ),
              },
            ],
          }
        } catch (e) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ok: false,
                    stage: 'fetch_image',
                    error: e instanceof Error ? e.message : String(e),
                  },
                  null,
                  2,
                ),
              },
            ],
          }
        }
      },
    )

    server.registerTool(
      'search_xiaohongshu',
      {
        description: '通过关键字搜索小红书笔记，返回搜索结果列表。需要配置 TIKHUB_API_KEY。',
        inputSchema: {
          keyword: z.string().describe('搜索关键字'),
          count: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe('返回结果数量，默认 5'),
        },
      },
      async (args) => {
        const result = await searchNotes(args)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      },
    )

    const transport = new WebStandardStreamableHTTPServerTransport()
    await server.connect(transport)
    return withCors(await transport.handleRequest(req))
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return withCors(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error', data: message },
          id: null,
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      ),
    )
  }
}

function withCors(res: Response) {
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v)
  return new Response(res.body, { status: res.status, headers })
}

async function readNote(args: { url: string; fetchComments?: boolean; commentCount?: number; includeImages?: boolean; maxImages?: number }) {
  const url = (args.url || '').trim()
  if (!url) return { ok: false, error: '缺少url参数' }

  const fetchCommentsInTx = args.fetchComments !== false
  const commentCount = args.commentCount || 10

  let noteId = ''
  let shareUrl = ''
  const m1 = url.match(/https?:\/\/xhslink\.cn\/[a-zA-Z0-9/]+/)
  if (m1) shareUrl = m1[0]
  const m2 = url.match(/xiaohongshu\.com\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/)
  if (m2) noteId = m2[1]
  if (!shareUrl && !noteId && /^[a-zA-Z0-9]+$/.test(url)) noteId = url
  if (!shareUrl && !noteId) return { ok: false, error: '无法从url解析出笔记' }

  let note = null
  try {
    note = await fetchDirect(noteId, shareUrl, commentCount)
  } catch {
    // fall through to TikHub
  }
  const apiKey = getTikHubApiKey()
  if (!note && apiKey) {
    try {
      note = await fetchTikHubImage(noteId, shareUrl || url)
    } catch {
      // no fallback left
    }
  }
  if (!note) return { ok: false, error: '无法获取笔记' }

  const rid = note.noteId || noteId
  if (rid && fetchCommentsInTx && apiKey && (!note.comments || note.comments.length === 0)) {
    try {
      const cmts = await fetchComments(rid, commentCount, 'latest_v2')
      if (cmts.length > 0) note.comments = cmts
    } catch {
      // keep direct comments if available
    }
  }

  if (note.type === 'video' && !note.videoUrl && rid && apiKey) {
    try {
      note.videoUrl = await fetchTikHubVideo(rid)
    } catch {
      // video URL stays null
    }
  }

  return { ok: true, note, source: note._source || 'unknown' }
}


async function fetchMcpImages(urls: string[]): Promise<any[]> {
  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        const r = await fetch(url, {
          headers: {
            'User-Agent': UA,
            Referer: 'https://www.xiaohongshu.com/',
            Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          },
        })
        if (!r.ok) return null
        const mimeType = (r.headers.get('content-type') || 'image/jpeg').split(';')[0]
        if (!mimeType.startsWith('image/')) return null
        const bytes = new Uint8Array(await r.arrayBuffer())
        const base64 = uint8ToBase64(bytes)
        return { type: 'image', data: base64, mimeType }
      } catch {
        return null
      }
    }),
  )
  return results.filter(Boolean)
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)))
  }
  return btoa(binary)
}

async function searchNotes(args: { keyword: string; count?: number }) {
  const keyword = (args.keyword || '').trim()
  const count = args.count || 5
  const apiKey = getTikHubApiKey()
  if (!keyword) return { ok: false, error: '缺少keyword' }
  if (!apiKey) return { ok: false, error: '搜索功能需要TikHub API Key' }

  let items = await doSearch(keyword)
  if ((!items || items.length === 0) && keyword.length > 4) {
    items = await doSearch(keyword.substring(0, Math.ceil(keyword.length / 2)))
  }
  if ((!items || items.length === 0) && keyword.length > 2) {
    items = await doSearch(keyword.substring(0, 2))
  }
  if (!items || items.length === 0) return { ok: false, error: '没有找到相关内容' }

  const results = items
    .slice(0, count)
    .map((item: any) => {
      const note = item.note || {}
      const imgs: string[] = (note.images_list || [])
        .map((i: any) => i.url || i.original || '')
        .filter(Boolean)
      return {
        noteId: note.id || '',
        title: extractTitle(note.title, note.desc),
        author: note.user?.nickname || note.user?.nickName || note.user?.name || '',
        desc: (note.desc || '').replace(/\[话题\]/g, '').trim(),
        cover: imgs[0] || '',
        imageCount: imgs.length,
        likedCount: note.liked_count || 0,
        commentCount: note.comments_count || 0,
        collectedCount: note.collected_count || 0,
        type: note.type || 'normal',
        url: 'https://www.xiaohongshu.com/explore/' + (note.id || ''),
      }
    })
    .filter((r: any) => r.noteId)

  return { ok: true, results, total: items.length }
}
