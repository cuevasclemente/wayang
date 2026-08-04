import { spawn } from 'node:child_process'
import {
  accessSync,
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { connect } from 'node:net'

const MAX_FRAME_BYTES = 16 * 1024

function frame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (body.length > MAX_FRAME_BYTES) throw new Error('fixture frame is too large')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

function readOneFrame() {
  const input = createReadStream('', { fd: 3, autoClose: false })
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    input.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length < 4) return
      const length = buffered.readUInt32BE(0)
      if (length > MAX_FRAME_BYTES) {
        reject(new Error('response frame exceeds bound'))
        input.destroy()
        return
      }
      if (buffered.length < length + 4) return
      try {
        resolve(JSON.parse(buffered.subarray(4, length + 4).toString('utf8')))
      } catch (error) {
        reject(error)
      }
      input.destroy()
    })
    input.on('error', reject)
    input.on('end', () => reject(new Error('FD3 ended before a complete frame')))
  })
}

async function rpcRoundTrip() {
  const output = createWriteStream('', { fd: 3, autoClose: false })
  const responsePromise = readOneFrame()
  output.write(frame({
    type: 'request',
    id: 'synthetic-rpc-1',
    method: 'synthetic.echo',
    params: { text: 'bounded-fd3' },
  }))
  const response = await responsePromise
  return response?.type === 'response' &&
    response?.id === 'synthetic-rpc-1' &&
    response?.result?.text === 'bounded-fd3:backend'
}

function canAccess(path) {
  try {
    accessSync(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function canWrite(path, value = 'written') {
  try {
    writeFileSync(path, value, 'utf8')
    return true
  } catch {
    return false
  }
}

function blockedTcp(port) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = blocked => {
      socket.destroy()
      resolve(blocked)
    }
    socket.once('connect', () => finish(false))
    socket.once('error', () => finish(true))
    socket.setTimeout(500, () => finish(true))
  })
}

function unixSocketBlockedBySeccomp() {
  return new Promise(resolve => {
    const socket = connect('/workspace/state/does-not-exist.sock')
    socket.once('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', error => {
      socket.destroy()
      resolve(error?.code === 'EPERM')
    })
    socket.setTimeout(500, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

async function probe() {
  const hiddenHostPath = process.argv[3]
  const listenerPort = Number(process.argv[4])
  const piCanaryHostPath = process.argv[5]
  const providerCanaryHostPath = process.argv[6]
  const environmentKeys = Object.keys(process.env).sort()
  // PWD is a harmless runtime bookkeeping key that bubblewrap/Node may add
  // after --clearenv. It is accepted only at the exact sandbox working path.
  const allowedEnvironment = new Set(['HOME', 'LANG', 'PATH', 'PWD'])

  const checks = {
    snapshotReadable: readFileSync('/workspace/snapshot/immutable.txt', 'utf8') === 'immutable\n',
    snapshotImmutable: !canWrite('/workspace/snapshot/immutable.txt', 'changed') &&
      !canWrite('/workspace/snapshot/new-file.txt'),
    jobWorkRootExact: process.cwd() === '/workspace/project' &&
      readFileSync('/workspace/project/input.txt', 'utf8') === 'project\n',
    projectWritable: canWrite('/workspace/project/project-write.txt'),
    runWritable: canWrite('/workspace/run/run-write.txt'),
    stateWritable: canWrite('/workspace/state/state-write.txt'),
    unrelatedHomeHidden: !canAccess(hiddenHostPath) && !canAccess('/home'),
    shellAbsent: !canAccess('/bin/sh'),
    envAbsent: !canAccess('/usr/bin/env'),
    trueAbsent: !canAccess('/usr/bin/true'),
    rootWriteDenied: !canWrite('/outside-write.txt'),
    runtimeWriteDenied: !canWrite('/runtime/outside-write.txt'),
    usrWriteDenied: !canWrite('/usr/bin/outside-write.txt'),
    tmpWriteDenied: !canWrite('/tmp/outside-write.txt'),
    devWriteDenied: !canWrite('/dev/outside-write.txt'),
    outboundTcpBlocked: await blockedTcp(listenerPort),
    unixSocketBlocked: await unixSocketBlockedBySeccomp(),
    fd3RoundTrip: await rpcRoundTrip(),
    providerCanariesHidden: !canAccess(piCanaryHostPath) &&
      !canAccess(providerCanaryHostPath) &&
      !canAccess('/workspace/provider-canary'),
    providerStateAbsent: environmentKeys.every(key => allowedEnvironment.has(key)) &&
      process.env.HOME === '/nonexistent' &&
      process.env.PATH === '' &&
      process.env.LANG === 'C.UTF-8' &&
      (process.env.PWD === undefined || process.env.PWD === '/workspace/project') &&
      !canAccess('/nonexistent') &&
      !canAccess('/root/.pi') &&
      !canAccess('/root/.config'),
  }

  process.stdout.write(`${JSON.stringify({ ok: Object.values(checks).every(Boolean), checks, environmentKeys })}\n`)
}

function descendant() {
  const heartbeatPath = process.argv[3]
  // This is an ordinary descendant: it deliberately inherits the sandbox
  // process group and does not attempt setsid/detached escape behavior.
  const child = spawn('/usr/bin/node', ['/workspace/snapshot/job.mjs', 'leaf', heartbeatPath], {
    shell: false,
    detached: false,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
  writeFileSync('/workspace/run/descendant-ready', 'ready\n', 'utf8')
  setInterval(() => {}, 1_000)
}

function leaf() {
  const heartbeatPath = process.argv[3]
  let counter = 0
  writeFileSync(heartbeatPath, `${counter}\n`, 'utf8')
  setInterval(() => {
    counter += 1
    writeFileSync(heartbeatPath, `${counter}\n`, 'utf8')
  }, 50)
}

function validRequestFrame() {
  return frame({
    type: 'request',
    id: 'synthetic-rpc-1',
    method: 'synthetic.echo',
    params: { text: 'bounded-fd3' },
  })
}

function writeAndCloseFd3(payload) {
  let offset = 0
  while (offset < payload.length) {
    offset += writeSync(3, payload, offset, payload.length - offset)
  }
  closeSync(3)
}

function peerClose() {
  closeSync(3)
}

function validFrameFlood() {
  writeAndCloseFd3(Buffer.concat([validRequestFrame(), validRequestFrame()]))
}

function truncatedFrame() {
  const header = Buffer.alloc(4)
  header.writeUInt32BE(32)
  writeAndCloseFd3(Buffer.concat([header, Buffer.from('{')]))
}

function oversizedFrame() {
  const header = Buffer.alloc(4)
  header.writeUInt32BE(MAX_FRAME_BYTES + 1)
  writeAndCloseFd3(header)
}

const mode = process.argv[2]
try {
  if (mode === 'probe') await probe()
  else if (mode === 'descendant') descendant()
  else if (mode === 'leaf') leaf()
  else if (mode === 'peer-close') peerClose()
  else if (mode === 'valid-frame-flood') validFrameFlood()
  else if (mode === 'truncated-frame') truncatedFrame()
  else if (mode === 'oversized-frame') oversizedFrame()
  else throw new Error(`unknown fixture mode: ${mode}`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
}
