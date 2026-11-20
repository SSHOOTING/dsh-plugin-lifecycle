import z from '@deepseek-ai/schemastery'

/** Cordis plugin identity. */
export const name = 'plugin-lifecycle'

/** Services that must be present before this plugin activates. */
export const inject = [
  'tools',
  'commands',
  'pluginManager',
  'sandboxPolicy',
  'storageDomain',
]

/**
 * Modules that must never be auto-disabled. The plugin manager already protects
 * most of these; listing them here adds a second, independent guard.
 */
export const DEFAULT_PROTECTED_MODULES = [
  'dsh-plugin-lifecycle',
  '@deepseek-ai/dsh-plugin-manager',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/dsh-hmr',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-storage-json',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-commands',
]

const weights = z.object({
  tool: z.number().default(5.0),
  command: z.number().default(4.5),
  skill: z.number().default(2.0),
  hook: z.number().default(2.0),
  config: z.number().default(8.0),
  exposure: z.number().default(-0.18),
  feedback: z.number().default(4.0),
  missing_tool: z.number().default(8.0),
  restore: z.number().default(10.0),
}).default({})

/** Plugin configuration (schemastery, validated by Cordis at activation). */
export const Config = z.object({
  /** Master switch. Off by default: install, observe, then opt in. */
  enabled: z.boolean().default(false),
  /** Report candidates but never write to profile files. */
  dryRun: z.boolean().default(true),

  prior: z.number().default(0.5),
  thetaKeep: z.number().default(0.30),
  thetaDisable: z.number().default(0.10),
  thetaRestore: z.number().default(0.25),
  thetaConfirm: z.number().default(0.03),

  halfLifeDays: z.number().default(30),
  minExposures: z.number().default(20),
  minAgeDays: z.number().default(14),
  cleanSessions: z.number().default(8),
  probeDays: z.number().default(10),

  protectedModules: z.array(z.string()).default(DEFAULT_PROTECTED_MODULES),
  /** Exact names or trailing-* prefixes of plugins with no invocable surface. */
  unobservablePatterns: z.array(z.string()).default([]),
  weights,

  /** Confirm-and-uninstall is deliberately off by default. */
  autoUninstall: z.boolean().default(false),
  notifyOnDisable: z.boolean().default(true),

  evaluateIntervalMs: z.number().default(60_000),
  reconcileIntervalMs: z.number().default(600_000),
  maxEvents: z.number().default(2000),
})
