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

// General-purpose proxy for assets and segments (including HLS handling)
app.get('/', async (c) => {
  const url = c.req.query('url')

  if (!url) return c.json({ error: 'No URL provided' }, 400)

  try {
    const response = await axios.get(url, {
      headers: { Referer: 'https://kwik.si', Origin: 'https://kwik.si' },
      responseType: 'arraybuffer',
    })

    const contentType = response.headers['content-type'] || 'application/octet-stream'

    // If it's a media file other than M3U8, serve it directly
    if (url.endsWith('.key') || (!contentType.includes('application/vnd.apple.mpegurl') && !contentType.includes('application/x-mpegURL'))) {
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

      // Rewrite key URI in playlist
      if (trimmed.startsWith('#EXT-X-KEY') && trimmed.includes('URI="')) {
        const match = trimmed.match(/URI="([^"]+)"/)
        if (match) {
          const absoluteKeyUrl = new URL(match[1], base).href
          // Proxy all keys through the same path using the query parameter
          return trimmed.replace(/URI="([^"]+)"/, `URI="?url=${encodeURIComponent(absoluteKeyUrl)}"`)
        }
      }

      // Skip comments or empty lines
      if (!trimmed || trimmed.startsWith('#')) return line

      // Rewrite segment URLs
      const absoluteSegmentUrl = new URL(trimmed, base).href
      return `?url=${encodeURIComponent(absoluteSegmentUrl)}` // Proxy all segments through the same path
    })

    return c.body(processedLines.join('\n'), 200, {
      ...corsHeaders,
      'Content-Type': 'application/vnd.apple.mpegurl',
    })
  } catch (err) {
    console.error('Error in /:', err)
    return c.json({
      error: 'Failed to fetch or process M3U8 content',
      details: err instanceof Error ? err.message : String(err),
    }, 500)
  }
})

export default app
