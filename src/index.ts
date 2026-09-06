import { setRuntimeEnv, json } from './_lib/xhs.mts'
import mcp from './mcp.mts'
import xhsCard from './xhs-card.mts'
import xhsImages from './xhs-images.mts'
import xhsSearch from './xhs-search.mts'

type Env = { TIKHUB_API_KEY?: string }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    setRuntimeEnv(env)
    const url = new URL(request.url)

    if (url.pathname === '/api/mcp') return mcp(request)
    if (url.pathname === '/api/xhs-card') return xhsCard(request)
    if (url.pathname === '/api/xhs-images') return xhsImages(request)
    if (url.pathname === '/api/xhs-search') return xhsSearch(request)

    return json({ ok: true, service: 'xiaohongshu-reader', endpoint: '/api/mcp' })
  },
}
