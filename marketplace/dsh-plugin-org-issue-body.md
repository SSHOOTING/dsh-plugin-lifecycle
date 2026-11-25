- **Repository**: https://github.com/SSHOOTING/dsh-plugin-lifecycle
- **One-line value**: Automatically identifies installed DSH plugins that are no longer used, disables them with a Bayesian inference loop, and restores them instantly when the user still needs them.
- **Category**: Tools & Capabilities (tools)
- **Install command**: `dsh plugin --profile web add dsh-plugin-lifecycle`
- **npm package**: `dsh-plugin-lifecycle` (0.1.0) — **publish pending**: the author's npm account requires a 2FA one-time password for the first publish. The GitHub repository, tag and an installable tarball are already available at https://github.com/SSHOOTING/dsh-plugin-lifecycle/releases/tag/v0.1.0 . The website listing can be indexed from GitHub now; the in-app npm install will work once the publish completes.
- **License**: MIT

**Notes**

- DSH 0.2.0-rc.2, declared range `>=0.2.0-rc.2 <0.3.0`.
- The repository has the `dsh-plugin` topic; `package.json` declares `dsh.bundle.patch` and its `repository` field points to this same owner/repo.
- Ships disabled by default with dry-run enabled. All profile writes go through `ctx.pluginManager.setPluginEnabled`, are serialized, and are recoverable with the `plugin_lifecycle` tool.
- Tests: 16 unit tests plus an integration smoke test, all passing. Accepted into the awesome-dsh-plugin catalog in PR https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/18330 .

**Self-check**

- [x] The repository has the `dsh-plugin` topic.
- [ ] The npm install command has been run successfully locally — blocked on npm 2FA; the tarball is built and the bundle manifest is in place.
- [x] `repository` in `package.json` matches this owner/repo.
