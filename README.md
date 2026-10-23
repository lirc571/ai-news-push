# ai-news-push

Personal AI news / alert bots, running on GitHub Actions.

## Codex 重置监控（Telegram 提醒）

Tibo（OpenAI 的 thsottiaux）发“重置”时，AIHOT 会在 10 分钟内采集到，这个监控每 10 分钟轮询一次，把新的重置（预告 / 已确认）推送到 Telegram，同一事件同一阶段不重复提醒。

数据源：[AIHOT Tibo 重置监控](https://aihot.news/api/v1/codex-resets/recent)（匿名只读，无需 API Key，官方建议每 10 分钟带 `If-None-Match` 轮询）。

### 一次性配置

1. **建 bot**：跟 [@BotFather](https://t.me/BotFather) 发 `/newbot`，拿到 `123456:AA...` 这样的 token。
2. **拿 chat id**：给 bot 发一条消息后访问
   `https://api.telegram.org/bot<TOKEN>/getUpdates`，取 `result[0].message.chat.id`
   （群组则是负数，记得把 bot 拉进群）。
3. **加 secrets**（仓库 Settings → Secrets and variables → Actions）：
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`（多个用英文逗号分隔，会逐个发送）
4. **开权限**：Settings → Actions → General → Workflow permissions 选
   **Read and write permissions**（workflow 需要把状态文件提交回仓库）。
5. 跑一次 `.github/workflows/codex-resets.yml`（Actions → Codex reset watcher → Run workflow，`dry_run` 打勾可先只看日志）。
   首次运行是“基线”：只记录已有事件，不回放历史，但**仍在进行中的预告会补发一条**。

### 本地调试

```bash
bun install
# 只打印不发送（不会写状态文件）
bun run src/codex-resets.ts --dry-run

# 自检：拉接口 + 渲染示例提醒（不读写 state，--dry-run 时只打印）
bun run src/codex-resets.ts --test --dry-run
bun run src/codex-resets.ts --test

# 只测 Telegram 链路
bun run src/codex-resets.ts --ping

# 用真实 token 跑一次（会写 state/codex-resets.json）
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... bun run src/codex-resets.ts

# 换一个状态文件跑，适合测试
bun run src/codex-resets.ts --dry-run --state /tmp/state.json
```

### 自检工作流（手动触发）

`.github/workflows/codex-resets-test.yml` 只在 `workflow_dispatch` 触发，**不写 state、不提交 commit**，不会影响正式监控的去重记录。

Actions → *Codex reset watcher · test* → Run workflow，参数：

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `mode` | `events` / `ping` | `events`：拉 AIHOT 接口 + 推最多 N 条示例提醒；`ping`：只发一条连通性消息 |
| `sample_size` | 数字，默认 `2` | `events` 模式发几条（优先挑最新的「预告」和最新的「已确认」各一条） |
| `dry_run` | `true` / `false` | 只把消息打印到日志 / Job Summary，不真的发到 Telegram |

`events` 模式会顺带做两项断言，失败直接让 job 变红：

1. 接口能正常返回（打印 `checkedAt` / `count` / `announced` / `confirmed` / `monitor`）；
2. 带 `If-None-Match` 再请求一次应得到 `304`（正式流程靠它省流量）。

建议流程：先 `mode=events, dry_run=true` 看日志里的 API 指标和消息渲染，再 `mode=ping` 确认真能收到消息，最后才让定时任务上线。

### 行为说明

- **去重**：key 是 `${event.id}:${event.status}`，所以一个事件会发两条消息——
  `announced`（🟡 预告要重置，带预计时间窗）和 `confirmed`（🟢 已确认/已落地）。
  只想要其中一种：把 `NOTIFY_KINDS` 改成 `upcoming` 或 `landed`。
- **状态存哪**：`state/codex-resets.json`，被 workflow 用 `[skip ci]` 提交回仓库；
  里面的 `etag` 用于条件请求（内容没变时 API 返回 304，几乎不花流量）。
- **失败会重试**：推送失败的事件不写入 `seen`，且不会保存新 `etag`，下次运行重试。
- **首次运行**：`initialized=false` 时只做基线，避免把 7 天历史一次性刷屏。
- cron 是 UTC 且最小 5 分钟精度；GitHub 的定时任务可能延迟甚至偶发跳过，属正常现象。
  仓库 60 天无活动时 scheduled workflow 会被自动停用，注意保活。

### 备用：GitHub 的 cron 不触发时的方案

GitHub 的 `schedule` 是 best-effort（官方：高负载会延迟甚至丢弃），偶尔也会出现某个仓库的 scheduled workflow 长时间完全不触发（workflow `state: active`、文件合法、手动 dispatch 正常，但 runs 里根本没有 `schedule` 记录）。遇到这种情况不要硬等：

**方案 A：本机 cron（零外部依赖）**

Bun 会自动读取工作目录的 `.env`，所以把密钥放 `.env`（已在 `.gitignore` 里）：

```bash
cd ~/PGM/ai-news-push
cat > .env <<'EOF'
TELEGRAM_BOT_TOKEN=123456:AA...
TELEGRAM_CHAT_ID=123456789
EOF

# 每 10 分钟跑一次；状态文件就在仓库里，和 Actions 完全兼容
crontab -e
*/10 * * * * cd $HOME/PGM/ai-news-push && $HOME/.bun/bin/bun run src/codex-resets.ts >> /tmp/codex-resets.log 2>&1
```

**方案 B：外部定时器打 `workflow_dispatch`**

workflow 已经声明了 `workflow_dispatch`，外部只需一个 POST（fine-grained PAT，权限 `Actions: write`）：

```bash
curl -X POST \
  -H "Authorization: Bearer $GH_PAT" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/lirc571/ai-news-push/actions/workflows/codex-resets.yml/dispatches \
  -d '{"ref":"main"}'
```

放到 cron-job.org / Cloudflare Worker Cron Trigger（`*/10 * * * *`）/ 任意常开机器即可；这里准点，而 GitHub 自己的 cron 只当兜底。

### 可调环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NOTIFY_KINDS` | `upcoming,landed` | 要提醒的阶段 |
| `MAX_MESSAGES_PER_RUN` | `10` | 单次运行最多发几条（防刷屏） |
| `SEEN_TTL_DAYS` | `45` | 去重记录保留天数 |
| `BASELINE_MAX_AGE_HOURS` | `72` | 基线运行时，预告最多回溯多久仍补发 |
| `PENDING_GRACE_HOURS` | `6` | 预告窗口结束后多久内仍算“进行中” |
| `STATE_FILE` | `state/codex-resets.json` | 状态文件路径 |
| `CODEX_RESETS_URL` | `https://aihot.news/api/v1/codex-resets/recent` | 可指向全量 `/api/v1/codex-resets` |
| `TEST_SAMPLE_SIZE` | `2` | 自检 `--test` 发几条示例 |

### 备用方案（不想让 bot 提交 commit）

把 workflow 里的 “Persist state” 换成 `actions/cache`，key 用
`codex-resets-${{ github.run_id }}`、`restore-keys: codex-resets-`：

```yaml
- uses: actions/cache@v4
  with:
    path: state
    key: codex-resets-${{ github.run_id }}
    restore-keys: codex-resets-
```

代价：cache 超过 7 天未被访问会被清理（cron 一直在跑就没事），且状态不可见。

## Development

```bash
bun install
bun run src/codex-resets.ts --dry-run   # 试跑
bun run src/codex-resets.ts --test      # 自检（拉接口 + 发示例）
bunx tsc --noEmit                       # 类型检查
```

运行 `bun fmt` 格式化代码。
