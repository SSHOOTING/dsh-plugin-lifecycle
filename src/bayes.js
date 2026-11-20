/**
 * Pure Bayesian evidence engine. No IO, no DSH imports: every decision is a
 * function of (state, signal, config, now), so it can be unit tested directly.
 *
 * Model: one scalar log-likelihood ratio L per plugin.
 *   H1 = "the user still uses this plugin"
 *   H0 = "the plugin is dormant"
 *   theta = P(H1 | evidence) = sigmoid(logit(prior) + L)
 *
 * Using LLR instead of raw counts lets signals of very different strength be
 * combined in one number, and gives the decision thresholds a direct
 * Bayesian interpretation.
 */

export const SIGNAL_KINDS = Object.freeze([
  'tool', 'command', 'skill', 'hook', 'config',
  'exposure', 'feedback', 'missing_tool', 'restore', 'external_enable',
])

export const DEFAULT_WEIGHTS = Object.freeze({
  tool: 5.0,
  command: 4.5,
  skill: 2.0,
  hook: 2.0,
  config: 8.0,
  exposure: -0.18,
  feedback: 4.0,
  missing_tool: 8.0,
  restore: 10.0,
  external_enable: 10.0,
})

const DAY = 86_400_000

export function sigmoid(x) {
  if (x >= 0) {
    const e = Math.exp(-x)
    return 1 / (1 + e)
  }
  const e = Math.exp(x)
  return e / (1 + e)
}

export function logit(p) {
  const v = Math.min(1 - 1e-9, Math.max(1e-9, p))
  return Math.log(v / (1 - v))
}

/** Posterior probability that the plugin is still in use. */
export function posterior(logL, prior = 0.5) {
  return sigmoid(logit(prior) + logL)
}

/**
 * Exponential forgetting. Old evidence loses influence, but decay alone never
 * pushes L below zero: a plugin can never become "unuse-worthy" merely by
 * growing old. Only real negative evidence (exposure with no use) does that.
 */
export function decayLogL(logL, days, halfLifeDays = 30) {
  if (!Number.isFinite(days) || days <= 0) return logL
  const half = Math.max(1, halfLifeDays)
  const decayed = logL * Math.pow(0.5, days / half)
  return Math.abs(decayed) < 1e-6 ? 0 : Math.max(0, decayed)
}

export function createState(key, moduleName, now = Date.now(), config = {}) {
  return {
    key,
    moduleName,
    status: 'observing',
    logL: 0,
    exposures: 0,
    positiveSignals: 0,
    cleanSessions: 0,
    failureEvents: 0,
    restoreRequested: false,
    lastUsedAt: null,
    firstObservedAt: now,
    lastEvaluatedAt: now,
    disabledAt: null,
    toolSnapshot: [],
    exemptReason: null,
    guardOk: false,
    entryId: null,
    updatedAt: now,
    configVersion: config.policyVersion ?? 1,
  }
}

function weightOf(kind, config) {
  const configured = config?.weights?.[kind]
  if (typeof configured === 'number' && Number.isFinite(configured)) return configured
  return DEFAULT_WEIGHTS[kind] ?? 0
}

/**
 * Fold one observed signal into a plugin state. Returns a NEW state object.
 */
export function ingest(state, signal, config = {}, now = Date.now()) {
  const weight = weightOf(signal.kind, config)
  const next = { ...state, updatedAt: now }
  next.logL = state.logL + weight

  if (weight > 0) {
    next.positiveSignals = state.positiveSignals + 1
    next.lastUsedAt = now
  }

  switch (signal.kind) {
    case 'exposure':
      next.exposures = state.exposures + 1
      if (state.status === 'probation') next.cleanSessions = state.cleanSessions + 1
      break
    case 'missing_tool':
    case 'feedback':
      if (state.status === 'probation') {
        next.failureEvents = state.failureEvents + 1
        // Marker consumed by decide(): the caller must actually re-enable the
        // plugin through the actuator, not just flip a local status field.
        next.restoreRequested = true
      }
      break
    case 'restore':
    case 'external_enable':
    case 'config':
      next.status = 'restored_keep'
      next.exemptReason = signal.reason ?? `${signal.kind} by user`
      next.disabledAt = null
      break
    default:
      break
  }

  if (signal.toolNames?.length) {
    next.toolSnapshot = [...new Set([...state.toolSnapshot, ...signal.toolNames])]
  }
  return next
}

/**
 * Decide the next action for a state. Returns null when nothing should change.
 * The engine supplies guardOk (addressable, not protected, observable, etc.).
 */
export function decide(state, config = {}, now = Date.now()) {
  if (state.status === 'restored_keep' || state.status === 'exempt' || state.status === 'confirmed_unused') {
    return null
  }

  const theta = posterior(state.logL, config.prior ?? 0.5)
  const ageDays = Math.max(0, (now - state.firstObservedAt) / DAY)

  if (state.status === 'observing') {
    if (!state.guardOk) return null
    if (state.exposures < (config.minExposures ?? 20)) return null
    if (ageDays < (config.minAgeDays ?? 14)) return null
    if (theta <= (config.thetaDisable ?? 0.10)) {
      return { action: 'disable', theta, reason: 'low-usage posterior below disable threshold' }
    }
    return null
  }

  if (state.status === 'probation') {
    if (state.restoreRequested || state.failureEvents > 0) {
      return { action: 'restore', theta: 1, reason: `probation failure (${state.failureEvents})` }
    }
    if (theta >= (config.thetaRestore ?? 0.25)) {
      return { action: 'restore', theta, reason: 'usage evidence reappeared during probation' }
    }
    const probeDays = Math.max(0, (now - (state.disabledAt ?? now)) / DAY)
    if (theta <= (config.thetaConfirm ?? 0.03)
      && state.cleanSessions >= (config.cleanSessions ?? 8)
      && probeDays >= (config.probeDays ?? 10)) {
      return { action: 'confirm', theta, reason: 'probation passed with no failure signals' }
    }
    return null
  }

  return null
}

/** Human-readable evidence summary for the status tool / UI. */
export function explain(state, config = {}) {
  const theta = posterior(state.logL, config.prior ?? 0.5)
  return {
    key: state.key,
    moduleName: state.moduleName,
    status: state.status,
    probabilityInUse: Number(theta.toFixed(4)),
    logL: Number(state.logL.toFixed(3)),
    exposures: state.exposures,
    positiveSignals: state.positiveSignals,
    cleanSessions: state.cleanSessions,
    failureEvents: state.failureEvents,
    lastUsedAt: state.lastUsedAt ? new Date(state.lastUsedAt).toISOString() : null,
    guardOk: state.guardOk,
    exemptReason: state.exemptReason,
  }
}
