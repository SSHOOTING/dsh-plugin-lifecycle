# dsh-plugin-lifecycle

> 一个"管理插件的插件"：根据真实使用证据推断已安装插件是否仍有价值，自动停用高置信闲置插件；观察期内一旦发现问题立即恢复。

## 它解决什么问题

装了很多 DSH 插件之后，总有一部分再也不会被用到，但它们仍然占用上下文、注册表和注意力。这个插件把"优胜劣汰"变成一个有证据、可回滚的流程：

1. 观察：记录工具调用、斜杠命令、skill/hook 调用，以及"有用户会话机会但没有触发"的曝光。
2. 推断：每个插件维护一个贝叶斯对数似然比 `L`，`P(仍在用) = sigmoid(logit(先验) + L)`，并带时间衰减。
3. 停用：`P < 10%`、曝光 ≥ 20 次、安装 ≥ 14 天，且插件可写、非保护名单、非"不可观测"，才会写入 `cordis.patch.yml` 把它停用。
4. 观察期：停用后若模型又调用了它原本提供的工具、用户重新启用、或给出稳定性负反馈，立即自动恢复并永久保留。
5. 确认：连续 8 次干净会话、观察 ≥ 10 天且 `P < 3%`，标记为"已确认闲置"。默认不会卸载。

## 安装

```sh
dsh plugin --profile web add dsh-plugin-lifecycle
```

安装后新开一个 Web 会话生效。安装默认**不会自动改任何插件**：总开关默认关闭、`dryRun` 默认开启。

## 启用自动管理

在 profile 的 `cordis.patch.yml` 中覆盖本插件配置：

```yaml
- id: plugin-lifecycle
  config:
    enabled: true
    dryRun: false
```

建议先保持 `dryRun: true` 观察几天，用 `/plugin-lifecycle` 查看判定报告，确认没有误判后再打开写入。

## 使用

工具 `plugin_lifecycle`（模型可调用）：

| action | 说明 | 需要批准 |
|---|---|---|
| `status` | 列出所有插件的后验概率、状态、曝光/使用计数 | 否 |
| `preview` | 列出当前会被停用的候选 | 否 |
| `restore` | 重新启用被停用的插件并永久保留 | 是（danger-full-access 或单次批准） |
| `keep` | 不改启用状态，仅永久保留，不再自动管理 | 否 |
| `resume` | 重新纳入自动管理，证据清零 | 否 |

斜杠命令 `/plugin-lifecycle [模块名]` 可只读查看状态。

Web 插件页的开关或其他工具做的启用/停用会在下一次对账（默认 10 分钟）被发现：用户主动重新启用意味着"这个插件我要"，会立即转为永久保留。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `false` | 总开关 |
| `dryRun` | `true` | 只报告不写 profile |
| `prior` | `0.5` | 先验 P(仍在用) |
| `thetaDisable` | `0.10` | 低于此概率进入停用候选 |
| `thetaKeep` | `0.30` | 高于此概率保持启用（迟滞） |
| `thetaRestore` | `0.25` | 观察期内高于此概率立即恢复 |
| `thetaConfirm` | `0.03` | 观察期确认淘汰阈值 |
| `halfLifeDays` | `30` | 证据半衰期 |
| `minExposures` | `20` | 最少有效会话曝光 |
| `minAgeDays` | `14` | 最少观察天数 |
| `cleanSessions` | `8` | 观察期干净会话数 |
| `probeDays` | `10` | 观察期最少天数 |
| `protectedModules` | 内置列表 | 永不自动停用的模块 |
| `unobservablePatterns` | `[]` | 无调用面的纯配置插件，直接豁免 |
| `autoUninstall` | `false` | 确认后是否自动卸载（默认只停用） |
| `weights` | 内置 | 各类证据的 LLR 权重 |

## 安全设计

- 只改带 `patchId` 且无 `readOnlyReason` 的插件行；管理组件、Loader、HMR、核心 UI/工具由插件管理器与本插件双重保护。
- 归因不到任何调用面的插件（纯配置、纯 prompt 提供者）被标记为 `unobservable`，永久豁免。
- 所有写入串行执行，避开 HMR 的不可重入事务；写入失败会复核真实状态并停止继续操作。
- 外部对 `cordis.patch.yml` 的修改不发事件，因此有定时对账；用户手动恢复永远优先。
- 状态存于 `$DSH_HOME/storages/plugin_lifecycle.json`，不进入会话历史。

## 开发

```sh
npm run build     # src/ -> lib/
npm test          # 16 个单元测试（贝叶斯 + 状态机）
```

## License

MIT
