/**
 * Codex 重置监控 → Telegram 提醒
 *
 * 数据源：AIHOT 的 Tibo Codex 重置监控接口（匿名只读，无需 API Key）
 *   - 轮询用：https://aihot.news/api/v1/codex-resets/recent  （最近 7 天 + 尚未落地）
 *   - 全量：  https://aihot.news/api/v1/codex-resets
 *   - 文档：  https://aihot.news/openapi-v1.json
 *
 * 逻辑：
 *   1. 带 If-None-Match 拉取 /recent，304 直接退出（几乎不耗流量）。
 *   2. 用 `${event.id}:${event.status}` 去重，保证同一个事件同一阶段只提醒一次
 *      （`announced` = 预告要重置，`confirmed` = 已确认/已落地，各发一条）。
 *   3. 首次运行（状态文件为空）只做“基线”，不回放历史；但仍在进行中的预告会补发一条。
 *   4. 只有成功推送到 Telegram 的事件才写入状态，失败的事件下次运行会重试。
 *
 * 用法：
 *   bun run src/codex-resets.ts                 # 正常运行
 *   bun run src/codex-resets.ts --dry-run       # 只打印，不发消息、不写状态
 *   bun run src/codex-resets.ts --state other.json --dry-run
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const API_URL =
  process.env.CODEX_RESETS_URL ?? "https://aihot.news/api/v1/codex-resets/recent";
const USER_AGENT =
  process.env.USER_AGENT ?? "ai-news-push-codex-watcher/1.0 (+github actions)";

const TELEGRAM_TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const TELEGRAM_CHATS = (process.env.TELEGRAM_CHAT_ID ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** 需要提醒的阶段：upcoming = 预告要重置，landed = 已确认/已落地 */
const NOTIFY_KINDS = new Set(
  (process.env.NOTIFY_KINDS ?? "upcoming,landed")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

/** 单次运行最多发几条，防止 API 异常/状态丢失时刷屏 */
const MAX_MESSAGES_PER_RUN = Number(process.env.MAX_MESSAGES_PER_RUN ?? 10);
/** 去重记录保留天数 */
const SEEN_TTL_DAYS = Number(process.env.SEEN_TTL_DAYS ?? 45);
/** 基线运行时，预告事件最多回溯多久仍然补发 */
const BASELINE_MAX_AGE_HOURS = Number(process.env.BASELINE_MAX_AGE_HOURS ?? 72);
/** 预告的预计窗口结束后多少小时内仍算“进行中” */
const PENDING_GRACE_HOURS = Number(process.env.PENDING_GRACE_HOURS ?? 6);

const DRY_RUN =
  process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";

const STATE_FILE =
  argValue("--state") ?? process.env.STATE_FILE ?? "state/codex-resets.json";

// ---------------------------------------------------------------------------
// 类型（只声明用到的字段，接口新增字段不影响解析）
// ---------------------------------------------------------------------------

type Post = {
  id?: string;
  url?: string | null;
  publishedAt?: string | null;
  stage?: string | null;
  text?: string | null;
  originalText?: string | null;
};

type ResetEvent = {
  id: string;
  type?: string | null;
  label?: string | null;
  displayLabel?: string | null;
  status?: string | null; // announced | confirmed
  title?: string | null;
  scope?: string | null;
  url?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  confirmedAt?: string | null;
  occurredOn?: string | null;
  confirmationBasis?: string | null;
  schedule?: {
    precision?: string | null;
    from?: string | null;
    through?: string | null;
    label?: string | null;
  } | null;
  estimate?: {
    from?: string | null;
    through?: string | null;
    basis?: string | null;
    label?: string | null;
    reason?: string | null;
  } | null;
  presentation?: {
    status?: string | null;
    scopeLabel?: string | null;
    audienceZh?: string | null;
    productsZh?: string | null;
    kindExplicit?: boolean | null;
    timeInferred?: boolean | null;
  } | null;
  posts?: Post[] | null;
};

type ResetsResponse = {
  schemaVersion?: number;
  timezone?: string;
  checkedAt?: string;
  count?: number;
  events?: ResetEvent[];
  monitor?: { status?: string | null; lastVerifiedAt?: string | null } | null;
};

type State = {
  version: number;
  initialized?: boolean;
  etag?: string | null;
  updatedAt?: string;
  /** key = `${event.id}:${event.status}` → 记录时间（ISO） */
  seen: Record<string, string>;
};

type Kind = "upcoming" | "landed";

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function log(...args: unknown[]): void {
  console.log(`[codex-resets]`, ...args);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function ts(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const t = Date.parse(value);
  return Number.isNaN(t) ? Number.NaN : t;
}

function classify(event: ResetEvent): Kind | null {
  if (event.status === "announced") return "upcoming";
  if (event.status === "confirmed") return "landed";
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

async function loadState(): Promise<State> {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<State>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.seen !== "object") {
      throw new Error("state file has unexpected shape");
    }
    return {
      version: parsed.version ?? 1,
      initialized: parsed.initialized === true,
      etag: typeof parsed.etag === "string" ? parsed.etag : null,
      updatedAt: parsed.updatedAt,
      seen: Object.fromEntries(
        Object.entries(parsed.seen ?? {}).filter(
          ([, v]) => typeof v === "string",
        ),
      ),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      log(`state file ${STATE_FILE} not found, starting fresh`);
      return { version: 1, initialized: false, etag: null, seen: {} };
    }
    log(`could not read state (${String(err)}), starting fresh`);
    return { version: 1, initialized: false, etag: null, seen: {} };
  }
}

function pruneSeen(seen: Record<string, string>): Record<string, string> {
  const cutoff = Date.now() - SEEN_TTL_DAYS * 86_400_000;
  const entries = Object.entries(seen)
    .filter(([, when]) => {
      const t = Date.parse(when);
      return Number.isNaN(t) || t >= cutoff;
    })
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    .slice(0, 500);
  return Object.fromEntries(entries);
}

async function saveState(state: State): Promise<void> {
  if (DRY_RUN) {
    log("[dry-run] skip writing state");
    return;
  }
  const next: State = {
    version: 1,
    initialized: true,
    etag: state.etag ?? null,
    updatedAt: new Date().toISOString(),
    seen: pruneSeen(state.seen),
  };
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  log(`state saved to ${STATE_FILE} (${Object.keys(next.seen).length} tracked keys)`);
}

// ---------------------------------------------------------------------------
// 网络
// ---------------------------------------------------------------------------

async function fetchResets(
  etag: string | null,
): Promise<
  | { notModified: true }
  | { notModified: false; data: ResetsResponse; etag: string | null }
> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  if (etag) headers["If-None-Match"] = etag;

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(API_URL, { headers });

    if (res.status === 304) return { notModified: true };

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? 10);
      const waitMs = Math.min(Math.max(retryAfter, 1), 60) * 1000;
      log(`429 rate limited, retrying in ${waitMs / 1000}s`);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`AIHOT API ${res.status}: ${truncate(body, 300)}`);
    }

    const data = (await res.json()) as ResetsResponse;
    return { notModified: false, data, etag: res.headers.get("etag") };
  }

  throw new Error("AIHOT API kept returning 429 after retries");
}

async function sendTelegram(text: string): Promise<void> {
  if (TELEGRAM_CHATS.length === 0) {
    throw new Error("TELEGRAM_CHAT_ID is empty");
  }
  for (const chatId of TELEGRAM_CHATS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        },
      );

      if (res.ok) break;

      const body = await res.text().catch(() => "");
      if (res.status === 429 && attempt < 2) {
        let waitMs = 3000;
        try {
          const parsed = JSON.parse(body) as { parameters?: { retry_after?: number } };
          waitMs = (parsed.parameters?.retry_after ?? 3) * 1000;
        } catch {
          /* ignore */
        }
        await sleep(waitMs);
        continue;
      }
      throw new Error(`Telegram ${res.status}: ${truncate(body, 300)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

function formatMessage(event: ResetEvent, kind: Kind): string {
  const lines: string[] = [];
  const kindLabel =
    event.type === "reset_credit"
      ? "重置卡"
      : (event.label ?? event.displayLabel ?? "重置");

  if (kind === "upcoming") {
    lines.push(`🟡 <b>Codex 重置预告</b>`);
  } else {
    lines.push(`🟢 <b>Codex 重置已确认</b>`);
  }

  lines.push(`类型：${esc(kindLabel)}`);
  if (event.scope) lines.push(`范围：${esc(truncate(event.scope, 120))}`);
  if (event.title) lines.push(`标题：${esc(truncate(event.title, 120))}`);

  const scheduleLabel = event.schedule?.label;
  const estimateLabel = event.estimate?.label;
  if (scheduleLabel) lines.push(`预告时间：${esc(scheduleLabel)}`);
  if (estimateLabel && estimateLabel !== scheduleLabel) {
    lines.push(`预计窗口：${esc(estimateLabel)}`);
  }
  if (event.confirmedAt) {
    lines.push(`确认时间：${esc(formatBeijing(event.confirmedAt))}`);
  }
  if (event.occurredOn) lines.push(`核实日期：${esc(event.occurredOn)}`);

  const quote = event.posts?.find((p) => p.text ?? p.originalText);
  if (quote) {
    const stage = quote.stage ? `${quote.stage}：` : "";
    lines.push(`原文：${esc(stage)}「${esc(truncate(quote.text ?? quote.originalText ?? "", 300))}」`);
  }

  const link = quote?.url ?? event.url;
  if (link) {
    lines.push(`<a href="${escAttr(link)}">原帖</a>`);
  }
  if (event.url) {
    lines.push(`<a href="${escAttr(event.url)}">AIHOT 重置日历</a>`);
  }
  lines.push(`<i>AIHOT · 每 10 分钟检查</i>`);

  return lines.join("\n");
}

function formatBeijing(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t + 8 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours(),
  )}:${p(d.getUTCMinutes())} 北京时间`;
}

/** 基线运行时：只对“看起来仍然有效”的预告补发提醒 */
function isWorthNotifyingOnBaseline(
  event: ResetEvent,
  kind: Kind,
  now: number,
): boolean {
  if (kind !== "upcoming") return false;

  const through = ts(event.estimate?.through) || ts(event.schedule?.through);
  if (Number.isFinite(through)) {
    return through + PENDING_GRACE_HOURS * 3_600_000 >= now;
  }
  const updated = ts(event.updatedAt) || ts(event.createdAt);
  if (Number.isFinite(updated)) {
    return now - updated <= BASELINE_MAX_AGE_HOURS * 3_600_000;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!DRY_RUN && (!TELEGRAM_TOKEN || TELEGRAM_CHATS.length === 0)) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are required (or pass --dry-run)",
    );
  }

  const state = await loadState();
  const result = await fetchResets(state.etag ?? null);

  if (result.notModified) {
    log("304 Not Modified, nothing to do");
    return;
  }

  const data = result.data;
  const events = Array.isArray(data.events) ? data.events : [];
  log(
    `checkedAt=${data.checkedAt ?? "?"} events=${events.length} monitor=${
      data.monitor?.status ?? "?"
    }`,
  );

  const baseline = !state.initialized || Object.keys(state.seen).length === 0;
  if (baseline) log("baseline run: recording existing events without replaying them");

  const now = Date.now();
  const seen: Record<string, string> = { ...state.seen };
  const queue: { key: string; event: ResetEvent; kind: Kind }[] = [];
  let skippedByConfig = 0;
  let skippedStale = 0;

  for (const event of events) {
    if (!event?.id) continue;
    const kind = classify(event);
    if (!kind) continue;

    const key = `${event.id}:${event.status}`;
    if (seen[key]) continue;

    if (!NOTIFY_KINDS.has(kind)) {
      seen[key] = new Date(now).toISOString();
      skippedByConfig++;
      continue;
    }
    if (baseline && !isWorthNotifyingOnBaseline(event, kind, now)) {
      seen[key] = new Date(now).toISOString();
      skippedStale++;
      continue;
    }
    queue.push({ key, event, kind });
  }

  queue.sort((a, b) => {
    const ta = ts(a.event.updatedAt) || ts(a.event.createdAt) || 0;
    const tb = ts(b.event.updatedAt) || ts(b.event.createdAt) || 0;
    return ta - tb;
  });

  const overflow = queue.splice(MAX_MESSAGES_PER_RUN);
  for (const item of overflow) {
    log(`over per-run cap, will retry next run: ${item.key}`);
  }

  log(
    `to notify: ${queue.length} (skipped: config=${skippedByConfig}, stale=${skippedStale})`,
  );

  let failures = 0;
  for (const item of queue) {
    const text = formatMessage(item.event, item.kind);
    if (DRY_RUN) {
      log(`[dry-run] would send ${item.key}:\n---\n${text}\n---`);
      continue;
    }
    try {
      await sendTelegram(text);
      seen[item.key] = new Date(now).toISOString();
      log(`sent ${item.key} (${item.kind})`);
    } catch (err) {
      failures++;
      console.error(`[codex-resets] send failed for ${item.key}: ${String(err)}`);
    }
    // 轻微间隔，避免触发 Telegram 限流
    await sleep(300);
  }

  // 有推送失败时保留旧 ETag，否则下次 304 就再也补发不了了
  await saveState({
    ...state,
    etag: failures > 0 ? (state.etag ?? null) : result.etag,
    seen,
  });

  if (failures > 0) {
    process.exitCode = 1;
    console.error(`[codex-resets] ${failures} message(s) failed to send`);
  }
}

main().catch((err) => {
  console.error(`[codex-resets] fatal: ${String(err)}`);
  process.exitCode = 1;
});
