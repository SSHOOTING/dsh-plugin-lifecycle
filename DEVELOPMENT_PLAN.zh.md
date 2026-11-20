# DSH 插件生命周期管理器（dsh-plugin-lifecycle）开发方案

> 一个"管理插件的插件"：观察已安装插件是否真的被使用，用贝叶斯证据累积做推断；对高置信闲置的插件自动停用，进入观察期；观察期内用户正常使用且无异常则确认淘汰，一旦出现异常立即自动恢复并永久保留。目标是加速插件的优胜劣汰，而不是替用户做不可撤销的决定。

---

## 0. 已确认的 DSH 现状（本方案的事实基础）

调研对象：当前安装的 `@deepseek-ai/dsh@0.2.0-rc.2` 及其 Cordis 插件生态（路径：`E:\program\DeepSeek\app\node_modules\@deepseek-ai\`）。

| 能力 | 现状（可直接复用） | 依据 |
|---|---|---|
| 启停单个插件 | `ctx.pluginManager.setPluginEnabled(entryId: PluginEntryId, enabled: boolean): Promise<ChangeResult>`；`listPlugins(): Promise<PluginInfo[]>` | `dsh-plugin-manager/lib/types/index.d.ts:77,95-100`，实现 `lib/index.js:1651-1664` |
| 启停组合包 | `setBundleEnabled(name, enabled)`（保留依赖，只改选择） | 同上 `:101-106` |
| 持久化 | 行级开关写入 `<profile>/cordis.patch.yml` 的 `{id, disabled}` 覆盖项；组合包开关写 `<profile>/package.json` 的 `dsh.profile.bundles`。均为普通 profile 文件，重启后依然生效 | `lib/index.js:881-912`、`dsh-app-boot/lib/index.js:487,946-953` |
| 立即生效 | HMR 检测 patch 变更并重新 reconcile Loader 树；`setPluginEnabled` 自带 reload | `dsh-hmr/lib/index.js:353-376`、`dsh-plugin-manager/lib/index.js:2031-2034` |
| 变更事件 | `plugin-manager/changed`、`app-boot/config-reload`；**外部手工编辑/CLI 修改 patch 不会发 `plugin-manager/changed`**，需要轮询兜底 | `dsh-plugin-manager/lib/types/types.d.ts:200-223`、`README.zh.md:54` |
| 只读行 | `PluginInfo.readOnlyReason: 'management-required' \| 'unaddressable'`；管理组件、Loader、HMR、核心 UI/工具等受保护，无法关闭 | `dsh-plugin-manager/lib/types/types.d.ts:8,25-31`、`lib/index.js:1077-1094,1437-1444` |
| 并发约束 | 管理器自带 profile 写锁；`hmr.runExclusive()` **不允许嵌套事务**——本插件绝不能在 HMR  exclusive 回调/HMR 刷新处理里调用 `setPluginEnabled` | `lib/index.js:2023-2056`、`dsh-hmr/lib/index.js:279-287` |
| 会话事件 | `ctx.on('session/event', (session, event))` 是**所有持久化事件的统一入口**；含 `tool/call{name}`、`tool/result`、`command/run{name}`、`command/done`、`user/message`、`feedback/record`、`hook/invoked` 等 | `dsh-session/lib/types/index.d.ts:64`、`lib/types/types.d.ts:349-388`、`dsh-commands/lib/types/types.d.ts:89-119` |
| 工具执行事件 | `ctx.on('tools/result', (exec, result))`，`exec.name`/`exec.agent`；比日志更即时。`ToolExecution` 不带插件 id | `dsh-tools/lib/types/index.d.ts:85-92,216-242` |
| Fiber 生命周期 | `internal/plugin(fiber)`、`internal/status(fiber, oldState)`；可用 `fiber.entry.options.name`（模块名）与 `fiber.entry.id` 归因；`fiber.name` 只是显示名，不可靠 | `cordis/src/fiber.ts:121,302,581-586`、`cordis-plugin-loader/src/config/entry.ts:10-23` |
| 插件清单快照 | `readPluginInventory(ctx)` 给出 `{entryId, moduleName, enabled, fiberPhase}`；也可用 `ctx.loader` / `ctx.registry` 直接枚举 | `dsh-host-plugin-inventory/lib/types/types.d.ts:5-17,53-62`、`index.d.ts:13-35` |
| 工具注册 | `ctx.tools.register(defineTool({...}))`，工具声明回调可用 `presentCall`；管理类工具通过 `approveEscalation` 要求 danger-full-access 或本次批准 | `dsh-tools/lib/types/index.d.ts:115,636`、`dsh-plugin-manager/lib/types/tools.js:11-36` |
| 命令注册 | `ctx.commands.register({ definitionId: CommandDefinitionId('@deepseek-ai/<pkg>'), name, handler })`；运行时 `command/run` 事件带 `name` | `dsh-command-feedback/lib/index.js:163-172` |
| 插件写法 | ESM 具名导出 `name` / `inject` / `Config` / `apply(ctx, config)`；**是 `inject` 不是 `using`，且 Cordis 4 没有 `ready` 事件** | `cordis/src/registry.ts:91-133`、`cordis/README.md:61-67`、`dsh-persona/lib/index.js:19-50` |
| 持久化领域 | `ctx.storageDomain.open(defineDomain({ name, version, tables }))`，**zod** schema（不是 schemastery）；`domain.table(t).put/get/update/delete` 与 `domain.global.get/set`，`get` 同步读内存、写操作 resolve 前已落盘；变更事件 `domain/changed`。数据落在 `$DSH_HOME/storages/<domain>.json`。storage 家族在共享 base patch 中，**Web profile 必有** | `dsh-storage-domain/lib/types/index.d.ts:25-83`、`lib/types/domain.d.ts:15-105`、`dsh-base/cordis.patch.yml:165-176` |
| 定时器 | `ctx.interval(cb, ms)` / `ctx.timeout(cb, ms)`（旧名 `setInterval/setTimeout` 已废弃），随 fiber 释放；**没有通用 cron 服务**，`dsh-schedule` 是可选 bundle 且面向最终用户的提醒，不是插件用的定时器 | `cordis-plugin-timer/lib/types/index.d.ts:2-28`、`dsh-schedule/README.md:26` |

结论：**所有需要的机制都已存在**，本插件不需要修改 DSH 内核，只需作为一个普通 Host 插件组合进去。

---

## 1. 目标 / 非目标

### 目标
1. **可观测**：对每个已安装且可修改的插件，持续记录"被使用 / 有曝光但未使用"的证据。
2. **可推断**：用贝叶斯证据累积给出 `P(用户仍在用该插件)`，并能解释 score 来自哪些证据。
3. **可回滚**：自动停用 → 观察期 → 确认淘汰；任意时刻用户可一键恢复，且恢复后默认永久豁免。
4. **可解释、可审计**：所有判定与动作落盘，可查询"为什么停用 / 为什么保留"。

### 非目标（明确不做）
- 不为**无法归因任何使用信号**的插件做推断（如纯 patch 配置、纯设置页插件）——直接标记 `unobservable` 并豁免。
- 默认**不自动卸载**（`removeBundle`），只停用；卸载作为用户显式操作或未来的激进策略开关。
- 不做语义级意图识别（不读用户消息猜测心情），只使用结构化事件与关键词辅助。
- 不接管 `dsh plugin` CLI、不修改其他 profile、不改 agent 预设组合。

---

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│ 交互层                                                        │
│  · plugin_lifecycle 工具：status / restore / keep / resume     │
│  · /plugin-lifecycle 命令（可选）                              │
│  · Web 插件页 slot：使用率徽标 + 状态 + 一键恢复                │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│ dsh-plugin-lifecycle（Host 插件，本方案）                      │
│                                                              │
│   ┌────────────┐   ┌──────────────┐   ┌──────────────────┐   │
│   │ Signals    │──▶│ Bayes Engine │──▶│ State Machine /  │   │
│   │ 信号采集与  │   │ 证据累积与    │   │ Actuator         │   │
│   │ 插件归因    │   │ 后验计算      │   │ 串行化执行/对账   │   │
│   └─────┬──────┘   └──────┬───────┘   └────────┬─────────┘   │
│         │                 │                    │             │
│   ┌─────▼─────────────────▼────────────────────▼─────────┐   │
│   │ ctx.storageDomain  · domain 'plugin-lifecycle' v1     │   │
│   │   plugins / events / meta 三张表                       │   │
│   └───────────────────────────────────────────────────────┘   │
└───────────────────────────┬──────────────────────────────────┘
                            │ ctx.pluginManager
                            │  listPlugins / listBundles / setPluginEnabled
┌───────────────────────────▼──────────────────────────────────┐
│ DSH 内核                                                      │
│  PluginManager → cordis.patch.yml → HMR → Loader fiber 启停    │
│  Session 事件流 / tools / commands / hooks / skill 注册表       │
└──────────────────────────────────────────────────────────────┘
```

模块划分（Host 侧单包，浏览器侧可选 companion）：

| 模块 | 职责 |
|---|---|
| `signals.ts` | 订阅 Cordis / Session / Loader / PluginManager 事件，归一化为 `UsageSignal`，并做"信号 → 插件"归因 |
| `bayes.ts` | 纯函数：证据权重表、LLR 累积、时间衰减、后验、决策阈值（无 IO，易测） |
| `state-machine.ts` | 每插件状态迁移、保护规则、样本量/冷却时间门槛 |
| `actuator.ts` | 串行执行 `setPluginEnabled`，检查 `ChangeResult`，失败回滚，定期 `listPlugins()` 对账 |
| `storage.ts` | `defineDomain` schema + repository（读写/追加事件） |
| `tool.ts` | `plugin_lifecycle` 工具 + 权限批准 |
| `config.ts` | schemastery 配置（总开关、阈值、白名单、dry-run 等） |

---

## 3. 信号采集与插件归因（本方案最关键的工程点）

### 3.1 证据源清单

| 信号 | 采集点 | 归因到插件的方式 | 初判权重(LLR) |
|---|---|---|---|
| 工具调用 `tool/call{name}` | `ctx.on('session/event')` 或 `ctx.on('tools/result')` | 工具名 → 插件映射（见 3.2） | **+2.2** |
| 斜杠命令 `command/run{name}` | `ctx.on('session/event')`，过滤 `command/run` | 命令名 → 插件映射；注册时 `CommandDefinitionId('@deepseek-ai/<pkg>')` 可辅助 | **+2.0** |
| Skill 使用 | `dsh-skill` 注册表/事件 | skill name → 插件映射 | +1.2 |
| Hook 调用 `hook/invoked` | `dsh-hook-protocol` 写入的 session 事件 | `handlerId` → 插件映射 | +1.2，**仅覆盖外部 CC/Codex 命令 hook；原生插件不写 `hook/*` 记录，不能作为主要信号** |
| 用户显式启用 / 改配置 | `plugin-manager/changed` + Loader `internal/update` | `entryId` / `patchId` | **+4.0，并直接置 KEEP** |
| 一次"有效曝光"但零使用 | session 创建与销毁配对 | 该 session 期间插件处于 enabled | **-0.35**（弱负证据） |
| 观察期：调用了已消失的工具 | `tool/call{name}`，name ∈ 停用前快照且当前未注册 | 停用快照 | **+5.0，立即恢复** |
| 观察期：负反馈 | `feedback/record{category:'service-stability'|'task-result'}` 落在时间窗内 | 会话时间关联 | +3.0 |
| 外部重新启用 | `plugin-manager/changed` 或对账发现 `enabled` 由 false→true | `entryId` | **+∞，立即恢复并 KEEP** |

> "有效曝光"定义：一次**由用户驱动**的会话（含 ≥2 条 `user/message`，且至少 1 次 assistant 回合），排除定时任务、webhook、headless 自动化会话。只有有效曝光才贡献负证据——"没机会用"不等于"没用"。

### 3.2 工具/命令 → 插件归因（分层实现）

**先明确一个限制**：`tool/call`、`command/run`、`ToolExecution`、`ToolDefinition` 全部只带"名称"，**没有任何事件负载带插件 id**（`dsh-tools/lib/types/index.d.ts:115-191,216-242`、`dsh-commands/lib/types/types.d.ts:89-119`）。所以必须自建"名称 → 插件"映射。

**插件身份从哪里拿**（这部分是可靠的）：
- `ctx.on('internal/plugin', fiber => …)` 与 `internal/status(fiber, oldState)`：`fiber.entry.options.name` 是模块 specifier（即包名），`fiber.entry.id` 是稳定 id；`fiber.name` 只是显示名，**不要用**。`loader.locate(fiber)` 可把 fiber 反查为 entry id。
- `ctx.loader.resolve(id)` / `ctx.registry.values()` / `readPluginInventory(ctx)` 可枚举"已配置 vs 已加载"的插件。
- 注意 `internal/status` 只表示 **ACTIVE/FAILED（已加载）**，不等于"被使用"。

**surface 名称 → 插件**按可靠性分三层：

1. **首选：entry context 拦截**。利用 Loader 的 `loader/patch-context(entry, next)` waterfall（`cordis-plugin-loader/src/index.ts:41`），在该 entry 即将 apply 前，对其 `entry.context` 上的 `tools/commands/skills` 注册入口做轻量代理，把 `(surfaceKind, name) → entry.id`（同时记 `entry.options.name`）写入内存索引。实现时代理必须透传其他属性与 disposer 语义。
2. **兜底：激活前后差分**。监听 `loader/entry-init` 并在 fiber 进入 `active` 后对 `ctx.tools.schemas()` / `commands` / `skills` 的名称集合做差分，把新增名称归因于刚激活的 entry。DSH 通常按序组合 entry，准确率可接受；需在配置中允许人工修正。
3. **补丁：显式映射表**。为已知官方插件维护 `moduleName → [tool/command 名前缀]` 的配置映射，用户可覆盖。用于修正前两层的歧义。

三层结果合并为 `attribution: Map<surfaceKey, entryId>`，并随 `tools/change`、`loader/partial-dispose` 增量维护。若某插件在完整观察窗口内**归因到 0 个可见 surface**，标记 `unobservable=true`，永久豁免自动停用。

> 另外：**纯配置类插件**（provider、策略、prompt 提供者等）可以长期 ACTIVE 却永远没有调用事件，天然属于 `unobservable`。这不是缺陷，而是本方案刻意不选它们作为推断对象。

---

## 4. 贝叶斯推断模型

### 4.1 假设与后验

对每个插件维护一个标量证据对数似然比 `L`（log likelihood ratio）：

```
H1 = 用户仍在用该插件；H0 = 插件已闲置
L   = Σ Δ_i                                  // 每条证据的 log(P(E|H1)/P(E|H0))
θ   = P(H1|E) = σ(L + logit(θ_prior))          // σ=sigmoid，θ_prior 默认 0.5
```

用 LLR 而不是简单计数，好处是不同强度证据可以统一加权，且阈值有明确的贝叶斯含义。权重见 3.1 表，均可在配置中调整。

**时间衰减（遗忘因子）**：每隔 `decayTickDays`（默认 7 天）做

```
L ← max(0, L · exp(-ln2 / halfLifeDays · Δdays))   // halfLifeDays 默认 30
```

下限 0 表示"衰减不会把插件推向比先验更该停用"；只有真实负证据才能把它推过停用线。

### 4.2 双阈值 + 迟滞（防止反复启停）

```
θ ≥ θ_keep    (0.30)   → 保持启用，清零观察期状态
θ ∈ (θ_disable, θ_keep) → 观望，不动作
θ ≤ θ_disable (0.10)   → 进入"停用候选"，通过所有护栏后执行停用
```

停用后进入观察期，继续使用同一个 `L`（带迟滞），并额外累计：

- `cleanSessions`：观察期内无异常的有效会话数
- `failureEvents`：见 3.1 中的强失败信号

观察期判定：

```
任一强失败信号（重新启用 / 调用已消失工具 / 显式恢复）→ 立即恢复 + 永久 KEEP
θ ≥ θ_restore (0.25)                                → 立即恢复 + 永久 KEEP
θ ≤ θ_confirm (0.03) 且 cleanSessions ≥ N_clean(8) 且 观察天数 ≥ T_probe(10)
                                                    → 确认淘汰（保持停用，可提示卸载）
其余                                                → 继续观察
```

### 4.3 防误杀护栏（全部满足才允许自动停用）

1. 插件行必须有 `patchId`，无 `readOnlyReason`（`management-required` / `unaddressable` 一律跳过）。
2. 不在保护名单：本插件自身、`dsh-plugin-manager`、`cordis-plugin-loader/include`、`dsh-hmr`、`dsh-app-boot`、核心 UI/inventory/tools、`dsh-storage*`、`dsh-schedule`、用户配置白名单。
3. `unobservable === false`（至少有 1 个归因 surface）。
4. 观察样本数 `exposures ≥ N_min`（默认 20）且距首次观察 ≥ `T_min`（默认 14 天）。
5. 当前无安装/卸载进行中：`plugin-manager/install-state` 无活跃请求；`install`/`remove` 后 cooldown 3 天。
6. 全局 `dryRun !== true`，总开关 `enabled === true`。
7. 执行前重新 `listPlugins()` 复核状态；若已被外部改动则本次跳过。

> 设计取舍：**宁可漏停用，不可误停用**。所有阈值集中在 `config.ts`，并在 `status` 工具里输出当前 θ、证据条数、护栏命中情况，便于调参。

---

## 5. 状态机与持久化

### 5.1 每插件状态

```
        ┌──────────────────────────────────────────┐
        │                                          │ 用户改配置/显式keep
        ▼                                          │
  OBSERVING ──θ≤θ_disable & 护栏通过──▶ PROBATION ──┼──强失败信号/θ≥θ_restore──▶ RESTORED_KEEP (终态1)
        │                                          │
        │ 用户/外部启用                             └──clean≥N & θ≤θ_confirm──▶ CONFIRMED_UNUSED (终态2)
        └──────────────────────────────────────────▶ RESTORED_KEEP
```

`EXEMPT` 为旁路状态（protected / unobservable / 用户白名单），不参与推断。

| 状态 | 含义 | 可做动作 |
|---|---|---|
| `OBSERVING` | 正常启用，累积使用证据 | 进入 PROBATION / RESTORED_KEEP |
| `PROBATION` | 已被自动停用，观察是否出问题 | 恢复 / 确认淘汰 |
| `CONFIRMED_UNUSED` | 观察期通过，长期停用 | 用户显式恢复（→ RESET 为 OBSERVING 但带 KEEP 标记） |
| `RESTORED_KEEP` | 用户救回或显式保留 | 仅 `resume_auto` 可重新纳入自动管理 |
| `EXEMPT` | 保护/不可观测 | 无 |

### 5.2 存储 schema（`dsh-storage-domain`）

```ts
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

export const pluginStateSchema = z.object({
  key: z.string(),                 // 稳定主键：moduleName（entryId 会随 patch 变化，仅作运行时引用）
  entryId: z.string().optional(),
  moduleName: z.string(),
  state: z.enum(['observing','probation','confirmed_unused','restored_keep','exempt']),
  exemptReason: z.string().optional(),
  logL: z.number(),                // 贝叶斯 LLR
  exposures: z.number().int(),     // 有效曝光次数
  positiveSignals: z.number().int(),
  lastUsedAt: z.string().optional(),
  firstObservedAt: z.string(),
  disabledAt: z.string().optional(),
  cleanSessions: z.number().int(),
  failureEvents: z.number().int(),
  toolSnapshot: z.array(z.string()),  // 停用前该插件贡献的 tool/command 名
  updatedAt: z.string(),
}).strict()

export const usageEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  pluginKey: z.string(),
  kind: z.enum(['tool','command','hook','skill','exposure','config','feedback','missing_tool','restore']),
  weight: z.number(),
  sessionId: z.string().optional(),
  detail: z.string().optional(),
}).strict()

export const lifecycleDomain = defineDomain({
  name: 'plugin-lifecycle',
  version: 1,
  // global singleton（可选）：{ schemaVersion, lastEvaluatedAt, dryRun, policyVersion }
  global: {
    schema: z.object({
      schemaVersion: z.number(),
      lastEvaluatedAt: z.string(),
      dryRun: z.boolean(),
      policyVersion: z.number(),
    }),
    initial: { schemaVersion: 1, lastEvaluatedAt: '', dryRun: true, policyVersion: 1 },
  },
  tables: {
    plugins: domainTable(pluginStateSchema),
    events:  domainTable(usageEventSchema),
  },
})
```

使用方式（`dsh-workspace/lib/types/index.js:117-120` 为参考）：

```ts
const domain = await ctx.storageDomain.open(lifecycleDomain)
ctx.effect(() => () => domain.close(), 'lifecycle.domainClose')

const plugins = domain.table('plugins')
await plugins.put(state.key, state)             // resolve 前已持久化
const current = plugins.get(state.key)          // 同步读校验后的内存态
await plugins.update(state.key, s => ({ ...s, logL: s.logL + delta }))
await plugins.put(`events:${id}`, usageEvent)

ctx.on('domain/changed', ({ domain, table, key, operation }) => { /* 进程内变更流 */ })
```

事件表保留最近 N 条（如 2000），用于 `status` 输出证据明细和人工复盘。存储位于 `$DSH_HOME/storages`，不进会话历史、对模型不可见。

---

## 6. 执行器、恢复与对账

### 6.1 执行器（`actuator.ts`）

- 所有 `setPluginEnabled` 调用进入**单条 Promise 队列**串行化，避免并发写 patch / 嵌套 HMR 事务。
- 调用前检查 `plugin-manager/install-state`；调用后读取 `ChangeResult`：
  - `application === 'applied' | 'restart-required'`：按成功处理；`restart-required` 时提示用户重启后生效。
  - `application === 'failed' | 'overridden' | 'cancelled`：写仍可能已落盘 → 用 `listPlugins()` 复核真实状态；若与期望不符则记录 `EXEMPT` + cooldown，并**不重试超过 1 次**。
- 停用前抓取 `ctx.tools.schemas()` / commands / skills 中归因于该插件的名称，写入 `toolSnapshot`，作为观察期"缺失工具"检测依据。
- 由于外部 patch 编辑不发 `plugin-manager/changed`，每 5–15 分钟（配置）调用 `listPlugins()` 与本地状态对账；发现 `enabled` 变化即按"外部操作"处理（启用 → RESTORED_KEEP）。也可用 `readPluginInventory(ctx)` 一次拿到 `{entryId, moduleName, enabled, fiberPhase}` 快照来区分"已配置但没加载"和"正在运行"。
- 定时器只用 `ctx.interval()` / `ctx.timeout()`；**不要依赖 `ctx.schedule`**（可选 bundle，且是面向用户的提醒功能，不是通用 cron）。跨重启的逻辑用"持久化 `lastEvaluatedAt` + 启动时补算"实现，而不是假设定时器连续运行。

### 6.2 手动恢复（`tool.ts`）

注册 `plugin_lifecycle` 工具，复用官方 `plugin_manager` 的权限模式（`dsh-plugin-manager/lib/types/tools.js:11-36`）：

```
action:
  status    {plugin?}            只读，列出 θ / 状态 / 证据摘要 / 护栏
  restore   {plugin}             调用 setPluginEnabled(id,true) → RESTORED_KEEP；需要 danger-full-access 或本次批准
  keep      {plugin}             不改 patch，仅标记永久保留；无需批准
  resume    {plugin}             重新纳入自动管理（谨慎，会重置 KEEP）
  preview                        只返回候选停用列表（dry-run 报告）
  set_policy {...}               可选：调整该插件的阈值/豁免（建议放设置 UI）
```

同时支持 `/plugin-lifecycle` 斜杠命令：

```ts
ctx.commands.register({
  definitionId: CommandDefinitionId('@<你的包名>'),
  name: 'plugin-lifecycle',
  description: '查看插件使用状态 / 恢复被自动停用的插件',
  input: { hint: '<action> [plugin]' },
  handler: ({ rawInput }) => ({ kind: 'success', text: formatStatus(rawInput) }),
})
```

Web 侧会自动通过 `commands.list/execute` 出现在 `/` 触发菜单里（`dsh-client-ui-commands` 在 Web profile 必有）。注意：`defineTool` 的 `parameters` 使用 **dsh-tools 自己的 DSL**（`string/number/boolean/object/...`），**不是** schemastery；schemastery 只用于插件 `Config`。

### 6.3 Web 交互（第二阶段）

通过 `dsh-client-ui-plugin-manager` 已开放的 slot 扩展插件详情页（`lib/types/client/slot-contract.d.ts:73-156`）：
- `plugins.bundle.detail.actions` / `plugins.row.detail.actions`：加"恢复并永久保留"按钮；
- `plugins.bundle.detail.badges` / `plugins.row.detail.badges`：显示 `使用率 12% / 观察中 / 已确认闲置`；
- `plugins.offical` 相关 slot：放本插件自己的配置页（总开关、阈值、白名单）。

浏览器包通过 `ctx.slots` 注册，仅 `import type` 宿主契约，不运行时依赖该 UI 包。

### 6.4 用户告知

自动停用后必须降低"插件怎么突然没了"的困惑：

- 在 `status` 工具与 Web 插件页显著标注；
- **没有通用的 Host toast 服务**（`Toast` 只是客户端 React primitive）。可行的两条路：
  1. 注册一个 Typert Remote 服务 + 对应的 `dsh-client-ui-*` renderer，把"停用/恢复"作为可见卡片或徽标（与插件页 slot 合并做）；
  2. 拿到当前会话的 `Agent` 后，用 agent inbox 的 `agent.followup(message)` 注入一条用户侧提示——`dsh-schedule` 正是用它把提醒送进会话（`dsh-schedule/README.md:63-65`）。代码形态：`agent.inbox.send(message, target, wakeup)` / `agent.followup(message)`（`dsh-agent/lib/types/runtime-types.d.ts:180-192`）。
- 对需要用户裁决的场景可用 `ctx.userQuestions`（Web 问题卡片，Web profile 必有）询问"是否保留插件 X"，而不是默默执行；
- 所有动作写入本地事件表与日志，可审计。

---

## 7. 配置（`config.ts`，schemastery）

```ts
export interface Config {
  enabled: boolean            // 总开关，默认 false（opt-in）
  dryRun: boolean             // 默认 true；只报告不执行
  thetaPrior: number          // 0.5
  thetaKeep: number           // 0.30
  thetaDisable: number        // 0.10
  thetaRestore: number        // 0.25
  thetaConfirm: number        // 0.03
  halfLifeDays: number        // 30
  minExposures: number        // 20
  minAgeDays: number          // 14
  cleanSessions: number       // 8
  probeDays: number           // 10
  protectedModules: string[]  // 追加保护名单
  autoUninstall: boolean      // 默认 false（确认淘汰后是否 removeBundle）
  notifyOnDisable: boolean    // 默认 true
}
```

建议发布节奏：`enabled:false, dryRun:true` 安装 → 用户看几天报告 → 手动打开 `enabled:true, dryRun:false`。

---

## 8. 实施里程碑

| 阶段 | 交付物 | 验收标准 |
|---|---|---|
| **M0 可行性 spike（1–2 天）** | 最小插件骨架跑通；验证 `listPlugins/setPluginEnabled`、事件订阅、storage domain、timer 在 web profile 均可用；验证 `loader/patch-context` 代理能否稳定归因 | 在测试 profile 中可精确启停一个 dummy 插件并观察事件 |
| **M1 观测层（3–5 天）** | 信号采集、归因映射、storage domain、`status` 工具（只读） | 能在工具里看到每个插件的曝光数/使用次数/θ，无任何写操作 |
| **M2 推断层（3–5 天）** | `bayes.ts` 纯函数 + 状态机 + `preview` 报告；`dryRun` 默认 | 单元测试通过全部金标准场景（见 §9） |
| **M3 执行层（3–5 天）** | 串行执行器、护栏、对账、观察期、自动恢复、`restore/keep` 工具 | 在测试 profile 完成"闲置→停用→调用已消失工具→自动恢复"闭环 |
| **M4 UI 与通知（3–5 天）** | Web 插件页 slot companion、徽标/按钮、会话提示 | 插件页能看见状态并一键恢复 |
| **M5 硬化与发布（3–5 天）** | 压力/边界测试、阈值调参、README、示例配置、发布到 profile bundles | 连续 2 周 dogfooding 无误停用 |

---

## 9. 测试策略

**单元测试（bayes.ts，纯函数，无需 DSH 运行时）**
1. 每次会话都用插件 → θ 始终 > θ_keep，永不停用。
2. 连续 30 次有效曝光零使用 → θ < θ_disable，触发停用（且不被时间衰减单独触发）。
3. 停用后 8 次 clean session 且无失败 → CONFIRMED_UNUSED。
4. 停用后 `tool/call` 命中快照中的工具名 → 立即 RESTORED_KEEP。
5. `unobservable` 插件 → 永不进入候选。
6. 只有 3 次曝光 → 样本护栏阻止停用。
7. 用户中途重新启用 → RESTORED_KEEP 且不再自动停用。
8. 大量旧证据衰减后，新使用信号能快速翻正判断。

**集成测试（mock `ctx.pluginManager`）**
- 断言只调用带 `patchId` 的行；`readOnlyReason` 行零调用。
- 断言 `ChangeResult.application='failed'` 时触发复核而非盲目继续。
- 断言并发决策被串行化，且不在 HMR exclusive 上下文中调用。

**E2E（临时 profile + dummy 插件）**
- 真实 `dsh plugin` 安装 dummy 插件 → 运行带/不带工具调用的会话 → 检查 `cordis.patch.yml` 的 `disabled` 覆盖项 → 模拟用户恢复 → 检查状态持久化与重启后生效。

---

## 10. 目录结构（建议）

```
dsh-plugin-lifecycle/
├── package.json                # peerDeps: @deepseek-ai/cordis, dsh-plugin-manager,
│                               # dsh-session, dsh-storage-domain, dsh-tools,
│                               # dsh-commands, cordis-plugin-timer, schemastery, zod
├── README.zh.md
├── src/
│   ├── index.ts                # name / inject / Config / apply(ctx)
│   ├── config.ts
│   ├── signals.ts
│   ├── attribution.ts          # 三层归因 + loader/patch-context 代理
│   ├── bayes.ts                # 纯函数
│   ├── state-machine.ts
│   ├── storage.ts              # domain schema + repository
│   ├── actuator.ts
│   ├── tool.ts
│   └── commands.ts
├── lib/                        # 构建产物（发布用）
└── tests/
    ├── bayes.test.ts
    ├── state-machine.test.ts
    ├── integration.test.ts
    └── e2e/
```

`package.json` 要点（遵循当前生态约定）：

```json
{
  "name": "@deepseek-ai/dsh-plugin-lifecycle",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": { ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.4",
    "@deepseek-ai/dsh-plugin-manager": "0.2.0-rc.2",
    "@deepseek-ai/dsh-session": "0.2.0-rc.2",
    "@deepseek-ai/dsh-storage-domain": "0.2.0-rc.2",
    "@deepseek-ai/dsh-tools": "0.2.0-rc.2",
    "@deepseek-ai/dsh-commands": "0.2.0-rc.2",
    "cordis-plugin-timer": "~1.1.6"
  },
  "dependencies": { "@deepseek-ai/schemastery": "~3.18.4", "zod": "..." },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml` 用 `- insert: [{ id: plugin-lifecycle, name: '@deepseek-ai/dsh-plugin-lifecycle' }]` 把本插件插入 profile；`dsh plugin add` / `plugin_manager install_bundle` 会把该包登记进 `dsh.profile.bundles`。注意本插件必须排在其他被管理插件**之前**加载，才能尽早建立归因映射（Loader entry 顺序即 patch 顺序）。

---

## 11. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| **归因不准导致误判** | 三层归因 + 可人工修正映射；归因失败即豁免而非猜测 |
| **"没有机会用"被当成"没用"** | 只有有效用户会话才算曝光；排除自动化会话；最小样本 + 最小天数 |
| **低频高价值插件被误杀** | 高先验 + 高置信阈值 + 用户可永久 KEEP；提供 `exposures` 明细供人工复核 |
| **外部 patch 修改不被事件通知** | 定时 `listPlugins()` 对账 |
| **嵌套 HMR 事务报错** | 执行器完全避开 HMR 回调；只用 `setPluginEnabled` 自身封装的 reload |
| **恢复 bundle 改变优先级** | 默认只恢复行级 `disabled`，不动 bundle 列表；bundle 级操作需显式确认 |
| **用户不信任自动行为** | 默认 dry-run + 明确告知 + 一键恢复 + 完整审计日志 |
| **配置 schema 变更** | domain version + 迁移函数；记录 schemaVersion |

---

## 12. 附：最小实现骨架（M0）

```ts
// src/index.ts
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { registerLifecycleTool } from './tool'
import { openLifecycleDomain } from './storage'
import { createSignalHub } from './signals'
import { createActuator } from './actuator'
import { createEngine } from './state-machine'

export const name = 'plugin-lifecycle'
export const inject = ['tools', 'pluginManager', 'sandboxPolicy', 'storageDomain', 'commands']

export interface Config {
  enabled: boolean
  dryRun: boolean
  // ...见 §7
}
export const Config = z.object({
  enabled: z.boolean().default(false),
  dryRun: z.boolean().default(true),
  // ...
})

export async function apply(ctx: Context, config: Config) {
  const repo = await openLifecycleDomain(ctx)
  const hub = createSignalHub(ctx, repo)
  const actuator = createActuator(ctx, repo, config)
  const engine = createEngine(repo, config, actuator)

  hub.onSignal(signal => engine.ingest(signal))
  ctx.on('plugin-manager/changed', change => engine.onExternalChange(change))
  ctx.interval(() => engine.evaluate(), config.evaluateIntervalMs ?? 60_000)
  ctx.interval(() => engine.reconcile(), config.reconcileIntervalMs ?? 600_000)

  registerLifecycleTool(ctx, engine, config)
  ctx.effect(() => () => repo.close())
}
```

> 下一步建议：先做 M0 spike。`session/event` 覆盖所有持久化事件、`setPluginEnabled`/storage/timer 的可用性已经从源码确认；**唯一需要在真机验证的是** `loader/patch-context` 中对 entry context 的注册代理是否稳定（决定归因精度），以及在目标 profile 里能否拿到当前 `Agent` 做 `followup()` 通知。这两点决定 M1/M4 的实现路径。
