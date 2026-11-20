import { approveEscalation } from '@deepseek-ai/dsh-sandbox'
import { defineTool } from '@deepseek-ai/dsh-tools'

const ACTIONS = ['status', 'preview', 'restore', 'keep', 'resume']

/**
 * Agent-facing control surface. Read-only actions need no approval; restoring
 * a plugin writes to the profile and therefore follows the same escalation
 * policy as the official `plugin_manager` tool.
 */
export function registerLifecycleTool(ctx, engine, config) {
  ctx.tools.register(defineTool({
    name: 'plugin_lifecycle',
    description: [
      'Inspect or control automatic plugin lifecycle management.',
      'status lists every installed plugin with its inferred probability of still being used, state and evidence counts.',
      'preview lists plugins that would be disabled right now (dry run).',
      'restore re-enables a plugin that was auto-disabled and pins it permanently.',
      'keep pins a plugin without changing its enabled state. resume returns it to automatic management.',
      'Only restore writes to the profile and requires danger-full-access or per-call approval.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ACTIONS,
        description: 'Operation to perform.',
      },
      plugin: {
        type: 'string',
        description: 'Module name of the plugin, as shown by status. Required for restore, keep and resume.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      if (args.action === 'restore') {
        const policy = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
        await approveEscalation({
          requestedMode: 'danger-full-access',
          effectiveMode: policy.mode,
          subject: 'plugin lifecycle restore',
          justification: `plugin_lifecycle restore ${JSON.stringify(args)}. This re-enables a plugin in the current profile and persists across sessions.`,
        }, {
          approver: ctx.get('approval'),
          agent: exec.agent,
          callId: exec.callId,
          toolName: 'plugin_lifecycle',
          signal: exec.signal,
        })
        exec.signal.throwIfAborted()
      }

      if (args.action === 'status') {
        const rows = engine.status(args.plugin)
        return JSON.stringify({ ok: true, config: { enabled: config.enabled, dryRun: config.dryRun }, plugins: rows }, null, 2)
      }
      if (args.action === 'preview') {
        return JSON.stringify({ ok: true, candidates: engine.candidates() }, null, 2)
      }
      if (!args.plugin) {
        return JSON.stringify({ ok: false, error: 'plugin is required for this action' })
      }
      const result = await engine.manual(args.action, args.plugin)
      return JSON.stringify(result, null, 2)
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Plugin lifecycle',
      kind: args.action === 'status' || args.action === 'preview' ? 'read' : 'other',
      rawInput: args,
    }),
  }))
}
