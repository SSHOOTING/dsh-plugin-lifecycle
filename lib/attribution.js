/**
 * Maps runtime surface names (tool / command / skill names) back to the Loader
 * entry that registered them.
 *
 * DSH's invocation events carry names only — never a plugin id — so this map
 * is the bridge between "tool X was called" and "plugin Y was used".
 *
 * Three layers, most reliable first:
 *   1. wrap registration on each entry context via `loader/patch-context`;
 *   2. diff the global registries after an entry becomes ACTIVE;
 *   3. user-supplied explicit name-prefix mapping in config.
 */

const SURFACES = [
  ['tools', 'tool'],
  ['commands', 'command'],
  ['skills', 'skill'],
]

function surfaceKey(kind, name) {
  return `${kind}:${name}`
}

export function createAttribution(ctx, config = {}) {
  /** @type {Map<string, {entryId: string, moduleName: string}>} */
  const map = new Map()
  /** @type {Map<string, {moduleName: string, toolNames: Set<string>}>} */
  const byModule = new Map()
  const known = { tool: new Set(), command: new Set(), skill: new Set() }
  let lastActive = null

  function register(kind, name, entryId, moduleName) {
    if (!name || !moduleName) return
    map.set(surfaceKey(kind, name), { entryId, moduleName })
    let record = byModule.get(moduleName)
    if (!record) {
      record = { moduleName, toolNames: new Set() }
      byModule.set(moduleName, record)
    }
    if (kind === 'tool' || kind === 'command') record.toolNames.add(name)
  }

  function noteEntry(entry) {
    const moduleName = entry?.options?.name
    const entryId = entry?.id
    if (!moduleName || !entryId) return
    let record = byModule.get(moduleName)
    if (!record) {
      record = { moduleName, toolNames: new Set() }
      byModule.set(moduleName, record)
    }
  }

  function patchEntry(entry) {
    const entryCtx = entry?.context
    const moduleName = entry?.options?.name
    const entryId = entry?.id
    if (!entryCtx || !moduleName || !entryId) return
    noteEntry(entry)

    for (const [property, kind] of SURFACES) {
      let own = false
      try {
        own = Object.prototype.hasOwnProperty.call(entryCtx, property)
      } catch { /* non-standard context; skip */ }
      if (own) continue

      let real
      try {
        real = Reflect.get(entryCtx, property)
      } catch { continue }
      if (!real || typeof real.register !== 'function') continue

      const proxy = new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === 'register') {
            return function wrappedRegister(...args) {
              try {
                const definition = args[0]
                if (definition && typeof definition.name === 'string') {
                  register(kind, definition.name, entryId, moduleName)
                }
              } catch { /* attribution must never break registration */ }
              return Reflect.apply(target.register, target, args)
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })

      try {
        Object.defineProperty(entryCtx, property, {
          value: proxy,
          configurable: true,
          writable: true,
          enumerable: false,
        })
      } catch { /* keep going with the other surfaces */ }
    }
  }

  function resolve(kind, name) {
    const direct = map.get(surfaceKey(kind, name))
    if (direct) return direct
    const explicit = config.surfaceMap?.[surfaceKey(kind, name)]
    if (explicit) return { entryId: explicit.entryId ?? '', moduleName: explicit.moduleName }
    // Prefix rules from config, e.g. { "tool": [["my_", "@me/my-plugin"]] }
    const rules = config.surfacePrefixes?.[kind] ?? []
    for (const [prefix, moduleName] of rules) {
      if (typeof name === 'string' && name.startsWith(prefix)) {
        return { entryId: '', moduleName }
      }
    }
    return null
  }

  function snapshot(moduleName) {
    const record = byModule.get(moduleName)
    return record ? [...record.toolNames] : []
  }

  /** Fallback: attribute newly appeared global tool names to the last ACTIVE entry. */
  function refreshFromRegistry() {
    let schemas
    try {
      schemas = ctx.tools?.schemas?.()
    } catch { return }
    if (!Array.isArray(schemas)) return
    for (const schema of schemas) {
      const name = schema?.name
      if (!name || known.tool.has(name)) continue
      known.tool.add(name)
      if (lastActive) register('tool', name, lastActive.entryId, lastActive.moduleName)
    }
  }

  ctx.on('loader/entry-init', entry => noteEntry(entry))
  ctx.on('loader/patch-context', (entry, next) => {
    try { patchEntry(entry) } catch { /* never block composition */ }
    return next()
  })
  ctx.on('internal/plugin', fiber => {
    const entry = fiber?.entry
    if (!entry) return
    noteEntry(entry)
  })
  ctx.on('internal/status', fiber => {
    const entry = fiber?.entry
    if (!entry?.options?.name) return
    // FiberState.ACTIVE === 3 in Cordis 4; compare defensively via name too.
    if (fiber.state === 3 || fiber.state === 'ACTIVE') {
      lastActive = { entryId: entry.id, moduleName: entry.options.name }
      refreshFromRegistry()
    }
  })
  ctx.on('tools/change', () => refreshFromRegistry())

  refreshFromRegistry()

  return {
    resolve,
    snapshot,
    noteEntry,
    refreshFromRegistry,
    entries: () => [...byModule.values()].map(r => ({ moduleName: r.moduleName, toolNames: [...r.toolNames] })),
  }
}
