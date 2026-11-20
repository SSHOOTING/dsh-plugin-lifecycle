import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createState, decide, decayLogL, DEFAULT_WEIGHTS,
  ingest, posterior, sigmoid, logit,
} from '../src/bayes.js'

const DAY = 86_400_000
const T0 = 1_700_000_000_000
const cfg = {
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

test('logit/sigmoid round trip', () => {
  assert.ok(Math.abs(sigmoid(logit(0.73)) - 0.73) < 1e-9)
  assert.equal(posterior(0), 0.5)
  assert.ok(posterior(3) > 0.9)
})

test('decay never pushes L below zero by itself', () => {
  assert.equal(decayLogL(1.5, 1000, 30), 0)
  assert.equal(decayLogL(-2, 1000, 30), 0)
  assert.ok(decayLogL(4, 5, 30) > 0 && decayLogL(4, 5, 30) < 4)
})

test('plugin used every session is never disabled', () => {
  let state = { ...createState('p', 'p', T0, cfg), guardOk: true }
  for (let i = 0; i < 40; i++) {
    const now = T0 + i * DAY
    state = ingest(state, { kind: 'tool' }, cfg, now)
    state = ingest(state, { kind: 'exposure' }, cfg, now)
    assert.equal(decide(state, cfg, now), null)
  }
  assert.ok(posterior(state.logL) > 0.9)
})

test('30 exposures with zero use crosses the disable threshold after min age', () => {
  let state = { ...createState('p', 'p', T0, cfg), guardOk: true }
  for (let i = 0; i < 30; i++) {
    const now = T0 + i * DAY
    state = ingest(state, { kind: 'exposure' }, cfg, now)
  }
  const d = decide(state, cfg, T0 + 30 * DAY)
  assert.equal(d?.action, 'disable')
  assert.ok(d.theta < 0.10)
})

test('minimum exposure guard blocks early decisions', () => {
  let state = { ...createState('p', 'p', T0, cfg), guardOk: true }
  for (let i = 0; i < 3; i++) state = ingest(state, { kind: 'exposure' }, cfg, T0 + i * DAY)
  assert.equal(decide(state, cfg, T0 + 30 * DAY), null)
})

test('unobservable / unaddressable plugin never becomes a candidate', () => {
  let state = createState('p', 'p', T0, cfg)
  state.guardOk = false
  for (let i = 0; i < 40; i++) state = ingest(state, { kind: 'exposure' }, cfg, T0 + i * DAY)
  assert.equal(decide(state, cfg, T0 + 40 * DAY), null)
})

test('probation: clean sessions and time lead to confirmation', () => {
  let state = {
    ...createState('p', 'p', T0, cfg),
    guardOk: true,
    status: 'probation',
    disabledAt: T0,
    logL: -3,
  }
  for (let i = 0; i < 9; i++) {
    state = ingest(state, { kind: 'exposure' }, cfg, T0 + (i + 1) * DAY)
  }
  const d = decide(state, cfg, T0 + 14 * DAY)
  assert.equal(d?.action, 'confirm')
})

test('probation: calling a vanished tool immediately restores', () => {
  const state = {
    ...createState('p', 'p', T0, cfg),
    status: 'probation',
    toolSnapshot: ['old_tool'],
  }
  const next = ingest(state, { kind: 'missing_tool', toolNames: ['old_tool'] }, cfg, T0 + DAY)
  assert.equal(next.status, 'probation')
  assert.equal(next.failureEvents, 1)
  assert.equal(next.restoreRequested, true)
  const decision = decide(next, cfg, T0 + DAY)
  assert.equal(decision?.action, 'restore')
  assert.equal(decide({ ...next, status: 'restored_keep' }, cfg, T0 + DAY), null)
})

test('explicit restore pins the plugin permanently', () => {
  let state = { ...createState('p', 'p', T0, cfg), guardOk: true }
  for (let i = 0; i < 30; i++) state = ingest(state, { kind: 'exposure' }, cfg, T0 + i * DAY)
  state = ingest(state, { kind: 'restore' }, cfg, T0 + 31 * DAY)
  assert.equal(state.status, 'restored_keep')
  assert.equal(decide(state, cfg, T0 + 60 * DAY), null)
})

test('a single use flips a dormant plugin back above the keep threshold', () => {
  let state = { ...createState('p', 'p', T0, cfg), guardOk: true }
  for (let i = 0; i < 30; i++) state = ingest(state, { kind: 'exposure' }, cfg, T0 + i * DAY)
  assert.ok(posterior(state.logL) < cfg.thetaDisable)
  state = ingest(state, { kind: 'tool' }, cfg, T0 + 31 * DAY)
  assert.ok(posterior(state.logL) > cfg.thetaKeep)
  assert.equal(decide(state, cfg, T0 + 31 * DAY), null)
})
