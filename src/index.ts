import { Hono } from 'hono'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const app = new Hono()

// Health check
app.get('/health', (c) => c.text('OK'))

// Main proxy for everything: .m3u8, .key, .ts
app.get('/', async (c) => {
  const url = c.req.query('url')
  const ref = c.req.query('ref')

  if (!url) return c.json({ error: 'No URL provided' }, 400)

  try {
    const headers: HeadersInit = {}
    if (ref) headers['Referer'] = ref

    const response = await fetch(url, { headers })
    const contentType = response.headers.get('Content-Type') || ''
    const isM3U8 =
      contentType.includes('application/vnd.apple.mpegurl') ||
      contentType.includes('application/x-mpegurl')

    // If .key or .ts or anything else, return raw content
    if (url.endsWith('.key') || url.endsWith('.ts') || !isM3U8) {
      const buffer = await response.arrayBuffer()
      return c.body(buffer, 200, {
        ...corsHeaders,
        'Content-Type': contentType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
    }

    // Process m3u8
    const text = await response.text()
    if (!text.startsWith('#EXTM3U')) {
      return c.body(text, response.status, {
        ...corsHeaders,
        'Content-Type': contentType || 'text/plain',
      })
    }

    console.log('M3U8 playlist detected — rewriting key and segment URIs')

    const base = new URL(url)
    const lines = text.split('\n')
    const processedLines = lines.map((line) => {
      const trimmed = line.trim()

      // Rewrite encryption key URIs
      if (trimmed.startsWith('#EXT-X-KEY') && trimmed.includes('URI=')) {
        const match = trimmed.match(/URI="([^"]+)"/)
        if (match) {
          const keyUri = new URL(match[1], base).href
          const proxied = `/?url=${encodeURIComponent(keyUri)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`
          return trimmed.replace(/URI="([^"]+)"/, `URI="${proxied}"`)
        }
      }

      // Rewrite segment URIs (skip comment lines and empty lines)
      if (!trimmed.startsWith('#') && trimmed !== '') {
        try {
          const segmentUri = new URL(trimmed, base).href
          const proxied = `?url=${encodeURIComponent(segmentUri)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`
          return proxied
        } catch (e) {
          // If URL parsing fails, return original line
          return line
        }
      }

      return line
    })

    return c.body(processedLines.join('\n'), 200, {
      ...corsHeaders,
      'Content-Type': 'application/vnd.apple.mpegurl',
    })
  } catch (err) {
    console.error('Proxy error:', err)
    return c.json({ error: 'Failed to fetch content', details: (err as Error).message }, 500)
  }
})

export default app