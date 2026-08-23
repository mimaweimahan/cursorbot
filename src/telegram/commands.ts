import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { AuditLog } from "../audit.ts";
import type { AgentManager } from "../cursor/agent.ts";
import { findHost, filterHosts, loadInventory, removeHost } from "../inventory.ts";
import { findRepo, removeRepo } from "../repos.ts";
import type { SessionStore } from "../session.ts";
import type { SshPool } from "../ssh/client.ts";
import { formatExec } from "../ssh/client.ts";
import type { VpsHost } from "../types.ts";
import { clipTelegram, hostLine } from "./format.ts";
import type { CodehubWizard } from "./codehub.ts";
import { showCodehubMenu } from "./codehub.ts";
import { startDeployPick } from "./deployflow.ts";
import { Menu, isMenuLabel, menuReply } from "./menu.ts";
import type { RepoWizard } from "./repoWizard.ts";
import type { AddVpsWizard } from "./wizard.ts";

export interface CommandDeps {
  sessions: SessionStore;
  ssh: SshPool;
  wizard: AddVpsWizard;
  codehub: CodehubWizard;
  repoWizard: RepoWizard;
  audit: AuditLog;
  agents: AgentManager;
}

export function registerCommands(bot: Bot, deps: CommandDeps): void {
  bot.command("start", async (ctx) => {
    await ctx.reply(
      [
        "VPS 运维 Bot。底部是菜单。",
        `你的 user id: ${ctx.from?.id}`,
        "",
        "不用进入 VPS 也能直接对话。",
        "要操作某台机器时再点「进入VPS」。",
        "先「添加仓库」再「添加VPS」。部署时选仓库，由 Cursor 拉代码。",
      ].join("\n"),
      menuReply(),
    );
  });

  bot.command("menu", async (ctx) => {
    await ctx.reply("菜单已打开。", menuReply());
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP, menuReply());
  });

  bot.command("addvps", async (ctx) => {
    await deps.wizard.start(ctx);
  });

  bot.command("codehub", async (ctx) => {
    await showCodehubMenu(ctx);
  });

  bot.command("addrepo", async (ctx) => {
    await deps.repoWizard.start(ctx);
  });

  bot.command("editvps", async (ctx) => {
    const id = ctx.match?.toString().trim();
    if (id) await deps.wizard.startEdit(ctx, id);
    else await showVpsList(ctx, deps, { mode: "edit", hint: "点要编辑的机器。" });
  });

  bot.command("vps", async (ctx) => {
    const query = ctx.match?.toString().trim();
    await showVpsList(ctx, deps, { query, mode: "enter" });
  });

  bot.command("enter", async (ctx) => {
    const id = ctx.match?.toString().trim();
    if (!id) {
      await showVpsList(ctx, deps, { mode: "enter", hint: "点下面的按钮进入一台机器。" });
      return;
    }
    await enterVps(ctx, id, deps);
  });

  bot.command("exit", async (ctx) => {
    await leaveVps(ctx, deps);
  });

  bot.command("stop", async (ctx) => {
    await stopChat(ctx, deps);
  });

  bot.command("talk", async (ctx) => {
    await resumeChat(ctx, deps);
  });

  bot.command("who", async (ctx) => {
    await showWho(ctx, deps);
  });

  bot.command("status", async (ctx) => {
    await probeStatus(ctx, deps, ctx.match?.toString().trim());
  });
}

export async function handleMenuText(ctx: Context, text: string, deps: CommandDeps): Promise<void> {
  switch (text) {
    case Menu.list:
      await showVpsList(ctx, deps, { mode: "enter" });
      return;
    case Menu.add:
      await deps.wizard.start(ctx);
      return;
    case Menu.enter:
      await showVpsList(ctx, deps, { mode: "enter", hint: "点按钮进入一台机器。" });
      return;
    case Menu.edit:
      await showVpsList(ctx, deps, { mode: "edit", hint: "点要编辑的机器。" });
      return;
    case Menu.remove:
      await showVpsList(ctx, deps, { mode: "delete", hint: "点要删除的机器，再确认。" });
      return;
    case Menu.status:
      await probeStatus(ctx, deps);
      return;
    case Menu.who:
      await showWho(ctx, deps);
      return;
    case Menu.leave:
      await leaveVps(ctx, deps);
      return;
    case Menu.stop:
      await stopChat(ctx, deps);
      return;
    case Menu.talk:
      await resumeChat(ctx, deps);
      return;
    case Menu.code:
      await showCodehubMenu(ctx);
      return;
    case Menu.addRepo:
      await deps.repoWizard.start(ctx);
      return;
    case Menu.help:
      await ctx.reply(HELP, menuReply());
      return;
    default:
      await ctx.reply("未知菜单项。", menuReply());
  }
}

export async function showVpsList(
  ctx: Context,
  deps: CommandDeps,
  opts: { query?: string; mode: "enter" | "delete" | "edit"; hint?: string } = { mode: "enter" },
): Promise<void> {
  const hosts = filterHosts(opts.query);
  if (hosts.length === 0) {
    await ctx.reply(
      opts.query
        ? `没有匹配「${opts.query}」的机器。`
        : "还没有机器。点「添加VPS」写入列表。",
      menuReply(),
    );
    return;
  }
  const current = ctx.from ? deps.sessions.get(ctx.from.id).currentVpsId : null;
  const lines = hosts.map((h) => {
    const mark = h.id === current ? "  ← 当前" : "";
    return `• ${hostLine(h)}${mark}`;
  });
  const kb = new InlineKeyboard();
  hosts.slice(0, 20).forEach((h) => {
    if (opts.mode === "delete") {
      kb.text(btnLabel("删除 ", h.name), `dl:${h.id}`).row();
    } else if (opts.mode === "edit") {
      kb.text(btnLabel("编辑 ", h.name), `ed:${h.id}`).row();
    } else {
      kb.text(btnLabel("进入 ", h.name), `en:${h.id}`)
        .text("部署", `dp:${h.id}`)
        .text("编辑", `ed:${h.id}`)
        .row();
    }
  });
  const title =
    opts.mode === "delete" ? "删除 VPS" : opts.mode === "edit" ? "编辑 VPS" : "VPS 列表";
  const q = opts.query ? `（${opts.query}）` : "";
  await ctx.reply(
    clipTelegram(
      [opts.hint, `${title}${q} (${hosts.length})`, "", lines.join("\n")]
        .filter(Boolean)
        .join("\n"),
    ),
    { reply_markup: kb },
  );
}

export async function deployVps(ctx: Context, id: string, _deps: CommandDeps): Promise<void> {
  await startDeployPick(ctx, id);
}

export async function enterVps(ctx: Context, idOrName: string, deps: CommandDeps): Promise<VpsHost | null> {
  if (!ctx.from) return null;
  const host = findHost(idOrName);
  if (!host) {
    const all = loadInventory().map((h) => h.id).join(", ") || "(空)";
    await ctx.reply(`找不到机器「${idOrName}」。台账: ${all}`, menuReply());
    return null;
  }
  deps.sessions.setCurrent(ctx.from.id, host.id);
  deps.sessions.setChatOn(ctx.from.id, true);
  await ctx.reply(
    [
      `已进入 ${hostLine(host)}`,
      host.notes ? `备注: ${host.notes}` : "",
      host.writable
        ? "可写。直接发运维需求即可，例如：磁盘为什么满了、重启 nginx、看 error log。"
        : "只读。只能查，不能改。",
      "停止对话（不再调用 Cursor API）: 点「停止对话」  离开: 点「离开VPS」",
    ]
      .filter(Boolean)
      .join("\n"),
    menuReply(),
  );
  return host;
}

export async function startEditVps(ctx: Context, id: string, deps: CommandDeps): Promise<void> {
  await deps.wizard.startEdit(ctx, id);
}

function btnLabel(prefix: string, name: string): string {
  const s = prefix + name;
  return s.length > 28 ? `${s.slice(0, 25)}…` : s;
}

export async function confirmDelete(ctx: Context, id: string): Promise<void> {
  const host = findHost(id);
  if (!host) {
    await ctx.reply(`列表里没有 ${id}。`, menuReply());
    return;
  }
  await ctx.reply(`确认从列表删除 ${hostLine(host)} ？`, {
    reply_markup: new InlineKeyboard().text("确认删除", `dx:${id}`).text("取消", "dx:"),
  });
}

export async function executeDelete(ctx: Context, id: string, deps: CommandDeps): Promise<void> {
  if (!id) {
    await ctx.reply("已取消删除。", menuReply());
    return;
  }
  if (!ctx.from) return;
  const removed = removeHost(id);
  if (!removed) {
    await ctx.reply(`列表里没有 ${id}。`, menuReply());
    return;
  }
  deps.ssh.drop(id);
  const session = deps.sessions.get(ctx.from.id);
  if (session.currentVpsId === id) deps.sessions.setCurrent(ctx.from.id, null);
  deps.sessions.clearAgent(ctx.from.id, id);
  deps.audit.write({ userId: ctx.from.id, vpsId: id, action: "vps.delete", ok: true });
  await ctx.reply(`已从 VPS列表 删除 ${id}。`, menuReply());
}

async function leaveVps(ctx: Context, deps: CommandDeps): Promise<void> {
  if (!ctx.from) return;
  const session = deps.sessions.get(ctx.from.id);
  if (!session.currentVpsId) {
    await ctx.reply(
      session.chatOn
        ? "当前就是本机对话，直接发消息即可。"
        : "未进入 VPS，对话也已停止，没有调用 Cursor API。点「开始对话」或「进入VPS」。",
      menuReply(),
    );
    return;
  }
  const left = session.currentVpsId;
  deps.sessions.setCurrent(ctx.from.id, null);
  await ctx.reply(
    session.chatOn
      ? `已离开 ${left}，回到本机对话。直接发消息即可。`
      : `已离开 ${left}。对话仍是停止状态，不会调用 Cursor API。点「开始对话」继续。`,
    menuReply(),
  );
}

export async function stopChat(ctx: Context, deps: CommandDeps): Promise<void> {
  if (!ctx.from) return;
  const session = deps.sessions.get(ctx.from.id);
  const { cancelled } = await deps.agents.stop(ctx.from.id);
  deps.sessions.setChatOn(ctx.from.id, false);
  const where = session.currentVpsId ? `仍在 ${session.currentVpsId}，但` : "";
  await ctx.reply(
    [
      cancelled ? "已打断当前 Cursor 任务。" : "当前没有进行中的 Cursor 任务。",
      `${where}对话已停止，不再调用 Cursor API。`,
      "菜单（列表、备份、部署）照常可用。要点「开始对话」或再「进入VPS」才会重新调用。",
    ].join("\n"),
    menuReply(),
  );
}

export async function resumeChat(ctx: Context, deps: CommandDeps): Promise<void> {
  if (!ctx.from) return;
  deps.sessions.setChatOn(ctx.from.id, true);
  const session = deps.sessions.get(ctx.from.id);
  if (session.currentVpsId) {
    await ctx.reply(`已恢复对话，仍在 ${session.currentVpsId}。直接发运维需求即可。`, menuReply());
    return;
  }
  await ctx.reply("已恢复本机对话。直接发消息即可。要操作机器，点「进入VPS」。", menuReply());
}

async function showWho(ctx: Context, deps: CommandDeps): Promise<void> {
  if (!ctx.from) return;
  const session = deps.sessions.get(ctx.from.id);
  if (!session.currentVpsId) {
    const agentId = session.agents.local;
    await ctx.reply(
      [
        "当前：本机对话（未进入 VPS）",
        session.chatOn
          ? "直接发消息即可。要操作某台机器，点「进入VPS」。"
          : "对话已停止，不会调用 Cursor API。点「开始对话」或「进入VPS」。",
        agentId ? `Agent: ${agentId}` : "Agent: 尚未创建（发一条消息后会启动）",
      ].join("\n"),
      menuReply(),
    );
    return;
  }
  const host = findHost(session.currentVpsId);
  const agentId = session.agents[session.currentVpsId];
  if (!host) {
    await ctx.reply(`当前会话指向 ${session.currentVpsId}，但列表里已经没有这台机。`, menuReply());
    return;
  }
  await ctx.reply(
    [
      `当前 VPS: ${hostLine(host)}`,
      session.chatOn
        ? "对话开启，发消息会调用 Cursor API。"
        : "对话已停止，发消息不会调用 Cursor API。点「开始对话」恢复。",
      agentId ? `Agent: ${agentId}` : "Agent: 尚未创建（发一条消息后会启动）",
      host.notes ? `备注: ${host.notes}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    menuReply(),
  );
}

async function probeStatus(ctx: Context, deps: CommandDeps, arg?: string): Promise<void> {
  const id = arg || (ctx.from ? deps.sessions.get(ctx.from.id).currentVpsId : null);
  if (!id) {
    await showVpsList(ctx, deps, { mode: "enter", hint: "先进入一台机器，或 /status <id>。" });
    return;
  }
  const host = findHost(id);
  if (!host) {
    await ctx.reply(`找不到机器 ${id}。`, menuReply());
    return;
  }
  await ctx.reply(`正在探测 ${host.id} …`);
  try {
    const result = await deps.ssh.metrics(host);
    await ctx.reply(clipTelegram(`${hostLine(host)}\n\n${formatExec(result)}`), menuReply());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.ssh.drop(host.id);
    await ctx.reply(`无法连接 ${host.id}: ${message}`, menuReply());
  }
}

export { isMenuLabel };

export const ENTER_RE = /^(?:进入|进机)\s*(\S+)$|^(?:进|enter)\s+(\S+)$/i;

export const HELP = [
  "流程：本地改代码 → 推 GitHub（R2 备份）→ 先添加仓库 → 再添加 VPS → 部署时选仓库。",
  "Cursor 只负责往新机器拉代码、跑部署命令，不在 VPS 上改业务代码。",
  "",
  "R2 备份名称必须对齐：一个便签 = 一个 GitHub 仓库 = projects/{便签}/latest.tar.gz。",
  "不用 GitHub 仓库名当 R2 名，也不另起项目名。改便签等于换路径。",
  "",
  "底部菜单：VPS 与「代码仓库 / 添加仓库」。",
  "每台 VPS、每个仓库的 id 必须唯一。",
  "台账（VPS、简介、密钥密文）在 data/bot.sqlite，跟 bot 仓库一起 git 同步。换机器：git pull + 同一份 .env（尤其 VPS_SECRET）。不同步到 R2。",
  "",
  "/codehub      仓库与密钥",
  "/editvps [id] 编辑机器",
  "/vps [关键字] 列出机器",
  "/enter <id>   进入",
  "/exit         离开",
  "/status [id]  SSH 探测",
  "/cancel       取消添加或取消当前任务",
  "/stop         停止对话，不再调用 Cursor API",
  "/talk         恢复对话",
  "",
  "没进入 VPS 时直接说话，走本机 Cursor 对话。",
  "进入后说话才是远程运维，例如：「磁盘为什么满了」",
  "在 VPS 里要点「停止对话」，立刻停掉当前调用，之后也不再打 Cursor API。",
].join("\n");

export async function confirmDeleteRepo(ctx: Context, id: string): Promise<void> {
  const repo = findRepo(id);
  if (!repo) {
    await ctx.reply(`没有仓库 ${id}。`, menuReply());
    return;
  }
  await ctx.reply(`确认删除仓库 ${repo.name}（${repo.id}）？`, {
    reply_markup: new InlineKeyboard()
      .text("确认删除", `rx:${repo.id}`)
      .text("取消", "ch:list"),
  });
}

export async function executeDeleteRepo(ctx: Context, id: string, deps: CommandDeps): Promise<void> {
  if (!ctx.from) return;
  const removed = removeRepo(id);
  if (!removed) {
    await ctx.reply(`没有仓库 ${id}。`, menuReply());
    return;
  }
  const session = deps.sessions.get(ctx.from.id);
  if (session.lastRepoId === id) deps.sessions.setLastRepo(ctx.from.id, null);
  deps.audit.write({
    userId: ctx.from.id,
    vpsId: "-",
    action: "repo.delete",
    detail: removed.githubRepo,
    ok: true,
  });
  await ctx.reply(`已删除仓库 ${removed.name}。`, menuReply());
}
