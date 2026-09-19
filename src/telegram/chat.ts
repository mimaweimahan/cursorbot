import type { Bot, Context } from "grammy";
import { AgentManager, BusyError, type AgentResult, type StreamView } from "../cursor/agent.ts";
import { findHost } from "../inventory.ts";
import type { VpsHost } from "../types.ts";
import type { ConfirmBroker } from "./confirm.ts";
import {
  ENTER_RE,
  enterVps,
  handleMenuText,
  isMenuLabel,
  type CommandDeps,
} from "./commands.ts";
import { clipTelegram, splitTelegram } from "./format.ts";
import { menuReply } from "./menu.ts";

export function registerChat(
  bot: Bot,
  deps: CommandDeps & { agents: AgentManager; confirm: ConfirmBroker },
): void {
  bot.command("cancel", async (ctx) => {
    if (!ctx.from) return;
    if (
      deps.wizard.cancel(ctx.from.id) ||
      deps.codehub.cancel(ctx.from.id) ||
      deps.repoWizard.cancel(ctx.from.id)
    ) {
      await ctx.reply("已取消。", menuReply());
      return;
    }
    const ok = await deps.agents.cancel(ctx.from.id);
    await ctx.reply(ok ? "已取消当前任务。" : "没有进行中的任务。", menuReply());
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith("/")) return;
    if (!ctx.from) return;

    if (isMenuLabel(text)) {
      deps.wizard.cancel(ctx.from.id);
      deps.codehub.cancel(ctx.from.id);
      deps.repoWizard.cancel(ctx.from.id);
      await handleMenuText(ctx, text, deps);
      return;
    }

    if (deps.confirm.hasPending(ctx.from.id)) {
      const remain = deps.confirm.remainSec(ctx.from.id);
      await ctx.reply(
        [
          "有一条危险操作正在等你确认。",
          remain ? `还剩约 ${remain} 秒。` : "",
          "请先点消息上的「同意执行」或「拒绝」。",
          "不想执行的话，点「停止对话」会作废这条确认。",
        ]
          .filter(Boolean)
          .join("\n"),
        menuReply(),
      );
      return;
    }

    if (await deps.repoWizard.handleText(ctx, text)) {
      return;
    }

    if (await deps.codehub.handleText(ctx, text)) {
      return;
    }

    if (await deps.wizard.handleText(ctx, text)) {
      return;
    }

    const enterMatch = text.match(ENTER_RE);
    const target = enterMatch?.[1] ?? enterMatch?.[2];
    if (target) {
      await enterVps(ctx, target, deps);
      return;
    }

    const session = deps.sessions.get(ctx.from.id);
    if (!session.chatOn) {
      await ctx.reply(
        "对话已停止，没有调用 Cursor API。点「开始对话」继续，或「进入VPS」操作机器。",
        menuReply(),
      );
      return;
    }
    if (!session.currentVpsId) {
      await runLocalAgentTurn(ctx, text, deps);
      return;
    }
    const host = findHost(session.currentVpsId);
    if (!host) {
      await ctx.reply(`列表里没有 ${session.currentVpsId}，已回到本机对话。`, menuReply());
      deps.sessions.setCurrent(ctx.from.id, null);
      await runLocalAgentTurn(ctx, text, deps);
      return;
    }

    await runAgentTurn(ctx, host, text, deps);
  });
}

export async function runLocalAgentTurn(
  ctx: Context,
  text: string,
  deps: { agents: AgentManager },
): Promise<void> {
  if (!ctx.from || !ctx.chat) return;

  let statusMsg;
  try {
    statusMsg = await ctx.reply("本机对话处理中…");
  } catch {
    return;
  }

  let lastSent = "";
  let lastAt = 0;
  const startedAt = Date.now();
  const flush = async (view: StreamView) => {
    const body = renderView("本机", view, startedAt);
    const now = Date.now();
    if (body === lastSent || now - lastAt < 800) return;
    lastSent = body;
    lastAt = now;
    try {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, clipTelegram(body));
    } catch {
      /* ignore */
    }
  };

  try {
    const result = await deps.agents.sendLocal({
      userId: ctx.from.id,
      chatId: ctx.chat.id,
      text,
      onUpdate: flush,
    });
    await deliverAgentResult(ctx, statusMsg.message_id, "本机", result);
  } catch (err) {
    const message =
      err instanceof BusyError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    await ctx.api
      .editMessageText(ctx.chat.id, statusMsg.message_id, `失败: ${clipTelegram(message)}`)
      .catch(async () => {
        await ctx.reply(`失败: ${message}`);
      });
  }
}

export async function runAgentTurn(
  ctx: Context,
  host: VpsHost,
  text: string,
  deps: { agents: AgentManager },
): Promise<void> {
  if (!ctx.from || !ctx.chat) return;

  let statusMsg;
  try {
    statusMsg = await ctx.reply(`正在处理 ${host.id} …`);
  } catch {
    return;
  }

  let lastSent = "";
  let lastAt = 0;
  const startedAt = Date.now();
  const flush = async (view: StreamView) => {
    const body = renderView(host.id, view, startedAt);
    const now = Date.now();
    if (body === lastSent || now - lastAt < 800) return;
    lastSent = body;
    lastAt = now;
    try {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, clipTelegram(body));
    } catch {
      /* ignore identical / race */
    }
  };

  try {
    const result = await deps.agents.send({
      userId: ctx.from.id,
      chatId: ctx.chat.id,
      vps: host,
      text,
      onUpdate: flush,
    });
    await deliverAgentResult(ctx, statusMsg.message_id, host.id, result);
  } catch (err) {
    const message =
      err instanceof BusyError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    await ctx.api
      .editMessageText(ctx.chat.id, statusMsg.message_id, `失败: ${clipTelegram(message)}`)
      .catch(async () => {
        await ctx.reply(`失败: ${message}`);
      });
  }
}

function renderView(vpsId: string, view: StreamView, startedAt?: number): string {
  const elapsed =
    startedAt !== undefined
      ? `⏱ ${Math.max(0, Math.floor((Date.now() - startedAt) / 1000))}s\n`
      : "";
  if (view.phase === "waiting_confirm") {
    const remain = view.remainSec !== undefined ? `还剩 ${view.remainSec}s。` : "";
    const snippet = view.waitingConfirm
      ? `\n${view.waitingConfirm.slice(0, 500)}`
      : "";
    return `[${vpsId}]\n${elapsed}⏳ 等你点「同意执行」或「拒绝」。${remain}\n点了之后这条消息会立刻变成「正在执行」，不会卡住。${snippet}`;
  }
  if (view.phase === "executing" && !view.text) {
    const tools = view.tools.length ? `🔧 ${view.tools.join(" → ")}\n` : "";
    return `[${vpsId}]\n${elapsed}▶️ 已同意，正在执行…\n${tools}`;
  }
  const tools = view.tools.length ? `🔧 ${view.tools.join(" → ")}\n` : "";
  const thinking = view.thinking && !view.text ? "思考中…\n" : "";
  const err = view.error && !view.text ? `⚠️ ${view.error}\n` : "";
  const text = view.text.trim() || (view.error ? "" : "处理中…");
  return `[${vpsId}]\n${elapsed}${tools}${thinking}${err}${text}`;
}

async function deliverAgentResult(
  ctx: Context,
  statusMessageId: number,
  scope: string,
  result: AgentResult,
): Promise<void> {
  if (!ctx.chat) return;
  if (result.superseded) {
    await ctx.api
      .editMessageText(ctx.chat.id, statusMessageId, `[${scope}] 已切换到新消息`)
      .catch(() => undefined);
    return;
  }
  const chunks = splitTelegram(formatAgentReply(scope, result));
  await ctx.api
    .editMessageText(ctx.chat.id, statusMessageId, chunks[0]!)
    .catch(async () => {
      await ctx.reply(chunks[0]!);
    });
  for (const extra of chunks.slice(1)) {
    await ctx.reply(extra);
  }
  // 编辑旧消息手机通常不提醒；再发一条新消息才会响铃/出横幅。
  const ping =
    result.status === "finished"
      ? `✅ [${scope}] 执行完成，结果已写在上一条。`
      : result.status === "cancelled"
        ? `🚫 [${scope}] 已取消。`
        : `⚠️ [${scope}] 未正常结束（${result.status}）`;
  await ctx.reply(ping, menuReply()).catch(() => undefined);
}

function formatAgentReply(scope: string, result: AgentResult): string {
  const header = result.tools.length ? `🔧 ${result.tools.join(" → ")}\n\n` : "";
  const body = result.text.trim();
  const prefix = result.interruptedPrevious ? "⏹ 已停止上一条，\n" : "";
  if (result.status === "finished") {
    return `${prefix}[${scope}] 执行完成\n${header}${body || "(无文本回复)"}`;
  }
  const reason =
    body ||
    result.error ||
    (result.status === "cancelled" ? "任务已取消" : `任务异常结束 (${result.status})`);
  return `${prefix}[${scope}] ${result.status}\n${header}${reason}`;
}
