# opencode-clean

OpenCode 存储清理器：语义清理（legacy 表、过期子代理会话、孤儿文件）+ 安全的 SQLite 物理维护（freelist 体检、备份、VACUUM）。

**零运行时依赖** —— 只用 Node.js 内置模块（`node:sqlite`，Node >= 22.5），不需要 uv / Python / ocgc 等任何外部工具。

## 为什么需要它

OpenCode 把所有会话（含工具输出、推理 token）写进单个 SQLite 文件 `~/.local/share/opencode/opencode.db`，且无限增长。更糟的是：

- 版本迁移后，旧 schema（`session`/`message`/`part`）的数据**冻结残留**在库里，当前版本不再读写它们（但占着 1 GB+ 空间）
- 子代理会话无限累积，没有任何内置清理
- 删除数据后 SQLite 并不归还磁盘空间（freelist 空洞），需要 VACUUM

## 安装

```bash
git clone <this-repo> && cd opencode-clean
# 无需 npm install —— 没有依赖
node bin/ocgc-manage.js
```

## 使用

### 交互管理器（推荐入口）

```bash
node bin/ocgc-manage.js
```

```
 [1] 数据库体检（只读）
 [2] 立即清理（先预览，确认后实删）
 [3] 注册每周自动清理任务（周日 03:00）
 [4] 移除自动清理任务
 [5] 查看上次报告
 [6] 通知开关
 [7] 修改保留天数
```

### 命令行

```bash
# 预览（默认，绝不写数据库）
node bin/ocgc-clean.js --dry-run --json

# 真实清理 + 物理 VACUUM
node bin/ocgc-clean.js --yes

# 自定义参数
node bin/ocgc-clean.js --yes --days 90 --snapshots --no-notify
```

完整参数见 `node bin/ocgc-clean.js --help`。

退出码：`0` 成功 | `1` 部分完成（物理维护被推迟）| `2` 失败。

## 清理什么

| 目标 | 规则 | 安全性 |
|---|---|---|
| 旧 schema 表（`session`/`message`/`part`/`todo`/`session_share`/`event`） | 只删「在 `session_v2` 中存在同 ID 副本」的行 | 没有副本的旧会话（约 0.7%）永久保留 |
| 过期子代理会话（`session_v2.parent_id` 非空） | `time_updated` 超过保留期（默认 30 天） | 挂起中的会话永不清理；主会话永不清理 |
| 孤儿文件（`storage/message`、`storage/part`、`storage/session_diff`、`storage/session`） | 文件/目录的 id 在两张 session 表中都不存在 | 只碰这四个目录，绝不递归进项目目录 |
| git 快照（`snapshot/`） | 默认不删，`--snapshots` 显式开启 | — |

## 运行状态决策（wait-for-idle）

| OpenCode 进程 | 数据库状态 | 行为 |
|---|---|---|
| 未运行 | — | 完整流程（清理 + 备份 + 九步 VACUUM） |
| 运行中但空闲 | 静默（checkpoint 探测通过） | 完整流程 |
| 运行中且执行中 | 有近期写入 | 等待（60s 重探，默认最长 15 分钟），超时则降级 purge-only，物理维护推迟 |

删除操作本身在 WAL 模式下与运行中的 OpenCode 安全共存（短写事务 + `busy_timeout`）；保留期天然保护活跃会话。

## 九步 VACUUM 序列

借鉴 [ocdbc](https://github.com/chncaesar/opencode-db-clean) 的安全序列，顺序即安全：

1. `wal_checkpoint(TRUNCATE)` — 确保 .db 含全部已提交数据
2. `integrity_check`（改前）
3. 时间戳备份到 `~/.opencode/ocgc/backup/`（自动轮换，默认保留 1 份）
4. 独立打开备份并验证完整性（退路必须是「验证过的」）
5. `PRAGMA auto_vacuum = INCREMENTAL` — 未来的空闲页可以廉价回收
6. `VACUUM`
7. 恢复 `journal_mode = WAL`
8. `integrity_check`（改后）
9. 备份轮换

是否值得跑 VACUUM 由 freelist 体检决定：purge 刚删过数据、或空洞占比 >= 20%、或空洞 >= 100 MB 时才执行（`--force-vacuum` 强制）。

## 用户如何感知结果

- `~/.opencode/ocgc/clean.log` — 每次运行的追加式摘要
- `~/.opencode/ocgc/last-report.txt` — 完整报告（三态：成功 / 部分完成 / 失败 + 原因）
- 桌面通知（零依赖实现）：仅失败、部分完成、或释放 >= 100 MB 时推送；manage 菜单可关
- 退出码透出到任务计划程序「上次运行结果」列

## 数据与代码的位置

- 代码：本仓库（计划任务直接指向仓库内脚本，用 `process.execPath` 绝对路径，不依赖 PATH）
- 运行时产物：`~/.opencode/ocgc/`（config.json / clean.log / last-report.txt / backup/ / state.json / task.xml）

## 开发

```bash
npm test        # node --test —— 83 个测试，含真实 SQLite 行为验证
```

测试使用临时目录中的 fixture 数据库（与生产 schema 同构），覆盖：purge 精确性（预览=实删）、副本校验、挂起会话保护、cutoff 边界、schema 缺表容错、九步序列（含失败注入与备份保留）、等待空闲状态机、孤儿扫描、三端调度注册、通知门槛与平台分发、CLI 参数与端到端冒烟。

## 致谢

- [ocgc](https://github.com/whtsky/ocgc) — 语义清理思路的来源
- [ocdbc](https://github.com/chncaesar/opencode-db-clean) — freelist 度量与安全 VACUUM 序列的来源
