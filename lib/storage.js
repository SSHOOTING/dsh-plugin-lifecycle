import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const pluginRecord = z.object({
  key: z.string(),
  moduleName: z.string(),
  entryId: z.string().nullable().default(null),
  status: z.enum(['observing', 'probation', 'confirmed_unused', 'restored_keep', 'exempt']).default('observing'),
  logL: z.number().default(0),
  exposures: z.number().int().default(0),
  positiveSignals: z.number().int().default(0),
  cleanSessions: z.number().int().default(0),
  failureEvents: z.number().int().default(0),
  restoreRequested: z.boolean().default(false),
  lastUsedAt: z.number().nullable().default(null),
  firstObservedAt: z.number().default(0),
  lastEvaluatedAt: z.number().default(0),
  disabledAt: z.number().nullable().default(null),
  toolSnapshot: z.array(z.string()).default([]),
  exemptReason: z.string().nullable().default(null),
  guardOk: z.boolean().default(false),
  configVersion: z.number().default(1),
  updatedAt: z.number().default(0),
})

const eventRecord = z.object({
  at: z.number(),
  pluginKey: z.string(),
  moduleName: z.string().optional(),
  kind: z.string(),
  weight: z.number().default(0),
  status: z.string().optional(),
  theta: z.number().optional(),
  detail: z.string().optional(),
})

const lifecycleSpec = defineDomain({
  name: 'plugin_lifecycle',
  version: 1,
  global: {
    schema: z.object({
      schemaVersion: z.number(),
      lastEvaluatedAt: z.number(),
      policyVersion: z.number(),
    }),
    initial: { schemaVersion: 1, lastEvaluatedAt: 0, policyVersion: 1 },
  },
  tables: {
    plugins: domainTable(pluginRecord),
    events: domainTable(eventRecord),
  },
})

/** Open the persistent domain and return a small repository over it. */
export async function openRepository(ctx, { maxEvents = 2000 } = {}) {
  const domain = await ctx.storageDomain.open(lifecycleSpec)
  ctx.effect(() => () => domain.close(), 'plugin-lifecycle.domain')
  const plugins = domain.table('plugins')
  const events = domain.table('events')

  let sequence = 0
  function eventKey(event) {
    sequence += 1
    return `e:${event.at}:${sequence}:${Math.random().toString(36).slice(2, 8)}`
  }

  return {
    domain,
    async loadStates() {
      return [...plugins.entries()].map(([, record]) => ({ ...record }))
    },
    async saveState(state) {
      await plugins.put(`p:${state.key}`, { ...state })
    },
    async appendEvent(event) {
      await events.put(eventKey(event), { ...event })
    },
    async loadEvents(limit = 200) {
      return [...events.entries()]
        .map(([, value]) => value)
        .sort((a, b) => b.at - a.at)
        .slice(0, limit)
    },
    async pruneEvents() {
      const sorted = [...events.entries()].sort((a, b) => b[1].at - a[1].at)
      for (const [key] of sorted.slice(maxEvents)) await events.delete(key)
    },
    getMeta() {
      return domain.global.get()
    },
    async setMeta(meta) {
      await domain.global.set(meta)
    },
  }
}
