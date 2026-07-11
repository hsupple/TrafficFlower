import { defineConfig } from 'vite'
import fs from 'node:fs'
import path from 'node:path'

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(JSON.parse(raw || '{}'))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function trafficflowerApiPlugin() {
  const logsDir = path.resolve(process.cwd(), 'logs')
  const transitionsPath = path.resolve(
    process.cwd(),
    'src/sim/trafficflower-transitions.json',
  )

  return {
    name: 'trafficflower-api',
    configureServer(server) {
      fs.mkdirSync(logsDir, { recursive: true })

      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0]

        if (url === '/api/sim-log') {
          if (req.method === 'OPTIONS') {
            res.statusCode = 204
            res.end()
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST only' })
            return
          }
          try {
            const body = await readJsonBody(req)
            const safeBase =
              String(body.file || 'default')
                .trim()
                .replace(/\.log$/i, '')
                .replace(/[^a-zA-Z0-9._-]+/g, '_')
                .replace(/^_+|_+$/g, '') || 'default'
            const fileName = `${safeBase}.log`
            const line = String(body.line || '').trimEnd()
            if (!line) {
              sendJson(res, 400, { ok: false, error: 'empty line' })
              return
            }
            const fullPath = path.join(logsDir, fileName)
            fs.appendFileSync(fullPath, `${line}\n`, 'utf8')
            sendJson(res, 200, {
              ok: true,
              file: fileName,
              path: `logs/${fileName}`,
              absolutePath: fullPath,
            })
          } catch (err) {
            sendJson(res, 500, { ok: false, error: err.message || String(err) })
          }
          return
        }

        if (url === '/api/capture-transitions') {
          if (req.method === 'OPTIONS') {
            res.statusCode = 204
            res.end()
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST only' })
            return
          }
          try {
            const body = await readJsonBody(req)
            if (!Array.isArray(body.transitions) || !body.transitions.length) {
              sendJson(res, 400, { ok: false, error: 'transitions required' })
              return
            }
            const doc = {
              meta: {
                ...(body.meta || {}),
                locked: true,
                capturedAt: new Date().toISOString(),
                source: 'found_capture',
              },
              transitions: body.transitions,
              spawns: body.spawns || [],
              samplePaths: body.samplePaths || [],
            }
            fs.writeFileSync(transitionsPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
            sendJson(res, 200, {
              ok: true,
              path: 'src/sim/trafficflower-transitions.json',
              absolutePath: transitionsPath,
              edges: body.transitions.length,
            })
          } catch (err) {
            sendJson(res, 500, { ok: false, error: err.message || String(err) })
          }
          return
        }

        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [trafficflowerApiPlugin()],
})
