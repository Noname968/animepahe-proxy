import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { createClient } from 'redis'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const app = new Hono()

// Self-invoking async function for Redis connection
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://default:782f4f09066e95214ebb@65.108.75.166:5443',
})

redisClient.on('error', err => console.error('Redis Client Error', err))

async function main() {
  await redisClient.connect()

  // Health check
  app.get('/health', (c) => c.text('OK'))

  // Main proxy endpoint
  app.get('/', async (c) => {
    const url = c.req.query('url')
    const ref = c.req.query('ref')

    if (!url) return c.json({ error: 'No URL provided' }, 400)

    try {
      const headers: HeadersInit = {}
      if (ref) headers['Referer'] = ref

      const response = await fetch(url, { headers })
      const contentType = response.headers.get('Content-Type') || ''
      const isM3U8 = contentType.includes('application/vnd.apple.mpegurl') ||
        contentType.includes('application/x-mpegURL')

      // Serve key or other static files
      if (url.endsWith('.key') || !isM3U8) {
        const buffer = await response.arrayBuffer()
        return c.body(buffer, 200, {
          ...corsHeaders,
          'Content-Type': contentType || 'application/octet-stream',
        })
      }

      const text = await response.text()
      if (!text.startsWith('#EXTM3U')) {
        return c.body(text, response.status, {
          ...corsHeaders,
          'Content-Type': contentType || 'text/plain',
        })
      }

      console.log('HLS stream found')

      const regex = /\/[^\/]*$/
      const urlRegex = /^(?:(?:(?:https?|ftp):)?\/\/)[^\s/$.?#].[^\s]*$/i

      const lines = text.split('\n')
      const processedLines = await Promise.all(lines.map(async (line) => {
        const trimmed = line.trim()

        if (trimmed.startsWith('#EXT-X-KEY') && trimmed.includes('URI=')) {
          const match = trimmed.match(/URI="([^"]+)"/)
          if (match) {
            const keyUri = new URL(match[1], url).href
            const id = uuidv4()
            await redisClient.setEx(id, 3600, JSON.stringify({ url: keyUri, ref }))
            return trimmed.replace(/URI="([^"]+)"/, `URI="/key/${id}"`)
          }
        }

        if (!trimmed || trimmed.startsWith('#')) return line

        let formattedLine = trimmed.startsWith('.') ? trimmed.substring(1) : trimmed

        if (formattedLine.match(urlRegex)) {
          const id = uuidv4()
          await redisClient.setEx(id, 3600, JSON.stringify({ url: formattedLine, ref }))
          return `/segment/${id}`
        } else {
          const newUrl = url.replace(
            regex,
            formattedLine.startsWith('/')
              ? formattedLine
              : `/${formattedLine}`
          )
          const id = uuidv4()
          await redisClient.setEx(id, 3600, JSON.stringify({ url: newUrl, ref }))
          return `/segment/${id}`
        }
      }))

      return c.body(processedLines.join('\n'), 200, {
        ...corsHeaders,
        'Content-Type': 'application/vnd.apple.mpegurl',
      })
    } catch (err) {
      console.error('Error in root handler:', err)
      return c.json(
        { error: 'Failed to fetch M3U8 content', details: (err as Error).message },
        500
      )
    }
  })

  // Segment fetch route
  app.get('/segment/:id', async (c) => {
    const cached = await redisClient.get(c.req.param('id'))
    if (!cached) return c.json({ error: 'Segment not found' }, 404)

    const { url, ref } = JSON.parse(cached)
    try {
      const headers: HeadersInit = {}
      if (ref) headers['Referer'] = ref

      const resp = await fetch(url, { headers })
      const buffer = await resp.arrayBuffer()
      const contentType = resp.headers.get('Content-Type') || 'application/octet-stream'

      return c.body(buffer, 200, {
        ...corsHeaders,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
    } catch (err) {
      console.error('Error fetching segment:', err)
      return c.json({ error: 'Error fetching segment', details: (err as Error).message }, 500)
    }
  })

  // Key fetch route
  app.get('/key/:id', async (c) => {
    const cached = await redisClient.get(c.req.param('id'))
    if (!cached) return c.json({ error: 'Key not found' }, 404)

    const { url, ref } = JSON.parse(cached)
    try {
      const headers: HeadersInit = {}
      if (ref) headers['Referer'] = ref

      const resp = await fetch(url, { headers })
      const buffer = await resp.arrayBuffer()
      const contentType = resp.headers.get('Content-Type') || 'application/octet-stream'

      return c.body(buffer, 200, {
        ...corsHeaders,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
    } catch (err) {
      console.error('Error fetching key:', err)
      return c.json({ error: 'Error fetching key', details: (err as Error).message }, 500)
    }
  })
}

main()

export default app
