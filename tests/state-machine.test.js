import test from 'node:test'
import assert from 'node:assert/strict'
import { createEngine } from '../src/state-machine.js'
import { DEFAULT_WEIGHTS } from '../src/bayes.js'

const DAY = 86_400_000
const T0 = 1_700_000_000_000

function harness({ managed, dryRun = false, now = T0 } = {}) {
  const stored = new Map()
  const events = []
  let clock = now
  const repo = {
    async loadStates() { return [...stored.values()] },
    async saveState(s) { stored.set(s.key, structuredClone(s)) },
    async appendEvent(e) { events.push(e) },
  }
  const calls = []
  const actuator = {
    async refresh() { return managed ?? [] },
    snapshotSurfaces() { return ['x_tool'] },
    async disable(state) {
      calls.push(['disable', state.key])
      return { ok: true }
    },
    async enable(state) {
      calls.push(['enable', state.key])
      return { ok: true }
    },
    async uninstall(name) {
      calls.push(['uninstall', name])
      return { ok: true }
    },
  }
  const config = {
    dryRun,
    prior: 0.5,
    thetaDisable: 0.10,
    thetaKeep: 0.30,
    thetaRestore: 0.25,
    thetaConfirm: 0.03,
    minExposures: 20,
    minAgeDays: 14,
    cleanSessions: 8,
    probeDays: 10,
    halfLifeDays: 30,
    weights: DEFAULT_WEIGHTS,
  }
  const emitted = []
  const engine = createEngine({
    repo, actuator, config,
    clock: () => clock,
    onEvent: e => emitted.push(e),
  })
  return {
    engine, calls, events, emitted,
    advance: days => { clock += days * DAY },
    setNow: t => { clock = t },
    stored,
  }
}

test('init creates observing states only for addressable, observable plugins', async () => {
  const h = harness({
    managed: [
      { moduleName: 'good', entryId: 'e1', enabled: true, addressable: true, protected: false, unobservable: false },
      { moduleName: 'protected', entryId: 'e2', enabled: true, addressable: true, protected: true, unobservable: false },
      { moduleName: 'passive', entryId: 'e3', enabled: true, addressable: true, protected: false, unobservable: true },
      { moduleName: 'locked', entryId: 'e4', enabled: true, addressable: false, protected: false, unobservable: false },
    ],
  })
  await h.engine.init()
  const all = h.engine.status()
  assert.equal(all.length, 4)
  assert.equal(all.find(r => r.key === 'good').status, 'observing')
  assert.equal(all.find(r => r.key === 'protected').status, 'exempt')
  assert.equal(all.find(r => r.key === 'passive').status, 'exempt')
  assert.equal(all.find(r => r.key === 'locked').status, 'exempt')
})

test('idle plugin is disabled, then confirmed after a clean probation', async () => {
  const h = harness({
    managed: [{ moduleName: 'idle', entryId: 'e1', enabled: true, addressable: true, protected: false, unobservable: false }],
  })
  await h.engine.init()
  for (let i = 0; i < 25; i++) {
    await h.engine.ingest({ pluginKey: 'idle', kind: 'exposure' })
    h.advance(1)
  }
  assert.deepEqual(h.calls[0], ['disable', 'idle'])
  assert.equal(h.engine.status('idle').status, 'probation')
  assert.ok(h.stored.get('idle').toolSnapshot.includes('x_tool'))

  for (let i = 0; i < 9; i++) {
    await h.engine.ingest({ pluginKey: 'idle', kind: 'exposure' })
    h.advance(1)
  }
  assert.equal(h.engine.status('idle').status, 'confirmed_unused')
})

test('missing tool during probation restores and pins the plugin', async () => {
  const h = harness({
    managed: [{ moduleName: 'idle', entryId: 'e1', enabled: true, addressable: true, protected: false, unobservable: false }],
  })
  await h.engine.init()
  for (let i = 0; i < 25; i++) {
    await h.engine.ingest({ pluginKey: 'idle', kind: 'exposure' })
    h.advance(1)
  }
  await h.engine.ingest({ pluginKey: 'idle', kind: 'missing_tool', toolNames: ['x_tool'] })
  assert.equal(h.engine.status('idle').status, 'restored_keep')
  assert.deepEqual(h.calls.at(-1), ['enable', 'idle'])
})

test('dry run reports candidates without touching the profile', async () => {
  const h = harness({
    dryRun: true,
    managed: [{ moduleName: 'idle', entryId: 'e1', enabled: true, addressable: true, protected: false, unobservable: false }],
  })
  await h.engine.init()
  for (let i = 0; i < 25; i++) {
    await h.engine.ingest({ pluginKey: 'idle', kind: 'exposure' })
    h.advance(1)
  }
  assert.equal(h.calls.length, 0)
  assert.equal(h.engine.status('idle').status, 'observing')
  assert.ok(h.emitted.some(e => e.type === 'dry-run'))
})

test('external re-enable is detected on reconcile and pins the plugin', async () => {
  const managed = [{ moduleName: 'idle', entryId: 'e1', enabled: true, addressable: true, protected: false, unobservable: false }]
  const h = harness({ managed })
  await h.engine.init()
  for (let i = 0; i < 25; i++) {
    await h.engine.ingest({ pluginKey: 'idle', kind: 'exposure' })
    h.advance(1)
  }
  assert.equal(h.engine.status('idle').status, 'probation')
  // our own disable is reflected in the live inventory as enabled=false
  managed[0].enabled = false
  await h.engine.reconcile()
  assert.equal(h.engine.status('idle').status, 'probation')
  // the user re-enables it through the Web page or CLI
  managed[0].enabled = true
  await h.engine.reconcile()
  assert.equal(h.engine.status('idle').status, 'restored_keep')
})

test('manual keep and resume change the management state', async () => {
  const h = harness({
    managed: [{ moduleName: 'p', entryId: 'e1', enabled: true, addressable: true, protected: false, unobservable: false }],
  })
  await h.engine.init()
  assert.equal((await h.engine.manual('keep', 'p')).ok, true)
  assert.equal(h.engine.status('p').status, 'restored_keep')
  assert.equal((await h.engine.manual('resume', 'p')).ok, true)
  assert.equal(h.engine.status('p').status, 'observing')
  assert.equal(h.engine.status('p').probabilityInUse, 0.5)
})
