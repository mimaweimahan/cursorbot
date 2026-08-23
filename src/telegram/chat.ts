import type { Bot, Context } from "grammy";
import { AgentManager, BusyError, type StreamView } from "../cursor/agent.ts";
import { findHost } from "../inventory.ts";
import type { VpsHost } from "../types.ts";
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
  deps: CommandDeps & { agents: AgentManager },
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
  const flush = async (view: StreamView) => {
    const body = renderView("本机", view);
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
    const finalText =
      result.text.trim() ||
      (result.status === "finished" ? "(无文本回复)" : `任务结束: ${result.status}`);
    const header = result.tools.length ? `🔧 ${result.tools.join(" → ")}\n\n` : "";
    const chunks = splitTelegram(`[本机] ${result.status}\n${header}${finalText}`);
    await ctx.api
      .editMessageText(ctx.chat.id, statusMsg.message_id, chunks[0]!)
      .catch(async () => {
        await ctx.reply(chunks[0]!);
      });
    for (const extra of chunks.slice(1)) {
      await ctx.reply(extra);
    }
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
  const flush = async (view: StreamView) => {
    const body = renderView(host.id, view);
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
    const finalText =
      result.text.trim() ||
      (result.status === "finished" ? "(无文本回复)" : `任务结束: ${result.status}`);
    const header = result.tools.length ? `🔧 ${result.tools.join(" → ")}\n\n` : "";
    const chunks = splitTelegram(`[${host.id}] ${result.status}\n${header}${finalText}`);
    await ctx.api
      .editMessageText(ctx.chat.id, statusMsg.message_id, chunks[0]!)
      .catch(async () => {
        await ctx.reply(chunks[0]!);
      });
    for (const extra of chunks.slice(1)) {
      await ctx.reply(extra);
    }
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

function renderView(vpsId: string, view: StreamView): string {
  const tools = view.tools.length ? `🔧 ${view.tools.join(" → ")}\n` : "";
  const thinking = view.thinking && !view.text ? "思考中…\n" : "";
  const text = view.text.trim() || "处理中…";
  return `[${vpsId}]\n${tools}${thinking}${text}`;
}
