// Public test-only key/certificate; never used by the application.
const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')
const root = __dirname
const server = https.createServer({ key: fs.readFileSync(path.join(root, 'tls/fixture-key.pem')), cert: fs.readFileSync(path.join(root, 'tls/fixture-cert.pem')) }, (request, response) => {
  const name = new URL(request.url, 'https://localhost').pathname
  if (name.includes('..')) { response.writeHead(404).end(); return }
  const file = path.join(root, name)
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return }
  const data = fs.readFileSync(file)
  const start = Number(/^bytes=(\d+)-/.exec(request.headers.range || '')?.[1] || 0)
  response.writeHead(request.headers.range ? 206 : 200, {
    'Content-Type': name.endsWith('m3u8') ? 'application/vnd.apple.mpegurl' : 'application/octet-stream',
    'Content-Length': data.length - start, 'Accept-Ranges': 'bytes',
    ...(request.headers.range ? { 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}` } : {}),
  })
  response.end(data.subarray(start))
})
server.listen(0, '127.0.0.1', () => console.log(server.address().port))
