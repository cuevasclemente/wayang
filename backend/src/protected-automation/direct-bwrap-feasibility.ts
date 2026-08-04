import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import {
  access,
  chmod,
  copyFile,
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Duplex, Readable } from 'node:stream'

const NODE_PATH = '/usr/bin/node'
const LDD_PATH = '/usr/bin/ldd'
const BWRAP_PATH = '/usr/bin/bwrap'
const SANDBOX_NODE_PATH = '/usr/bin/node'
const SANDBOX_SECCOMP_PATH = '/runtime/apply-seccomp'
const SANDBOX_FIXTURE_PATH = '/workspace/snapshot/job.mjs'
const SANDBOX_JOB_WORK_ROOT = '/workspace/project'
const MAX_FRAME_BYTES = 16 * 1024

type AnyBuffer = Buffer<ArrayBufferLike>
const MAX_OUTPUT_BYTES = 1024 * 1024
const RUNTIME_CLOSURE_SCOPE = 'ELF startup closure only; excludes dlopen and native addons' as const

export const DIRECT_BWRAP_REQUIRED_CHECKS = [
  'linuxOnly',
  'exactNodeResolved',
  'startupDynamicClosure',
  'staticSeccompWrapper',
  'bubblewrapResolved',
  'immutableSnapshot',
  'unrelatedHomeHidden',
  'exactJobWorkRoot',
  'writableRootValidation',
  'writesScoped',
  'ambientToolsAbsent',
  'networkNamespaceBlocksTcp',
  'seccompBlocksUnixSockets',
  'boundedFd3Framing',
  'timeoutStopsOrdinaryDescendants',
  'cancelStopsOrdinaryDescendants',
  'noPiOrProviderState',
] as const

export type DirectBwrapCheck = (typeof DIRECT_BWRAP_REQUIRED_CHECKS)[number]
type Fd3AdversarialCheck = 'peerClose' | 'validFrameFlood' | 'truncatedFrame' | 'oversize'

export interface DirectBwrapFeasibilityReport {
  verdict: 'GO' | 'NO-GO'
  checks: Record<DirectBwrapCheck, boolean>
  errors: string[]
  /** ELF interpreter and ldd startup closure only; dlopen/native addons are excluded. */
  runtimeFiles: string[]
  runtimeClosureScope: typeof RUNTIME_CLOSURE_SCOPE
  fd3AdversarialChecks: Record<Fd3AdversarialCheck, boolean>
  /** Protocol metadata only: no frame, stdout, or stderr content. */
  fd3AdversarialDiagnostics: Record<Fd3AdversarialCheck, {
    termination: 'exit' | 'timeout' | 'cancelled' | 'frame-bound' | null
    protocolRejected: boolean
    exitCode: number | null
    signal: NodeJS.Signals | null
  }>
  /** Names only. Environment values are never returned by this gate. */
  observedEnvironmentKeys: string[]
}

interface RuntimeBind {
  source: string
  destination: string
}

interface RuntimeClosure {
  binds: RuntimeBind[]
  seccompSource: string
}

interface SandboxLayout {
  snapshot: string
  project: string
  run: string
  state: string
}

interface RunOptions {
  layout: SandboxLayout
  closure: RuntimeClosure
  fixtureArgs: string[]
  hiddenHostPath: string
  timeoutMs: number
  signal?: AbortSignal
}

interface RunResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  termination: 'exit' | 'timeout' | 'cancelled' | 'frame-bound'
  rpcRoundTrip: boolean
  protocolRejected: boolean
}

interface ElfInfo {
  interpreter: string | null
  dynamic: boolean
}

function emptyChecks(): Record<DirectBwrapCheck, boolean> {
  return Object.fromEntries(DIRECT_BWRAP_REQUIRED_CHECKS.map(check => [check, false])) as Record<DirectBwrapCheck, boolean>
}

async function requireExecutable(executable: string): Promise<void> {
  const metadata = await stat(executable)
  if (!metadata.isFile()) throw new Error(`${executable} is not a regular file`)
  await access(executable, constants.X_OK)
}

function inspectElf(buffer: AnyBuffer): ElfInfo {
  if (buffer.length < 64 || buffer.subarray(0, 4).toString('hex') !== '7f454c46') {
    throw new Error('runtime executable is not ELF')
  }
  if (buffer[4] !== 2 || buffer[5] !== 1) {
    throw new Error('only 64-bit little-endian Linux ELF runtimes are supported by this gate')
  }

  const programOffset = Number(buffer.readBigUInt64LE(32))
  const entrySize = buffer.readUInt16LE(54)
  const entryCount = buffer.readUInt16LE(56)
  if (!Number.isSafeInteger(programOffset) || entrySize < 56) throw new Error('invalid ELF program header')

  let interpreter: string | null = null
  let dynamic = false
  for (let index = 0; index < entryCount; index += 1) {
    const offset = programOffset + index * entrySize
    if (offset < 0 || offset + 56 > buffer.length) throw new Error('truncated ELF program header')
    const type = buffer.readUInt32LE(offset)
    if (type === 2) dynamic = true
    if (type !== 3) continue
    const contentOffset = Number(buffer.readBigUInt64LE(offset + 8))
    const contentSize = Number(buffer.readBigUInt64LE(offset + 32))
    if (!Number.isSafeInteger(contentOffset) || !Number.isSafeInteger(contentSize) ||
      contentOffset < 0 || contentSize < 2 || contentOffset + contentSize > buffer.length) {
      throw new Error('invalid ELF interpreter header')
    }
    interpreter = buffer.subarray(contentOffset, contentOffset + contentSize).toString('utf8').replace(/\0.*$/s, '')
    if (!path.isAbsolute(interpreter)) throw new Error('ELF interpreter is not absolute')
  }
  return { interpreter, dynamic }
}

async function captureExact(executable: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      env: { PATH: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout: AnyBuffer = Buffer.alloc(0)
    let stderr: AnyBuffer = Buffer.alloc(0)
    const append = (current: AnyBuffer, chunk: AnyBuffer): AnyBuffer => {
      const next = Buffer.concat([current, chunk])
      if (next.length > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL')
        throw new Error(`${executable} output exceeded ${MAX_OUTPUT_BYTES} bytes`)
      }
      return next
    }
    child.stdout.on('data', chunk => {
      try { stdout = append(stdout, chunk) } catch (error) { reject(error) }
    })
    child.stderr.on('data', chunk => {
      try { stderr = append(stderr, chunk) } catch (error) { reject(error) }
    })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') }))
  })
}

function parseLdd(stdout: string): string[] {
  const libraries = new Set<string>()
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('linux-vdso.so')) continue
    if (line.includes('=> not found')) throw new Error(`unresolved dynamic library: ${line}`)

    const arrow = line.match(/=>\s+(\/[^\s]+)\s+\(0x[0-9a-f]+\)$/i)
    const direct = line.match(/^(\/[^\s]+)\s+\(0x[0-9a-f]+\)$/i)
    const library = arrow?.[1] ?? direct?.[1]
    if (!library) throw new Error(`unrecognized ldd output: ${line}`)
    libraries.add(library)
  }
  if (libraries.size === 0) throw new Error('ldd returned no dynamic-library closure')
  return [...libraries]
}

async function canonicalSource(source: string): Promise<string> {
  const resolved = await realpath(source)
  const metadata = await stat(resolved)
  if (!metadata.isFile()) throw new Error(`runtime bind source is not a file: ${source}`)
  return resolved
}

function seccompPackageDirectory(): string {
  const packageUrl = new URL('../../node_modules/@anthropic-ai/sandbox-runtime/package.json', import.meta.url)
  return path.dirname(fileURLToPath(packageUrl))
}

async function resolveRuntimeClosure(): Promise<RuntimeClosure> {
  await Promise.all([requireExecutable(NODE_PATH), requireExecutable(LDD_PATH), requireExecutable(BWRAP_PATH)])
  const nodeElf = inspectElf(await readFile(NODE_PATH))
  if (!nodeElf.dynamic || !nodeElf.interpreter) throw new Error(`${NODE_PATH} is not the expected dynamically linked ELF executable`)

  const ldd = await captureExact(LDD_PATH, [NODE_PATH])
  if (ldd.code !== 0) throw new Error(`${LDD_PATH} failed (${ldd.code}): ${ldd.stderr.trim()}`)
  const destinations = new Set(parseLdd(ldd.stdout))
  destinations.add(nodeElf.interpreter)

  const binds: RuntimeBind[] = [{ source: await canonicalSource(NODE_PATH), destination: SANDBOX_NODE_PATH }]
  for (const destination of [...destinations].sort()) {
    binds.push({ source: await canonicalSource(destination), destination })
  }

  const architecture = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : null
  if (!architecture) throw new Error(`no bundled apply-seccomp wrapper for ${process.arch}`)
  const seccompSource = path.join(seccompPackageDirectory(), 'vendor', 'seccomp', architecture, 'apply-seccomp')
  await requireExecutable(seccompSource)
  const seccompElf = inspectElf(await readFile(seccompSource))
  if (seccompElf.dynamic || seccompElf.interpreter !== null) {
    throw new Error('bundled apply-seccomp wrapper is not statically linked')
  }
  return { binds, seccompSource: await canonicalSource(seccompSource) }
}

export async function validateDirectBwrapWritableRoot(root: string): Promise<void> {
  if (!path.isAbsolute(root)) throw new Error(`writable root must be absolute: ${root}`)
  const rootMetadata = await lstat(root)
  if (rootMetadata.isSymbolicLink()) throw new Error(`writable root must not be a symlink: ${root}`)
  if (!rootMetadata.isDirectory()) throw new Error(`writable root must be a directory: ${root}`)

  const visit = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const entry = path.join(directory, name)
      const metadata = await lstat(entry)
      if (metadata.isSymbolicLink()) throw new Error(`writable root contains a symlink: ${entry}`)
      if (metadata.isDirectory()) {
        await visit(entry)
        continue
      }
      if (!metadata.isFile()) {
        throw new Error(`writable root contains a device, FIFO, or socket: ${entry}`)
      }
      // Directory nlink counts are structurally greater than one; regular
      // files are the hardlink aliasing risk that must be rejected.
      if (metadata.nlink > 1) throw new Error(`writable root contains a hardlinked file: ${entry}`)
    }
  }
  await visit(root)
}

function destinationDirectories(destinations: string[]): string[] {
  const directories = new Set<string>(['/dev', '/proc', '/runtime', '/workspace', '/workspace/snapshot', '/workspace/project', '/workspace/run', '/workspace/state'])
  for (const destination of destinations) {
    let current = path.dirname(destination)
    while (current !== '/') {
      directories.add(current)
      current = path.dirname(current)
    }
  }
  return [...directories].sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right))
}

function bwrapArgs(options: RunOptions): string[] {
  const runtimeBinds = [
    ...options.closure.binds,
    { source: options.closure.seccompSource, destination: SANDBOX_SECCOMP_PATH },
  ]
  const args = [
    '--die-with-parent',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--unshare-net',
    '--tmpfs', '/',
  ]
  for (const directory of destinationDirectories(runtimeBinds.map(bind => bind.destination))) args.push('--dir', directory)
  for (const bind of runtimeBinds) args.push('--ro-bind', bind.source, bind.destination)
  args.push(
    '--ro-bind', options.layout.snapshot, '/workspace/snapshot',
    '--bind', options.layout.project, SANDBOX_JOB_WORK_ROOT,
    '--bind', options.layout.run, '/workspace/run',
    '--bind', options.layout.state, '/workspace/state',
    '--proc', '/proc',
    '--dev', '/dev',
    '--remount-ro', '/dev',
    '--remount-ro', '/',
    '--clearenv',
    '--setenv', 'HOME', '/nonexistent',
    '--setenv', 'PATH', '',
    '--setenv', 'LANG', 'C.UTF-8',
    '--chdir', SANDBOX_JOB_WORK_ROOT,
    '--', SANDBOX_SECCOMP_PATH, SANDBOX_NODE_PATH, SANDBOX_FIXTURE_PATH,
    ...options.fixtureArgs,
  )
  return args
}

function appendBounded(current: AnyBuffer, chunk: AnyBuffer, child: ChildProcess): AnyBuffer {
  const next = Buffer.concat([current, chunk])
  if (next.length > MAX_OUTPUT_BYTES) {
    terminateGroup(child, 'SIGKILL')
    throw new Error(`sandbox output exceeded ${MAX_OUTPUT_BYTES} bytes`)
  }
  return next
}

function terminateGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* already gone */ }
  }
}

function responseFrame(value: unknown): AnyBuffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (body.length > MAX_FRAME_BYTES) throw new Error('synthetic response exceeded frame bound')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

async function runSandbox(options: RunOptions): Promise<RunResult> {
  await Promise.all([
    validateDirectBwrapWritableRoot(options.layout.project),
    validateDirectBwrapWritableRoot(options.layout.run),
    validateDirectBwrapWritableRoot(options.layout.state),
  ])

  return await new Promise((resolve, reject) => {
    const child = spawn(BWRAP_PATH, bwrapArgs(options), {
      shell: false,
      detached: true,
      env: { PATH: '' },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    })
    const stdoutStream = child.stdout as Readable
    const stderrStream = child.stderr as Readable
    const rpc = child.stdio[3] as Duplex
    let stdout: AnyBuffer = Buffer.alloc(0)
    let stderr: AnyBuffer = Buffer.alloc(0)
    let rpcBuffer: AnyBuffer = Buffer.alloc(0)
    let rpcRoundTrip = false
    let protocolRejected = false
    let requestsReceived = 0
    let responsesSent = 0
    let responseInFlight = false
    let responseCompletion: Promise<void> | null = null
    let requestedTermination: RunResult['termination'] | null = null
    let settled = false

    const requestTermination = (reason: RunResult['termination']) => {
      if (requestedTermination) return
      requestedTermination = reason
      if (!rpc.destroyed) rpc.destroy()
      terminateGroup(child, 'SIGTERM')
      setTimeout(() => terminateGroup(child, 'SIGKILL'), 250).unref()
    }
    const rejectProtocol = () => {
      protocolRejected = true
      requestTermination('frame-bound')
    }

    const timer = setTimeout(() => requestTermination('timeout'), options.timeoutMs)
    const abort = () => requestTermination('cancelled')
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()

    const failHarness = (error: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      requestTermination('frame-bound')
      reject(error)
    }
    stdoutStream.on('data', (chunk: AnyBuffer) => {
      try { stdout = appendBounded(stdout, chunk, child) } catch (error) { failHarness(error) }
    })
    stderrStream.on('data', (chunk: AnyBuffer) => {
      try { stderr = appendBounded(stderr, chunk, child) } catch (error) { failHarness(error) }
    })

    const writeChunk = async (chunk: AnyBuffer): Promise<void> => await new Promise((resolveWrite, rejectWrite) => {
      if (rpc.destroyed || requestedTermination) {
        rejectWrite(new Error('FD3 closed before the bounded response completed'))
        return
      }
      // The callback fires only after this chunk has passed through the
      // Writable queue, so a false write() return cannot race the next chunk.
      rpc.write(chunk, error => error ? rejectWrite(error) : resolveWrite())
    })
    const sendResponse = async (message: { id: string; text: string }): Promise<void> => {
      if (responseInFlight || responsesSent !== 0) throw new Error('FD3 response ceiling exceeded')
      responseInFlight = true
      const response = responseFrame({ type: 'response', id: message.id, result: { text: `${message.text}:backend` } })
      await writeChunk(response.subarray(0, 2))
      await writeChunk(response.subarray(2))
      if (requestedTermination) return
      responsesSent += 1
      rpcRoundTrip = true
      responseInFlight = false
    }

    const rejectIncompletePeerClose = () => {
      if (requestedTermination || settled) return
      if (rpcBuffer.length !== 0 || requestsReceived === 0 || requestsReceived !== responsesSent) rejectProtocol()
    }
    const checkPeerCloseAfterPendingWrite = () => {
      const completion = responseCompletion
      if (!completion) {
        rejectIncompletePeerClose()
        return
      }
      // Attach both branches and a terminal catch: never leave the Promise
      // returned by then() detached if the stream callback or classifier fails.
      void completion
        .then(rejectIncompletePeerClose, rejectProtocol)
        .catch(rejectProtocol)
    }
    rpc.on('error', () => rejectProtocol())
    rpc.on('end', checkPeerCloseAfterPendingWrite)
    rpc.on('close', checkPeerCloseAfterPendingWrite)
    rpc.on('data', (chunk: AnyBuffer) => {
      rpcBuffer = Buffer.concat([rpcBuffer, chunk])
      while (!requestedTermination && rpcBuffer.length >= 4) {
        const length = rpcBuffer.readUInt32BE(0)
        if (length > MAX_FRAME_BYTES) {
          rejectProtocol()
          return
        }
        if (rpcBuffer.length < length + 4) return
        const body = rpcBuffer.subarray(4, length + 4)
        rpcBuffer = rpcBuffer.subarray(length + 4)
        let message: { type?: string; id?: string; method?: string; params?: { text?: string } }
        try {
          message = JSON.parse(body.toString('utf8'))
        } catch {
          rejectProtocol()
          return
        }
        requestsReceived += 1
        const requestId = message.id
        const requestText = message.params?.text
        if (requestsReceived > 1 || responseInFlight || responsesSent > 0 ||
          message.type !== 'request' || requestId !== 'synthetic-rpc-1' ||
          message.method !== 'synthetic.echo' || requestText !== 'bounded-fd3') {
          rejectProtocol()
          return
        }
        responseCompletion = sendResponse({ id: requestId, text: requestText }).catch(() => rejectProtocol())
      }
    })

    child.once('error', failHarness)
    child.once('exit', () => {
      // Process exit may arrive before the extra stdio stream reports EOF,
      // while ChildProcess close can wait for that stream. Classify on the
      // next turn and actively close FD3 on failure so the run cannot drift
      // to its outer timeout.
      setImmediate(checkPeerCloseAfterPendingWrite)
    })
    child.once('close', (exitCode, signal) => {
      if (settled) return

      const finalizeClose = () => {
        if (settled) return
        // Extra stdio event ordering is not a security boundary. Re-check the
        // protocol state in the finalizer as well as the earlier exit/EOF paths
        // so zero requests and a partial frame always fail closed.
        if (!requestedTermination &&
          (rpcBuffer.length !== 0 || requestsReceived === 0 || requestsReceived !== responsesSent)) {
          protocolRejected = true
          requestedTermination = 'frame-bound'
          if (!rpc.destroyed) rpc.destroy()
        }
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        resolve({
          exitCode,
          signal,
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
          termination: requestedTermination ?? 'exit',
          rpcRoundTrip,
          protocolRejected,
        })
      }

      const completion = responseCompletion
      if (!completion) {
        finalizeClose()
        return
      }
      void completion
        .then(finalizeClose, () => {
          rejectProtocol()
          finalizeClose()
        })
        .catch(failHarness)
    })
  })
}

async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(file, constants.F_OK)
      return true
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  return false
}

async function heartbeatStopped(file: string): Promise<boolean> {
  if (!(await waitForFile(file, 1_000))) return false
  await new Promise(resolve => setTimeout(resolve, 200))
  const before = await readFile(file, 'utf8')
  await new Promise(resolve => setTimeout(resolve, 250))
  const after = await readFile(file, 'utf8')
  return before === after
}

async function listenSyntheticHost(): Promise<{ port: number; connections: () => number; close: () => Promise<void> }> {
  let count = 0
  const server = createServer(socket => {
    count += 1
    socket.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('synthetic TCP listener has no numeric address')
  return {
    port: address.port,
    connections: () => count,
    close: async () => await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

async function createLayout(root: string): Promise<{
  layout: SandboxLayout
  hidden: string
  piCanary: string
  providerCanary: string
}> {
  const layout = {
    snapshot: path.join(root, 'snapshot'),
    project: path.join(root, 'project'),
    run: path.join(root, 'run'),
    state: path.join(root, 'state'),
  }
  const hidden = path.join(root, 'unrelated-home', 'private.txt')
  const piCanary = path.join(root, 'provider-canary', '.pi', 'synthetic-state.json')
  const providerCanary = path.join(root, 'provider-canary', 'synthetic-provider-cache.json')
  await Promise.all([
    mkdir(layout.snapshot, { recursive: true }),
    mkdir(layout.project, { recursive: true }),
    mkdir(layout.run, { recursive: true }),
    mkdir(layout.state, { recursive: true }),
    mkdir(path.dirname(hidden), { recursive: true }),
    mkdir(path.dirname(piCanary), { recursive: true }),
  ])
  const fixtureSource = fileURLToPath(new URL('./direct-bwrap-fixture.js', import.meta.url))
  await Promise.all([
    copyFile(fixtureSource, path.join(layout.snapshot, 'job.mjs')),
    writeFile(path.join(layout.snapshot, 'immutable.txt'), 'immutable\n', { mode: 0o444 }),
    writeFile(path.join(layout.project, 'input.txt'), 'project\n'),
    writeFile(hidden, 'must remain hidden\n', { mode: 0o600 }),
    writeFile(piCanary, '{"synthetic":"pi-canary"}\n', { mode: 0o600 }),
    writeFile(providerCanary, '{"synthetic":"provider-canary"}\n', { mode: 0o600 }),
  ])
  await chmod(layout.snapshot, 0o555)
  return { layout, hidden, piCanary, providerCanary }
}

function parseProbe(result: RunResult): { ok: boolean; checks: Record<string, boolean>; environmentKeys: string[] } {
  if (result.exitCode !== 0 || result.termination !== 'exit') {
    throw new Error(`probe failed (${result.exitCode}/${result.termination}): ${result.stderr.trim()}`)
  }
  const lines = result.stdout.trim().split('\n')
  if (lines.length !== 1) throw new Error('probe did not return exactly one JSON result')
  const parsed = JSON.parse(lines[0]) as { ok?: unknown; checks?: unknown; environmentKeys?: unknown }
  if (typeof parsed.ok !== 'boolean' || !parsed.checks || typeof parsed.checks !== 'object' ||
    !Array.isArray(parsed.environmentKeys) || !parsed.environmentKeys.every(key => typeof key === 'string')) {
    throw new Error('probe returned an invalid result')
  }
  return parsed as { ok: boolean; checks: Record<string, boolean>; environmentKeys: string[] }
}

async function runDescendantCase(
  layout: SandboxLayout,
  closure: RuntimeClosure,
  hidden: string,
  kind: 'timeout' | 'cancelled',
): Promise<boolean> {
  const heartbeatHost = path.join(layout.state, `${kind}-heartbeat.txt`)
  const heartbeatSandbox = `/workspace/state/${kind}-heartbeat.txt`
  const readyHost = path.join(layout.run, 'descendant-ready')
  await rm(readyHost, { force: true })
  const controller = new AbortController()
  const timeoutMs = kind === 'timeout' ? 2_400 : 5_000
  let runFinished = false
  let runFinishedAt = 0
  const running = runSandbox({
    layout,
    closure,
    hiddenHostPath: hidden,
    fixtureArgs: ['descendant', heartbeatSandbox],
    timeoutMs,
    signal: kind === 'cancelled' ? controller.signal : undefined,
  }).finally(() => {
    runFinished = true
    runFinishedAt = Date.now()
  })

  const heartbeatStarted = await waitForFile(heartbeatHost, 1_500)
  let lastHeartbeatProgressAt = 0
  if (heartbeatStarted && kind === 'cancelled') {
    const before = await readFile(heartbeatHost, 'utf8')
    await new Promise(resolve => setTimeout(resolve, 150))
    const after = await readFile(heartbeatHost, 'utf8')
    if (before !== after) lastHeartbeatProgressAt = Date.now()
    // Cancellation follows the positive progress sample immediately.
    controller.abort()
  } else if (heartbeatStarted) {
    // Keep a rolling sample until the timeout actually closes the process,
    // rather than guessing when bwrap startup completed.
    while (!runFinished) {
      const before = await readFile(heartbeatHost, 'utf8')
      await new Promise(resolve => setTimeout(resolve, 75))
      const after = await readFile(heartbeatHost, 'utf8')
      if (before !== after) lastHeartbeatProgressAt = Date.now()
    }
  } else if (kind === 'cancelled') {
    controller.abort()
  }

  const result = await running
  const progressedImmediatelyBeforeStop = kind === 'cancelled'
    ? lastHeartbeatProgressAt > 0
    : lastHeartbeatProgressAt > 0 && runFinishedAt - lastHeartbeatProgressAt <= 250
  return heartbeatStarted && progressedImmediatelyBeforeStop &&
    result.termination === kind && await heartbeatStopped(heartbeatHost)
}

export async function runDirectBwrapFeasibility(): Promise<DirectBwrapFeasibilityReport> {
  const checks = emptyChecks()
  const errors: string[] = []
  let runtimeFiles: string[] = []
  let observedEnvironmentKeys: string[] = []
  const fd3AdversarialChecks: Record<Fd3AdversarialCheck, boolean> = {
    peerClose: false,
    validFrameFlood: false,
    truncatedFrame: false,
    oversize: false,
  }
  const emptyFd3Diagnostic = () => ({
    termination: null,
    protocolRejected: false,
    exitCode: null,
    signal: null,
  })
  const fd3AdversarialDiagnostics: DirectBwrapFeasibilityReport['fd3AdversarialDiagnostics'] = {
    peerClose: emptyFd3Diagnostic(),
    validFrameFlood: emptyFd3Diagnostic(),
    truncatedFrame: emptyFd3Diagnostic(),
    oversize: emptyFd3Diagnostic(),
  }
  if (process.platform !== 'linux') {
    errors.push(`direct bubblewrap feasibility is Linux-only (received ${process.platform})`)
    return {
      verdict: 'NO-GO', checks, errors, runtimeFiles,
      runtimeClosureScope: RUNTIME_CLOSURE_SCOPE,
      fd3AdversarialChecks,
      fd3AdversarialDiagnostics,
      observedEnvironmentKeys,
    }
  }
  checks.linuxOnly = true

  let root: string | null = null
  let listener: Awaited<ReturnType<typeof listenSyntheticHost>> | null = null
  try {
    const closure = await resolveRuntimeClosure()
    runtimeFiles = closure.binds.map(bind => bind.destination).concat(SANDBOX_SECCOMP_PATH)
    checks.exactNodeResolved = closure.binds.some(bind => bind.destination === NODE_PATH)
    checks.startupDynamicClosure = closure.binds.length > 1 && closure.binds.slice(1).every(bind =>
      path.isAbsolute(bind.source) && path.isAbsolute(bind.destination))
    checks.staticSeccompWrapper = true
    checks.bubblewrapResolved = true

    root = await mkdtemp(path.join(tmpdir(), 'wayang-direct-bwrap-'))
    const { layout, hidden, piCanary, providerCanary } = await createLayout(root)
    await Promise.all([
      validateDirectBwrapWritableRoot(layout.project),
      validateDirectBwrapWritableRoot(layout.run),
      validateDirectBwrapWritableRoot(layout.state),
    ])
    checks.writableRootValidation = true
    listener = await listenSyntheticHost()

    const probeResult = await runSandbox({
      layout,
      closure,
      hiddenHostPath: hidden,
      fixtureArgs: ['probe', hidden, String(listener.port), piCanary, providerCanary],
      timeoutMs: 5_000,
    })
    const probe = parseProbe(probeResult)
    checks.immutableSnapshot = probe.checks.snapshotReadable === true && probe.checks.snapshotImmutable === true
    checks.unrelatedHomeHidden = probe.checks.unrelatedHomeHidden === true
    checks.exactJobWorkRoot = probe.checks.jobWorkRootExact === true
    checks.writesScoped = probe.checks.projectWritable === true && probe.checks.runWritable === true &&
      probe.checks.stateWritable === true && probe.checks.rootWriteDenied === true &&
      probe.checks.runtimeWriteDenied === true && probe.checks.usrWriteDenied === true &&
      probe.checks.tmpWriteDenied === true && probe.checks.devWriteDenied === true
    checks.ambientToolsAbsent = probe.checks.shellAbsent === true && probe.checks.envAbsent === true && probe.checks.trueAbsent === true
    checks.networkNamespaceBlocksTcp = probe.checks.outboundTcpBlocked === true && listener.connections() === 0
    checks.seccompBlocksUnixSockets = probe.checks.unixSocketBlocked === true
    observedEnvironmentKeys = [...probe.environmentKeys].sort()
    const allowedEnvironmentKeys = new Set(['HOME', 'LANG', 'PATH', 'PWD'])
    const unexpectedEnvironmentKeys = observedEnvironmentKeys.filter(key => !allowedEnvironmentKeys.has(key))
    const environmentClean = probe.checks.providerStateAbsent === true && unexpectedEnvironmentKeys.length === 0
    const providerCanariesHidden = probe.checks.providerCanariesHidden === true
    checks.noPiOrProviderState = environmentClean && providerCanariesHidden
    if (!checks.noPiOrProviderState) {
      errors.push(
        `sandbox provider-state check failed; observed environment key names only: ` +
        `${observedEnvironmentKeys.join(', ') || '(none)'}; unexpected key names: ` +
        `${unexpectedEnvironmentKeys.join(', ') || '(none; an allowed key had an invalid runtime value)'}; ` +
        `synthetic provider canaries hidden: ${providerCanariesHidden}`,
      )
    }

    const adversarialModes = [
      ['peerClose', 'peer-close'],
      ['validFrameFlood', 'valid-frame-flood'],
      ['truncatedFrame', 'truncated-frame'],
      ['oversize', 'oversized-frame'],
    ] as const
    for (const [check, mode] of adversarialModes) {
      const result = await runSandbox({
        layout,
        closure,
        hiddenHostPath: hidden,
        fixtureArgs: [mode],
        timeoutMs: 2_000,
      })
      fd3AdversarialDiagnostics[check] = {
        termination: result.termination,
        protocolRejected: result.protocolRejected,
        exitCode: result.exitCode,
        signal: result.signal,
      }
      fd3AdversarialChecks[check] = result.termination === 'frame-bound' && result.protocolRejected
    }
    checks.boundedFd3Framing = probe.checks.fd3RoundTrip === true && probeResult.rpcRoundTrip &&
      !probeResult.protocolRejected && Object.values(fd3AdversarialChecks).every(Boolean)

    checks.timeoutStopsOrdinaryDescendants = await runDescendantCase(layout, closure, hidden, 'timeout')
    checks.cancelStopsOrdinaryDescendants = await runDescendantCase(layout, closure, hidden, 'cancelled')
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  } finally {
    if (listener) {
      try { await listener.close() } catch (error) { errors.push(`listener cleanup failed: ${String(error)}`) }
    }
    if (root) {
      try {
        await chmod(path.join(root, 'snapshot'), 0o755)
        await rm(root, { recursive: true, force: true })
      } catch (error) {
        errors.push(`synthetic fixture cleanup failed: ${String(error)}`)
      }
    }
  }

  const verdict = errors.length === 0 && DIRECT_BWRAP_REQUIRED_CHECKS.every(check => checks[check]) ? 'GO' : 'NO-GO'
  if (verdict === 'NO-GO' && errors.length === 0) {
    errors.push(`required checks failed: ${DIRECT_BWRAP_REQUIRED_CHECKS.filter(check => !checks[check]).join(', ')}`)
  }
  return {
    verdict,
    checks,
    errors,
    runtimeFiles,
    runtimeClosureScope: RUNTIME_CLOSURE_SCOPE,
    fd3AdversarialChecks,
    fd3AdversarialDiagnostics,
    observedEnvironmentKeys,
  }
}
