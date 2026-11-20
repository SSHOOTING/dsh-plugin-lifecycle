import { Config, inject, name } from './config.js'
import { createAttribution } from './attribution.js'
import { createActuator } from './actuator.js'
import { createSignalHub } from './signals.js'
import { openRepository } from './storage.js'
import { createEngine } from './state-machine.js'
import { registerLifecycleCommand } from './commands.js'
import { registerLifecycleTool } from './tool.js'

export { Config, inject, name }

function findByToolSnapshot(states, toolName) {
  for (const state of states.values()) {
    if ((state.status === 'probation' || state.status === 'confirmed_unused')
      && state.toolSnapshot.includes(toolName)) return state
  }
  return null
}

/**
 * Cordis plugin entry. Install with:
 *   dsh plugin --profile web add dsh-plugin-lifecycle
 */
export async function apply(ctx, config) {
  const log = (...args) => ctx.logger?.info?.('[plugin-lifecycle]', ...args)

  const attribution = createAttribution(ctx, config)
  const repo = await openRepository(ctx, { maxEvents: config.maxEvents })
  const actuator = createActuator(ctx, { config, attribution })

  let engine
  function onEvent(event) {
    switch (event.type) {
      case 'disabled':
        log('auto-disabled dormant plugin', event.moduleName)
        break
      case 'restored':
        log('restored plugin', event.moduleName, event.manual ? '(manual)' : '')
        break
      case 'confirmed':
        log('confirmed unused plugin', event.moduleName)
        break
      case 'action-failed':
        log('action failed', event.action, event.key, event.error)
        break
      case 'dry-run':
        log('dry-run candidate', event.action, event.key)
        break
      default:
        break
    }
    // A client companion (or another plugin) can listen for this to render UI.
    try {
      ctx.emit('plugin-lifecycle/event', event)
    } catch { /* observers must not break the lifecycle engine */ }
  }

  engine = createEngine({ repo, config, actuator, onEvent })

  function emit(signal) {
    const ingestSafe = next => {
      try {
        const pending = engine.ingest(next)
        pending?.catch?.(error => log('ingest failed', error?.message ?? String(error)))
      } catch (error) {
        log('ingest failed', error?.message ?? String(error))
      }
    }
    if (signal.pluginKey === '*') {
      // Feedback is attributed to every plugin currently in probation.
      for (const state of engine.states.values()) {
        if (state.status === 'probation') ingestSafe({ ...signal, pluginKey: state.key })
      }
      return
    }
    ingestSafe(signal)
  }

  await engine.init()

  createSignalHub(ctx, {
    attribution,
    emit,
    config,
    exposureTargets: () => engine.status()
      .filter(row => row.status === 'observing' && row.guardOk)
      .map(row => ({ key: row.key })),
    findByToolSnapshot: name => findByToolSnapshot(engine.states, name),
  })

  // The manager emits this only for its own operations; external patch edits
  // are caught by the periodic reconcile below.
  ctx.on('plugin-manager/changed', () => { void engine.reconcile() })

  ctx.interval(() => { void engine.evaluate() }, Math.max(10_000, config.evaluateIntervalMs))
  ctx.interval(() => { void engine.reconcile() }, Math.max(60_000, config.reconcileIntervalMs))

  registerLifecycleTool(ctx, engine, config)
  registerLifecycleCommand(ctx, engine, config)

  log('ready', { enabled: config.enabled, dryRun: config.dryRun, plugins: engine.status().length })
}
