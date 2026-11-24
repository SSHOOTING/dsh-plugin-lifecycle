Adds `SSHOOTING/dsh-plugin-lifecycle` to the catalog.

- **Repository**: https://github.com/SSHOOTING/dsh-plugin-lifecycle (public, topic `dsh-plugin`)
- **What it does**: observes tool/command usage of installed plugins, infers dormant ones with a Bayesian log-likelihood model, auto-disables them after guard checks, and restores them immediately on failure signals (missing tool call, external re-enable, negative feedback). Ships disabled with dry-run on by default.
- **Bundle manifest**: root `package.json` declares `dsh.bundle.patch` pointing at `cordis.patch.yml`; `engines.dsh` is `>=0.2.0-rc.2 <0.3.0`.
- **Category**: `tools`
- **License**: MIT
- **Tests**: 16 unit tests plus an integration smoke test; all passing.

Install: `dsh plugin --profile web add dsh-plugin-lifecycle`
