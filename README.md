# Xiaohongshu Reader — Cloudflare Worker

Endpoints:
- `POST /api/mcp` — Streamable HTTP MCP endpoint for ChatGPT
- `POST /api/xhs-card` — note details, comments, images, video URL
- `POST /api/xhs-images` — download/encode image URLs as base64
- `POST /api/xhs-search` — keyword search (TikHub key required)

Set `TIKHUB_API_KEY` as a Cloudflare Worker secret/variable when needed.
Direct note parsing and embedded page comments do not require TikHub when the Xiaohongshu page provides them.


## MCP 图片
`read_xiaohongshu` 默认会把最多 8 张小红书图片作为 MCP 原生 image content 返回；可用 `includeImages: false` 关闭，或用 `maxImages` 调整数量（1-12）。
