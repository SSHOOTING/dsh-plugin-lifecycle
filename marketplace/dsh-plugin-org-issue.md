# dsh-plugin.org submission draft

Open an issue at https://github.com/dshplugin/dsh-plugin-hub/issues/new/choose with this content
after `dsh-plugin-lifecycle` is published on npm.

**Title**

```
[Plugin submission] SSHOOTING/dsh-plugin-lifecycle — Auto-disable unused DSH plugins with Bayesian inference
```

**Body**

```markdown
- Repository: https://github.com/SSHOOTING/dsh-plugin-lifecycle
- Value: Observes real tool/command usage of every installed plugin, infers which ones are dormant with a Bayesian log-likelihood model, auto-disables them, and restores them instantly if the user still needs them.
- Category: tools
- Install command: dsh plugin --profile web add dsh-plugin-lifecycle
- Compatibility: DSH >=0.2.0-rc.2 <0.3.0 (verified against @deepseek-ai/dsh 0.2.0-rc.2)
- License: MIT
- Demo / screenshots: https://github.com/SSHOOTING/dsh-plugin-lifecycle#readme
- Notes: Ships disabled by default with dry-run enabled. Writes only to the current profile's cordis.patch.yml through ctx.pluginManager.setPluginEnabled. State is stored in $DSH_HOME/storages/plugin_lifecycle.json. 16 unit tests plus an integration smoke test cover the inference engine and state machine.
- Checklist:
  - [x] Public repository with an accurate description
  - [x] GitHub topic `dsh-plugin`
  - [x] Root package.json with name, version and `dsh.bundle.patch`
  - [x] Plugin exports `apply(ctx)`
  - [x] README with install/usage/compatibility
  - [x] MIT license
  - [ ] Published to npm as `dsh-plugin-lifecycle`
```
