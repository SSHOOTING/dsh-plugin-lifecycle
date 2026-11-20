import { createState, decide, decayLogL, explain, ingest as ingestSignal } from './bayes.js'

const DAY = 86_400_000

/**
 * Orchestrates per-plugin state transitions. Pure with respect to IO: every
 * side effect goes through the injected `repo` and `actuator` ports.
 */
export function createEngine({ repo, config, actuator, clock = () => Date.now(), onEvent = () => {} }) {
  const states = new Map()
  // Events arrive concurrently from the session bus. Read-modify-write on a
  // plugin state must be serialized or evidence from simultaneous tool calls
  // is silently lost.
  let tail = Promise.resolve()
  function serialize(task) {
    const result = tail.then(task, task)
    tail = result.catch(() => {})
    return result
  }

  function emit(type, payload) {
    onEvent({ type, at: clock(), ...payload })
  }

  function remember(state) {
    states.set(state.key, state)
    return state
  }

  async function persist(state, signal, decision) {
    await repo.saveState(state)
    await repo.appendEvent({
      at: clock(),
      pluginKey: state.key,
      moduleName: state.moduleName,
      kind: signal?.kind ?? decision?.action ?? 'evaluate',
      weight: signal?.weight ?? 0,
      status: state.status,
      theta: decision?.theta,
      detail: signal?.detail ?? decision?.reason,
    })
  }

  async function ensureState(plugin) {
    const existing = states.get(plugin.moduleName)
    if (existing) {
      return {
        ...existing,
        entryId: plugin.entryId,
        guardOk: plugin.addressable && !plugin.protected && !plugin.unobservable,
      }
    }
    return {
      ...createState(plugin.moduleName, plugin.moduleName, clock(), config),
      entryId: plugin.entryId,
      guardOk: plugin.addressable && !plugin.protected && !plugin.unobservable,
      exemptReason: plugin.protected
        ? 'protected module'
        : plugin.unobservable
          ? 'no attributable usage surface'
          : plugin.addressable
            ? null
            : 'not addressable through profile patch',
      status: plugin.protected || plugin.unobservable || !plugin.addressable ? 'exempt' : 'observing',
    }
  }

  async function init() {
    const stored = await repo.loadStates()
    for (const state of stored) states.set(state.key, state)
    const managed = await actuator.refresh()
    for (const plugin of managed) remember(await ensureState(plugin))
    for (const [key, state] of states) {
      if (!managed.some(p => p.moduleName === key) && state.status !== 'restored_keep') {
        remember({ ...state, status: 'exempt', exemptReason: 'plugin no longer installed', guardOk: false })
      }
    }
    emit('initialized', { plugins: states.size })
    return status()
  }

  async function applyDecision(state, decision) {
    if (!decision) return state
    emit('decision', { key: state.key, ...decision })

    if (config.dryRun === true && decision.action !== 'confirm') {
      emit('dry-run', { key: state.key, action: decision.action })
      return state
    }

    if (decision.action === 'disable') {
      const snapshot = actuator.snapshotSurfaces?.(state.key) ?? []
      const result = await actuator.disable(state)
      if (!result.ok) {
        emit('action-failed', { key: state.key, action: 'disable', error: result.error })
        return { ...state, guardOk: false, exemptReason: `disable failed: ${result.error}` }
      }
      const next = {
        ...state,
        status: 'probation',
        disabledAt: clock(),
        toolSnapshot: [...new Set([...state.toolSnapshot, ...snapshot])],
        updatedAt: clock(),
      }
      emit('disabled', { key: state.key, moduleName: state.moduleName })
      return next
    }

    if (decision.action === 'restore') {
      const result = await actuator.enable(state)
      if (!result.ok) {
        emit('action-failed', { key: state.key, action: 'restore', error: result.error })
        return state
      }
      const next = {
        ...state,
        status: 'restored_keep',
        exemptReason: 'restored during probation',
        disabledAt: null,
        restoreRequested: false,
        updatedAt: clock(),
      }
      emit('restored', { key: state.key, moduleName: state.moduleName })
      return next
    }

    if (decision.action === 'confirm') {
      const next = { ...state, status: 'confirmed_unused', updatedAt: clock() }
      if (config.autoUninstall === true && state.bundleName) {
        const result = await actuator.uninstall(state.bundleName)
        emit(result.ok ? 'uninstalled' : 'action-failed', { key: state.key, error: result.error })
      }
      emit('confirmed', { key: state.key, moduleName: state.moduleName })
      return next
    }

    return state
  }

  async function ingestNow(signal) {
    const current = states.get(signal.pluginKey)
    if (!current) return null
    const weighted = {
      ...signal,
      weight: config?.weights?.[signal.kind] ?? undefined,
    }
    const next = ingestState(current, weighted)
    const decision = decide(next, config, clock())
    const final = await applyDecision(next, decision)
    remember(final)
    await persist(final, weighted, decision)
    return final
  }

  function ingestState(state, signal) {
    return ingestSignal(state, signal, config, clock())
  }

  async function evaluateNow() {
    const now = clock()
    for (const [key, state] of states) {
      if (state.status === 'restored_keep' || state.status === 'exempt' || state.status === 'confirmed_unused') continue
      const days = (now - (state.lastEvaluatedAt ?? now)) / DAY
      const decayed = days > 0
        ? { ...state, logL: decayLogL(state.logL, days, config.halfLifeDays ?? 30), lastEvaluatedAt: now }
        : { ...state, lastEvaluatedAt: now }
      const decision = decide(decayed, config, now)
      const final = await applyDecision(decayed, decision)
      remember(final)
      await repo.saveState(final)
      if (decision) emit('evaluated', { key, ...decision })
    }
  }

  async function reconcileNow() {
    const managed = await actuator.refresh()
    const seen = new Set()
    for (const plugin of managed) {
      seen.add(plugin.moduleName)
      const current = states.get(plugin.moduleName)
      const next = await ensureState(plugin)
      if (!current) {
        remember(next)
        await repo.saveState(next)
        continue
      }
      // An external enable (Web page, CLI, another tool) is a strong signal
      // that the plugin is wanted: restore and pin it permanently.
      if (!plugin.enabled && (current.status === 'observing' || current.status === 'restored_keep')) {
        const restored = ingestState(next, { kind: 'external_enable', detail: 'disabled externally' })
        remember(restored)
        await repo.saveState(restored)
        continue
      }
      if (plugin.enabled && (current.status === 'probation' || current.status === 'confirmed_unused')) {
        const restored = ingestState(next, { kind: 'external_enable', detail: 'enabled externally' })
        remember(restored)
        await repo.saveState(restored)
        emit('external-restore', { key: plugin.moduleName })
        continue
      }
      remember(next)
    }
    for (const [key, state] of states) {
      if (!seen.has(key) && state.status !== 'restored_keep' && state.status !== 'exempt') {
        const gone = { ...state, status: 'exempt', exemptReason: 'plugin no longer installed', guardOk: false }
        remember(gone)
        await repo.saveState(gone)
      }
    }
    return status()
  }

  async function manualNow(action, key) {
    const state = states.get(key)
    if (!state) return { ok: false, error: `unknown plugin: ${key}` }
    if (action === 'keep') {
      const next = { ...state, status: 'restored_keep', exemptReason: 'marked keep by user', disabledAt: null }
      remember(next)
      await repo.saveState(next)
      return { ok: true }
    }
    if (action === 'resume') {
      const next = {
        ...state,
        status: 'observing',
        exemptReason: null,
        logL: 0,
        exposures: 0,
        cleanSessions: 0,
        failureEvents: 0,
        firstObservedAt: clock(),
        lastEvaluatedAt: clock(),
      }
      remember(next)
      await repo.saveState(next)
      return { ok: true }
    }
    if (action === 'restore') {
      const result = await actuator.enable(state)
      if (!result.ok) return result
      const next = { ...state, status: 'restored_keep', exemptReason: 'restored by user', disabledAt: null }
      remember(next)
      await repo.saveState(next)
      emit('restored', { key, moduleName: state.moduleName, manual: true })
      return { ok: true }
    }
    return { ok: false, error: `unknown action: ${action}` }
  }

  function status(key) {
    if (key) {
      const state = states.get(key)
      return state ? explain(state, config) : null
    }
    return [...states.values()].map(state => explain(state, config))
  }

  function candidates() {
    return [...states.values()].map(state => ({
      ...explain(state, config),
      decision: decide(state, config, clock()),
    })).filter(row => row.decision)
  }

  return {
    init,
    ingest: signal => serialize(() => ingestNow(signal)),
    evaluate: () => serialize(evaluateNow),
    reconcile: () => serialize(reconcileNow),
    manual: (action, key) => serialize(() => manualNow(action, key)),
    status,
    candidates,
    states,
  }
}
