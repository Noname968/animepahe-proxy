import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { LRUCache } from 'lru-cache'

const app = new Hono()

const cache = new LRUCache<string, { url: string, ref?: string }>({
  ttl: 1000 * 60 * 60,
  maxSize: 1024 * 1024 * 1024,
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

app.get('/', async (c) => {
  const url = c.req.query('url')
  const ref = c.req.query('ref')

  if (!url) return c.json({ error: 'No URL provided' }, 400)

  try {
    const headers: HeadersInit = {}
    if (ref) headers['Referer'] = ref

    const response = await fetch(url, { headers })

    const contentType = response.headers.get('Content-Type') || ''
    const isM3U8 = contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegURL')

    // Handle .key or non-m3u8
    if (url.endsWith('.key') || !isM3U8) {
      const buffer = await response.arrayBuffer()
      return new Response(buffer, {
        headers: {
          ...corsHeaders,
          'Content-Type': contentType || 'application/octet-stream',
        },
      })
    }

    const text = await response.text()
    if (!text.startsWith('#EXTM3U')) {
      return new Response(text, {
        headers: corsHeaders,
        status: response.status,
        statusText: response.statusText,
      })
    }

    console.log("HLS stream found")
    const regex = /\/[^\/]*$/
    const urlRegex = /^(?:(?:(?:https?|ftp):)?\/\/)[^\s/$.?#].[^\s]*$/i
    const refString = ref ? `&ref=${encodeURIComponent(ref)}` : ''

    const m3u8AdjustedChunks = text.split('\n').map(line => {
      const trimmed = line.trim()

      if (trimmed.startsWith('#EXT-X-KEY') && trimmed.includes('URI=')) {
        const match = trimmed.match(/URI="([^"]+)"/)
        if (match) {
          const keyUri = new URL(match[1], url).href
          const id = uuidv4()
          cache.set(id, { url: keyUri, ref })
          return trimmed.replace(/URI="([^"]+)"/, `URI="/key/${id}"`)
        }
      }

      if (!trimmed || trimmed.startsWith('#')) return line

      let formattedLine = trimmed.startsWith('.') ? trimmed.substring(1) : trimmed

      if (formattedLine.match(urlRegex)) {
        const id = uuidv4()
        cache.set(id, { url: formattedLine, ref })
        return `/segment/${id}`
      } else {
        const newUrl = url.replace(regex, formattedLine.startsWith("/") ? formattedLine : `/${formattedLine}`)
        const id = uuidv4()
        cache.set(id, { url: newUrl, ref })
        return `/segment/${id}`
      }
    })

    return c.body(m3u8AdjustedChunks.join('\n'), 200, {
      ...corsHeaders,
      'Content-Type': 'application/vnd.apple.mpegurl',
    })
  } catch (err) {
    return c.json({ error: 'Failed to fetch M3U8 content', details: (err as Error).message }, 500)
  }
})

app.get('/segment/:id', async (c) => {
  const { url, ref } = cache.get(c.req.param('id')) || {}
  if (!url) return c.json({ error: 'Segment not found' }, 404)

  try {
    const headers: HeadersInit = {}
    if (ref) headers['Referer'] = ref

    const resp = await fetch(url, { headers })
    const buffer = await resp.arrayBuffer()
    const contentType = resp.headers.get('Content-Type') || 'application/octet-stream'

    return new Response(buffer, {
      headers: {
        ...corsHeaders,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable', // <-- CDN cache
      },
    })
  } catch (err) {
    return c.json({ error: 'Error fetching segment', details: (err as Error).message }, 500)
  }
})

app.get('/key/:id', async (c) => {
  const { url, ref } = cache.get(c.req.param('id')) || {}
  if (!url) return c.json({ error: 'Key not found' }, 404)

  try {
    const headers: HeadersInit = {}
    if (ref) headers['Referer'] = ref

    const resp = await fetch(url, { headers })
    const buffer = await resp.arrayBuffer()
    const contentType = resp.headers.get('Content-Type') || 'application/octet-stream'

    return new Response(buffer, {
      headers: {
        ...corsHeaders,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  } catch (err) {
    return c.json({ error: 'Error fetching key', details: (err as Error).message }, 500)
  }
})
