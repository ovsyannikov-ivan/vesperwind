// basic-ftp behaviour the Node FTP/FTPS backend (server/ftp.js) depends on,
// checked against a real local FTP/FTPS server. If an upgrade changes one of
// these, the backend's TLS and transfer guarantees must be re-evaluated.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import tls from 'node:tls'
import { Readable, Writable } from 'node:stream'
import { Client, FTPError } from 'basic-ftp'
import { createTestPki, startFtpTestServer } from './support/ftpTestServer.js'

const fixture = { directory: null, pki: null, root: null }
test.before(async () => {
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-ftp-contract-'))
  fixture.pki = await createTestPki(fixture.directory)
  fixture.root = path.join(fixture.directory, 'root')
  await fs.mkdir(fixture.root)
  await fs.writeFile(path.join(fixture.root, 'a.txt'), 'hello world')
})
test.after(() => fs.rm(fixture.directory, { recursive: true, force: true }))

const sink = () => { const chunks = []; return { chunks, stream: new Writable({ write(chunk, _e, callback) { chunks.push(chunk); callback() } }) } }
const withServer = async (options, run) => {
  const server = await startFtpTestServer(fixture.root, options)
  const client = new Client(10_000)
  try { await run(server, client) } finally { client.close(); await server.close() }
}

test('an unauthorized certificate fails the TLS upgrade itself, before USER/PASS can be sent', async () => {
  for (const tlsMode of ['explicit', 'implicit']) {
    await withServer({ tls: tlsMode, ...fixture.pki.selfSigned }, async (server, client) => {
      const options = { host: 'localhost', servername: 'localhost' }
      const connect = tlsMode === 'implicit'
        ? client.connectImplicitTLS('localhost', server.port, options)
        : client.connect('localhost', server.port).then(() => client.useTLS(options))
      await assert.rejects(connect, (error) => error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT')
      assert.equal(server.sent('USER'), false)
      assert.equal(server.sent('PASS'), false)
    })
  }
})

test('data connections resume the control TLS session; Node then reports no peer certificate', async () => {
  await withServer({ tls: 'explicit', ...fixture.pki.valid, requireSessionReuse: true }, async (server, client) => {
    const options = { host: 'localhost', servername: 'localhost', ca: [fixture.pki.ca] }
    await client.connect('localhost', server.port)
    await client.useTLS(options)
    // The backend wraps this prototype accessor to verify every data socket.
    assert.equal(typeof Object.getOwnPropertyDescriptor(Object.getPrototypeOf(client.ftp), 'dataSocket')?.set, 'function')
    const observed = []
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(client.ftp), 'dataSocket')
    Object.defineProperty(client.ftp, 'dataSocket', {
      configurable: true,
      get() { return descriptor.get.call(client.ftp) },
      set(socket) {
        if (socket instanceof tls.TLSSocket) socket.prependOnceListener('secureConnect', () => observed.push({ resumed: socket.isSessionReused(), raw: Boolean(socket.getPeerCertificate(true)?.raw) }))
        descriptor.set.call(client.ftp, socket)
      },
    })
    await client.login('fixture', 'fixture-password')
    await client.send('PBSZ 0')
    await client.send('PROT P')
    const { chunks, stream } = sink()
    await client.downloadTo(stream, '/a.txt')
    assert.equal(Buffer.concat(chunks).toString(), 'hello world')
    assert.deepEqual(server.log.dataResumed, [true])
    assert.deepEqual(observed, [{ resumed: true, raw: false }])
  })
})

test('final 451/552 replies after all bytes reject downloads and uploads; the destination is still ended', async () => {
  await withServer({ retrFinalError: 451, storFinalError: 552 }, async (server, client) => {
    await client.connect('localhost', server.port)
    await client.login('fixture', 'fixture-password')
    const { chunks, stream } = sink()
    await assert.rejects(client.downloadTo(stream, '/a.txt'), (error) => error instanceof FTPError && error.code === 451)
    assert.equal(Buffer.concat(chunks).toString(), 'hello world')
    // basic-ftp ends the destination even after a failure: the backend
    // writes through a forwarder and ends its own stream only on success.
    assert.equal(stream.writableEnded, true)
    await assert.rejects(client.uploadFrom(Readable.from([Buffer.from('upload')]), '/u.txt'), (error) => error instanceof FTPError && error.code === 552)
  })
  await fs.rm(path.join(fixture.root, 'u.txt'), { force: true })
})

test('commands with line breaks are refused and nothing is logged unless verbose', async () => {
  await withServer({}, async (server, client) => {
    const lines = []
    const original = console.log
    console.log = (...values) => lines.push(values.join(' '))
    try {
      await client.connect('localhost', server.port)
      await assert.rejects(client.send('NOOP\r\nDELE /a.txt'))
      await client.login('fixture', 'fixture-password')
    } finally { console.log = original }
    assert.equal(client.ftp.verbose, false)
    assert.deepEqual(lines, [])
    assert.equal(server.sent('DELE'), false)
  })
})
