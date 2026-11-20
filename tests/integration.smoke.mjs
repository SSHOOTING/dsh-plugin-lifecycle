/**
 * Wiring smoke test with a fake Cordis context. Run manually:
 *   node tests/integration.smoke.mjs
 * It exercises the real plugin entry, storage schema, attribution hooks,
 * event hub, engine, tool and command registration without a DSH process.
 */
import assert from 'node:assert/strict'
import { apply, name } from '../src/index.js'

const listeners = new Map()
const tools = []
const commands = []
const writes = []
const intervals = []

const fakeDomain = () => {
  const tables = { plugins: new Map(), events: new Map() }
  let globalValue = { schemaVersion: 1, lastEvaluatedAt: 0, policyVersion: 1 }
  const handle = bucket => ({
    get: k => bucket.get(k),
    entries: () => bucket.entries(),
    keys: () => bucket.keys(),
    get size() { return bucket.size },
    async put(k, v) { bucket.set(k, structuredClone(v)) },
    async delete(k) { return bucket.delete(k) },
    async update(k, fn) { const next = fn(bucket.get(k)); bucket.set(k, next); return next },
  })
  return {
    table: n => handle(tables[n]),
    global: { get: () => globalValue, async set(v) { globalValue = v } },
    async close() {},
  }
}

const pluginRow = (moduleName, enabled = true) => ({
  entryId: `entry:${moduleName}`,
  moduleName,
  enabled,
  fiberPhase: 'active',
  patchId: `patch:${moduleName}`,
})

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: (...a) => console.error('CTX ERROR', ...a) },
  on(event, listener) {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(listener)
  },
  emit(event, ...args) {
    for (const l of listeners.get(event) ?? []) l(...args)
  },
  effect(fn) { const d = fn(); return () => d?.() },
  interval(fn, ms) { intervals.push({ fn, ms }); return () => {} },
  tools: { register: def => { tools.push(def); return () => {} }, schemas: () => tools.map(t => ({ name: t.name })) },
  commands: { register: def => { commands.push(def); return () => {} } },
  sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
  get: () => ({}),
  pluginManager: {
    async listPlugins() { return [pluginRow('@me/useless-plugin'), pluginRow('@me/useful-plugin')] },
    async listBundles() { return [] },
    async setPluginEnabled(id, enabled) { writes.push([id, enabled]); return { changed: true, application: 'applied' } },
    async removeBundle() { return { changed: true } },
  },
  storageDomain: { async open() { return fakeDomain() } },
}

const config = {
  enabled: true,
  dryRun: false,
  prior: 0.5,
  thetaDisable: 0.10,
  thetaKeep: 0.30,
  thetaRestore: 0.25,
  thetaConfirm: 0.03,
  minExposures: 3,
  minAgeDays: 0,
  cleanSessions: 2,
  probeDays: 0,
  halfLifeDays: 30,
  protectedModules: [],
  unobservablePatterns: [],
  weights: {
    tool: 5, command: 4.5, skill: 2, hook: 2, config: 8,
    exposure: -0.18, feedback: 4, missing_tool: 8, restore: 10,
  },
  maxEvents: 50,
  evaluateIntervalMs: 60000,
  reconcileIntervalMs: 600000,
  notifyOnDisable: false,
}

assert.equal(name, 'plugin-lifecycle')
await apply(ctx, config)
assert.equal(tools.length, 1, 'tool should be registered')
assert.equal(commands.length, 1, 'command should be registered')
assert.equal(intervals.length, 2, 'evaluation and reconciliation timers should be registered')

// attribute tool registrations through the real loader/patch-context hook
function registerAs(moduleName, toolName) {
  const entry = {
    id: `entry:${moduleName}`,
    options: { name: moduleName },
    context: Object.create({ tools: { register(def) { tools.push(def) } } }),
  }
  for (const l of listeners.get('loader/patch-context') ?? []) l(entry, () => undefined)
  entry.context.tools.register({ name: toolName })
}
registerAs('@me/useful-plugin', 'useful_tool')
registerAs('@me/useless-plugin', 'ghost_tool')

const session = {}
const fire = (type, data) => {
  for (const l of listeners.get('session/event') ?? []) l(session, { type, data })
}

fire('user/message', {})
fire('user/message', {})
fire('assistant/message', {})
fire('tool/call', { name: 'useful_tool' })

for (let i = 0; i < 15; i++) {
  const s = {}
  for (const l of listeners.get('session/event') ?? []) l(s, { type: 'user/message', data: {} })
  for (const l of listeners.get('session/event') ?? []) l(s, { type: 'user/message', data: {} })
  for (const l of listeners.get('session/event') ?? []) l(s, { type: 'assistant/message', data: {} })
}

await new Promise(resolve => setImmediate(resolve))

const disabled = writes.filter(([, enabled]) => enabled === false)
assert.ok(disabled.some(([id]) => id.includes('useless-plugin')), 'dormant plugin should be disabled')
assert.ok(!disabled.some(([id]) => id.includes('useful-plugin')), 'used plugin must stay enabled')

// the model still wants the tool from the disabled plugin: immediate restore
fire('tool/call', { name: 'ghost_tool' })
await new Promise(resolve => setImmediate(resolve))
assert.ok(writes.some(([id, enabled]) => enabled === true && id.includes('useless-plugin')), 'missing tool should restore the plugin')

console.log('integration smoke: OK')
