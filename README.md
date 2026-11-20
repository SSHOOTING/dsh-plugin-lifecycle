# dsh-plugin-lifecycle

[中文](README.zh.md)

> A plugin that manages plugins. It infers which installed DSH plugins are still actually used from observable evidence, auto-disables dormant ones, and instantly restores them when the user still needs them.

## Why

After installing many DSH plugins, a good fraction is never used again but still costs context, registry entries, and attention. This plugin turns "survival of the fittest" into an evidence-based, reversible workflow:

1. **Observe** tool calls, slash commands, skill/hook invocations, and "had an opportunity but was not used" exposures.
2. **Infer** a Bayesian log-likelihood ratio per plugin: `P(in use) = sigmoid(logit(prior) + L)`, with exponential forgetting.
3. **Disable** only when `P < 10%`, with at least 20 real user-session exposures and 14 days of age, and only for addressable, non-protected, observable plugins.
4. **Watch** for failure signals during probation: a call to a tool that plugin used to provide, an external re-enable, or stability feedback. Any of them restores the plugin and pins it permanently.
5. **Confirm** after 8 clean sessions and 10 days with `P < 3%`. Uninstall is opt-in and off by default.

## Install

```sh
dsh plugin --profile web add dsh-plugin-lifecycle
```

The plugin is inert after installation: the master switch is off and `dryRun` is on.

## Enable

Override the plugin config in your profile's `cordis.patch.yml`:

```yaml
- id: plugin-lifecycle
  config:
    enabled: true
    dryRun: false
```

Run with `dryRun: true` for a few days first and inspect `/plugin-lifecycle` before allowing writes.

## Control

Tool `plugin_lifecycle`:

| action | meaning | approval |
|---|---|---|
| `status` | posterior probability, state, evidence counts for every plugin | no |
| `preview` | plugins that would be disabled now | no |
| `restore` | re-enable a disabled plugin and pin it forever | yes |
| `keep` | pin without changing enablement | no |
| `resume` | return to automatic management, reset evidence | no |

Slash command `/plugin-lifecycle [module]` is a read-only status view. Enables/disables performed in the Web Plugins page or by other tools are detected during the 10-minute reconciliation; a user-initiated re-enable always wins and pins the plugin.

## Configuration

See [README.zh.md](README.zh.md#配置) for the full table. Key knobs: `enabled`, `dryRun`, `thetaDisable` (0.10), `thetaConfirm` (0.03), `minExposures` (20), `minAgeDays` (14), `cleanSessions` (8), `probeDays` (10), `autoUninstall` (false).

## Safety

- Only rows with a `patchId` and no `readOnlyReason` are touched; the plugin manager's own protected modules are skipped twice over.
- Plugins with no attributable invocation surface (pure config/prompt providers) are marked `unobservable` and permanently exempt.
- Every write is serialized and never runs inside HMR's non-reentrant transaction; failures are verified against live state instead of assumed.
- External patch edits do not emit events, so state is reconciled periodically. Manual user restore always takes precedence.
- State lives in `$DSH_HOME/storages/plugin_lifecycle.json`, outside session history.

## Development

```sh
npm run build     # src/ -> lib/
npm test          # unit tests for the Bayesian engine and state machine
```

## License

MIT
