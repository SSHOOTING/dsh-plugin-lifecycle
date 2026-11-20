/**
 * The only module allowed to mutate profile state. All writes are serialized
 * because the plugin manager takes a profile write lock and wraps operations
 * in a non-reentrant HMR transaction.
 */
export function createActuator(ctx, { config, attribution } = {}) {
  let tail = Promise.resolve()
  let lastInventory = []

  function enqueue(task) {
    const result = tail.then(task, task)
    tail = result.catch(() => {})
    return result
  }

  function isProtected(moduleName) {
    const list = config?.protectedModules ?? []
    if (typeof moduleName !== 'string') return true
    return list.some(entry => moduleName === entry || moduleName.startsWith(`${entry}/`))
  }

  function isUnobservable(moduleName) {
    const patterns = config?.unobservablePatterns ?? []
    return patterns.some(pattern => {
      if (typeof pattern !== 'string') return false
      return pattern.endsWith('*')
        ? moduleName.startsWith(pattern.slice(0, -1))
        : moduleName === pattern
    })
  }

  async function refresh() {
    const rows = await ctx.pluginManager.listPlugins()
    let bundles = []
    try {
      bundles = await ctx.pluginManager.listBundles()
    } catch { /* bundle metadata is optional for our decision */ }

    const bundleByModule = new Map()
    for (const bundle of bundles ?? []) {
      for (const row of bundle.rows ?? []) {
        if (row?.moduleName) bundleByModule.set(row.moduleName, bundle.name)
      }
    }

    lastInventory = (rows ?? []).map(row => {
      const moduleName = row.moduleName ?? ''
      const readOnly = Boolean(row.readOnlyReason)
      const protectedModule = isProtected(moduleName)
      return {
        entryId: row.entryId,
        moduleName,
        patchId: row.patchId,
        enabled: Boolean(row.enabled),
        fiberPhase: row.fiberPhase,
        bundleName: bundleByModule.get(moduleName),
        addressable: Boolean(row.patchId) && !readOnly,
        protected: protectedModule || readOnly,
        unobservable: isUnobservable(moduleName),
      }
    })
    return lastInventory
  }

  async function setEnabled(entryId, enabled) {
    if (!entryId) return { ok: false, error: 'missing entryId' }
    return enqueue(async () => {
      try {
        const result = await ctx.pluginManager.setPluginEnabled(entryId, enabled)
        const failed = result?.error
          || result?.application === 'failed'
          || result?.application === 'cancelled'
          || result?.application === 'overridden'
        if (failed) {
          return {
            ok: false,
            error: result?.error?.code ?? result?.application ?? 'unknown failure',
            result,
          }
        }
        return { ok: true, result }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  return {
    refresh,
    inventory: () => lastInventory,
    disable: state => setEnabled(state.entryId, false),
    enable: state => setEnabled(state.entryId, true),
    snapshotSurfaces: key => attribution?.snapshot?.(key) ?? [],
    uninstall: bundleName => enqueue(async () => {
      try {
        const result = await ctx.pluginManager.removeBundle(bundleName)
        return result?.error ? { ok: false, error: result.error.code } : { ok: true, result }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }),
  }
}
