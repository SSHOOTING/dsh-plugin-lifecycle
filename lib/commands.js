import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'

/** A minimal human-facing command; the tool above is the richer surface. */
export function registerLifecycleCommand(ctx, engine, config) {
  ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-plugin-lifecycle'),
    name: 'plugin-lifecycle',
    description: 'Show which plugins are considered unused and how to restore them',
    input: { hint: '[plugin module name]' },
    recordInput: false,
    handler: invocation => {
      const key = invocation.rawInput.trim() || undefined
      const rows = engine.status(key)
      if (!rows) return { kind: 'error', text: `Unknown plugin: ${key}` }
      const lines = [
        `Automatic plugin lifecycle: ${config.enabled ? 'on' : 'off'} (dry run: ${config.dryRun ? 'on' : 'off'})`,
        ...rows.map(row => [
          `- ${row.moduleName}`,
          `  state=${row.status}`,
          `  P(in use)=${(row.probabilityInUse * 100).toFixed(1)}%`,
          `  exposures=${row.exposures}`,
          `  used=${row.positiveSignals}`,
          row.exemptReason ? `  exempt=${row.exemptReason}` : '',
        ].filter(Boolean).join('\n')),
        '',
        'Restore with the plugin_lifecycle tool (profile change, requires approval).',
      ]
      return { kind: 'success', text: lines.join('\n') }
    },
  })
}
