import assert from 'node:assert/strict'
import test from 'node:test'
import { accessSync, constants } from 'node:fs'
import { link, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DIRECT_BWRAP_REQUIRED_CHECKS,
  runDirectBwrapFeasibility,
  validateDirectBwrapWritableRoot,
} from './direct-bwrap-feasibility.js'

function directBwrapSkipReason(): string | false {
  if (process.platform !== 'linux') return 'direct bubblewrap feasibility is Linux-only'
  try { accessSync('/usr/bin/bwrap', constants.X_OK) }
  catch { return 'direct bubblewrap integration requires executable /usr/bin/bwrap' }
  return false
}

test('direct bubblewrap is a GO only when every Linux protected-automation requirement passes', {
  skip: directBwrapSkipReason(),
  timeout: 30_000,
}, async () => {
  const report = await runDirectBwrapFeasibility()
  assert.equal(
    report.verdict,
    'GO',
    `direct-bwrap feasibility was NO-GO:\n${report.errors.join('\n')}\n` +
      `${JSON.stringify({
        checks: report.checks,
        fd3: report.fd3AdversarialChecks,
        fd3Diagnostics: report.fd3AdversarialDiagnostics,
      }, null, 2)}`,
  )
  assert.deepEqual(
    DIRECT_BWRAP_REQUIRED_CHECKS.filter(check => !report.checks[check]),
    [],
    'GO must require every check, without exceptions',
  )
  assert.ok(report.runtimeFiles.includes('/usr/bin/node'))
  assert.ok(report.runtimeFiles.includes('/runtime/apply-seccomp'))
  assert.ok(!report.runtimeFiles.includes('/bin/sh'))
  assert.ok(!report.runtimeFiles.includes('/usr/bin/env'))
  assert.ok(!report.runtimeFiles.includes('/usr/bin/true'))
  assert.equal(report.runtimeClosureScope, 'ELF startup closure only; excludes dlopen and native addons')
  assert.deepEqual(report.fd3AdversarialChecks, {
    peerClose: true,
    validFrameFlood: true,
    truncatedFrame: true,
    oversize: true,
  })
  for (const diagnostic of Object.values(report.fd3AdversarialDiagnostics)) {
    assert.equal(diagnostic.termination, 'frame-bound')
    assert.equal(diagnostic.protocolRejected, true)
  }
  assert.ok(
    report.observedEnvironmentKeys.every(key => ['HOME', 'LANG', 'PATH', 'PWD'].includes(key)),
    `unexpected sandbox environment key names: ${report.observedEnvironmentKeys.join(', ')}`,
  )
})

test('writable-root validation rejects a synthetic hardlinked file before bind', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wayang-direct-bwrap-hardlink-'))
  try {
    const first = path.join(root, 'first.txt')
    await writeFile(first, 'synthetic\n')
    await link(first, path.join(root, 'second.txt'))
    await assert.rejects(
      validateDirectBwrapWritableRoot(root),
      /writable root contains a hardlinked file/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
