import { Hono } from 'hono'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
};

const app = new Hono()

// Health check
app.get('/health', (c) => c.text('OK'))

// Main proxy endpoint
app.get('/', async (c) => {
  const url = c.req.query('url')
  const ref = c.req.query('ref')
  const userHeaders = c.req.header;

  if (!url) return c.json({ error: 'No URL provided' }, 400)

  try {

    const response = await fetch(url, {
      headers: { ...userHeaders, Referer: ref || '', ...corsHeaders },
    });
    let contentType = response.headers.get('Content-Type') || 'text/plain';
    const isM3U8 =
      contentType.includes('application/vnd.apple.mpegurl') ||
      contentType.includes('application/x-mpegURL')

    if (url.endsWith('.key') || !isM3U8) {
      const buffer = await response.arrayBuffer()
      return c.body(buffer, 200, {
        ...corsHeaders,
        'Content-Type': 'video/mp2t',
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
    }

    const text = await response.text()
    if (!text.startsWith('#EXTM3U')) {
      return c.body(text, response.status, {
        ...corsHeaders,
      })
    }

    console.log('HLS stream found')

    const base = new URL(url)
    const lines = text.split('\n')
    const processedLines = lines.map((line) => {
      const trimmed = line.trim()

      if (trimmed.startsWith('#EXT-X-KEY') && trimmed.includes('URI=')) {
        const match = trimmed.match(/URI="([^"]+)"/)
        if (match) {
          const keyUri = new URL(match[1], base).href
          return trimmed.replace(/URI="([^"]+)"/, `URI="/proxy?url=${encodeURIComponent(keyUri)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}"`)
        }
      }

      if (!trimmed || trimmed.startsWith('#')) return line

      const fullUrl = new URL(trimmed, base).href
      return `/proxy?url=${encodeURIComponent(fullUrl)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`
    })

    return c.body(processedLines.join('\n'), 200, {
      ...corsHeaders,
      'Content-Type': 'video/mp2t',
    })
  } catch (err) {
    console.error('Error in root handler:', err)
    return c.json(
      { error: 'Failed to fetch M3U8 content', details: (err as Error).message },
      500
    )
  }
})

// General proxy for keys/segments
app.get('/proxy', async (c) => {
  const url = c.req.query('url')
  const ref = c.req.query('ref')
  const userHeaders = c.req.header;

  if (!url) return c.json({ error: 'No URL provided' }, 400);

  try {
    const resp = await fetch(url, {
      headers: { ...userHeaders, Referer: ref || '', ...corsHeaders },
    });

    const buffer = await resp.arrayBuffer()
    let contentType = resp.headers.get('Content-Type') || 'text/plain';

    return c.body(buffer, 200, {
      ...corsHeaders,
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'public, max-age=31536000, immutable',
    })
  } catch (err) {
    console.error('Error fetching resource:', err)
    return c.json({ error: 'Error fetching resource', details: (err as Error).message }, 500)
  }
})

export default app
