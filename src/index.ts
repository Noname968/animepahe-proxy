import { Hono } from 'hono'
import axios from 'axios'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
}

const app = new Hono()

app.get('/health', (c) => c.text('OK'))

// Proxy endpoint for M3U8 and .key files
app.get('/', async (c) => {
  const url = c.req.query('url')
  const ref = c.req.query('ref')

  if (!url) return c.json({ error: 'No URL provided' }, 400)

  try {
    const response = await axios.get(url, {
      headers: { Referer: ref || '' },
      responseType: 'arraybuffer',
    })

    const contentType = response.headers['content-type'] || 'text/plain'
    const isM3U8 = contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegURL')

    // Serve .key or other media directly
    if (url.endsWith('.key') || !isM3U8) {
      return c.body(response.data, 200, {
        ...corsHeaders,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
    }

    const playlistText = Buffer.from(response.data).toString('utf-8')
    if (!playlistText.startsWith('#EXTM3U')) {
      return c.body(playlistText, 200, {
        ...corsHeaders,
        'Content-Type': contentType,
      })
    }

    console.log('HLS playlist detected')

    const base = new URL(url)
    const lines = playlistText.split('\n')

    const processedLines = lines.map((line) => {
      const trimmed = line.trim()

      // Rewrite key URI
      if (trimmed.startsWith('#EXT-X-KEY') && trimmed.includes('URI="')) {
        const match = trimmed.match(/URI="([^"]+)"/)
        if (match) {
          const absoluteKeyUrl = new URL(match[1], base).href
          const proxyUrl = `/proxy?url=${encodeURIComponent(absoluteKeyUrl)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`
          return trimmed.replace(/URI="([^"]+)"/, `URI="${proxyUrl}"`)
        }
      }

      // Skip comments or empty lines
      if (!trimmed || trimmed.startsWith('#')) return line

      // Rewrite segment URLs
      const absoluteSegmentUrl = new URL(trimmed, base).href
      return `/proxy?url=${encodeURIComponent(absoluteSegmentUrl)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`
    })

    return c.body(processedLines.join('\n'), 200, {
      ...corsHeaders,
      'Content-Type': 'application/vnd.apple.mpegurl',
    })
  } catch (err) {
    console.error('Error in main handler:', err)
    return c.json({
      error: 'Failed to fetch or process M3U8 content',
      details: err instanceof Error ? err.message : String(err),
    }, 500)
  }
})

// General-purpose proxy for assets and segments
app.get('/proxy', async (c) => {
  const url = c.req.query('url')
  const ref = c.req.query('ref')

  if (!url) return c.json({ error: 'No URL provided' }, 400)

  try {
    const response = await axios.get(url, {
      headers: { Referer: ref || '', Origin: 'https://kwik.si' },
      responseType: 'arraybuffer',
    })

    const contentType = response.headers['content-type'] || 'application/octet-stream'

    return c.body(response.data, 200, {
      ...corsHeaders,
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    })
  } catch (err) {
    console.error('Error in /proxy:', err)
    return c.json({
      error: 'Failed to fetch resource',
      details: err instanceof Error ? err.message : String(err),
    }, 500)
  }
})

export default app
