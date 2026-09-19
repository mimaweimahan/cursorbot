import { Bot } from "grammy";
import { AuditLog } from "./audit.ts";
import { isAllowed } from "./auth.ts";
import { config, enrollOwner, ensureDataDirs } from "./config.ts";
import { closeDb, getDb } from "./db.ts";
import { AgentManager } from "./cursor/agent.ts";
import { loadInventory } from "./inventory.ts";
import { loadRepos } from "./repos.ts";
import { SessionStore } from "./session.ts";
import { SshPool } from "./ssh/client.ts";
import { registerChat, runAgentTurn } from "./telegram/chat.ts";
import {
  confirmDelete,
  confirmDeleteRepo,
  deployVps,
  enterVps,
  executeDelete,
  executeDeleteRepo,
  registerCommands,
  startEditVps,
} from "./telegram/commands.ts";
import { ConfirmBroker } from "./telegram/confirm.ts";
import { startConcurrentPolling } from "./telegram/poll.ts";
import { CodehubWizard, runBackup, showRepoIntro, showRepoList } from "./telegram/codehub.ts";
import { bindDeploy, takePendingVps } from "./telegram/deployflow.ts";
import { RepoWizard } from "./telegram/repoWizard.ts";
import { AddVpsWizard } from "./telegram/wizard.ts";
import { statusText } from "./codehub.ts";

ensureDataDirs();
getDb();
const sessions = new SessionStore();
sessions.rehydrateAfterRestart();
const ssh = new SshPool();
const confirm = new ConfirmBroker();
const audit = new AuditLog();
const wizard = new AddVpsWizard(audit, ssh, sessions);
const codehub = new CodehubWizard();
const repoWizard = new RepoWizard(audit);
const agents = new AgentManager({ ssh, confirm, audit, sessions });
const bot = new Bot(config.telegramToken);
confirm.setApi(bot.api);

const cmdDeps = { sessions, ssh, wizard, codehub, repoWizard, audit, agents };

bot.use(async (ctx, next) => {
  const uid = ctx.from?.id;
  if (uid !== undefined && config.allowedIds.length === 0) {
    enrollOwner(uid);
  }
  if (!isAllowed(uid)) {
    const text = ctx.message?.text ?? "";
    if (text.startsWith("/start") || text.startsWith("/help")) {
      await ctx.reply(`未授权。你的 Telegram user id 是 ${uid ?? "未知"}。把它加到 TELEGRAM_ALLOWED_IDS。`);
    }
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: "未授权", show_alert: true }).catch(() => undefined);
    }
    return;
  }
  await next();
});

registerCommands(bot, cmdDeps);
registerChat(bot, { ...cmdDeps, agents, confirm });

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (data.startsWith("wz:")) {
    const handled = await wizard.handleCallback(ctx, data);
    if (handled) await ctx.answerCallbackQuery();
    else await ctx.answerCallbackQuery({ text: "已失效" });
    return;
  }
  if (data.startsWith("rw:")) {
    const handled = await repoWizard.handleCallback(ctx, data);
    if (handled) await ctx.answerCallbackQuery();
    else await ctx.answerCallbackQuery({ text: "已失效" });
    return;
  }
  if (data.startsWith("ch:")) {
    if (data === "ch:add") {
      await ctx.answerCallbackQuery();
      await repoWizard.start(ctx);
      return;
    }
    if (data === "ch:list") {
      await ctx.answerCallbackQuery();
      await showRepoList(ctx, "edit");
      return;
    }
    if (data === "ch:cfg") {
      await ctx.answerCallbackQuery();
      await codehub.start(ctx);
      return;
    }
    if (data === "ch:bak") {
      await ctx.answerCallbackQuery();
      await runBackup(ctx);
      return;
    }
    if (data === "ch:st") {
      await ctx.answerCallbackQuery();
      await ctx.reply(statusText());
      return;
    }
    const handled = await codehub.handleCallback(ctx, data);
    if (handled) await ctx.answerCallbackQuery();
    else await ctx.answerCallbackQuery({ text: "已失效" });
    return;
  }
  const deploy = /^dp:(.+)$/.exec(data);
  if (deploy?.[1]) {
    await ctx.answerCallbackQuery();
    await deployVps(ctx, deploy[1], cmdDeps);
    return;
  }
  const pick = /^pk:(.+)$/.exec(data);
  if (pick?.[1] && ctx.from) {
    await ctx.answerCallbackQuery();
    const vpsId = takePendingVps(ctx.from.id);
    if (!vpsId) {
      await ctx.reply("先点某台 VPS 的「部署」，再选仓库。");
      return;
    }
    const bound = bindDeploy(sessions, ctx.from.id, vpsId, pick[1]);
    if (!bound) {
      await ctx.reply("机器或仓库不存在。");
      return;
    }
    await ctx.reply(`已选 ${bound.repo.name}，正在让 Cursor 拉取部署…`);
    await runAgentTurn(ctx, bound.host, bound.prompt, { agents });
    return;
  }
  const repoIntro = /^ri:(.+)$/.exec(data);
  if (repoIntro?.[1]) {
    await ctx.answerCallbackQuery();
    await showRepoIntro(ctx, repoIntro[1]);
    return;
  }
  const introEdit = /^ie:(.+)$/.exec(data);
  if (introEdit?.[1]) {
    await ctx.answerCallbackQuery();
    await repoWizard.startIntro(ctx, introEdit[1]);
    return;
  }
  const repoEdit = /^re:(.+)$/.exec(data);
  if (repoEdit?.[1]) {
    await ctx.answerCallbackQuery();
    await repoWizard.startEdit(ctx, repoEdit[1]);
    return;
  }
  const repoDel = /^rd:(.+)$/.exec(data);
  if (repoDel?.[1]) {
    await ctx.answerCallbackQuery();
    await confirmDeleteRepo(ctx, repoDel[1]);
    return;
  }
  if (data.startsWith("rx:")) {
    await ctx.answerCallbackQuery();
    await executeDeleteRepo(ctx, data.slice(3), cmdDeps);
    return;
  }
  const repoBak = /^rb:(.+)$/.exec(data);
  if (repoBak?.[1]) {
    await ctx.answerCallbackQuery();
    await runBackup(ctx, repoBak[1]);
    return;
  }
  const enter = /^en:(.+)$/.exec(data);
  if (enter?.[1]) {
    await ctx.answerCallbackQuery();
    await enterVps(ctx, enter[1], cmdDeps);
    return;
  }
  const edit = /^ed:(.+)$/.exec(data);
  if (edit?.[1]) {
    await ctx.answerCallbackQuery();
    await startEditVps(ctx, edit[1], cmdDeps);
    return;
  }
  const delAsk = /^dl:(.+)$/.exec(data);
  if (delAsk?.[1]) {
    await ctx.answerCallbackQuery();
    await confirmDelete(ctx, delAsk[1]);
    return;
  }
  if (data.startsWith("dx:")) {
    await ctx.answerCallbackQuery();
    await executeDelete(ctx, data.slice(3), cmdDeps);
    return;
  }
  const cf = /^cf:([0-9a-f]+):([01])$/.exec(data);
  if (cf) {
    const ok = cf[2] === "1";
    const alive = confirm.peek(cf[1]!);
    console.log(`confirm click id=${cf[1]} ok=${ok} alive=${alive}`);
    // 先落地确认，再应答 Telegram。answer 失败（query too old）也不能丢掉点击。
    if (alive) confirm.handle(cf[1]!, ok);
    await ctx
      .answerCallbackQuery({
        text: alive ? (ok ? "已同意，开始执行" : "已拒绝") : "这条确认已失效（超时或已处理）",
        show_alert: !alive,
      })
      .catch(() => undefined);
    return;
  }
  await ctx.answerCallbackQuery().catch(() => undefined);
});

bot.catch((err) => {
  console.error("bot error", err);
});

let stopPolling: (() => Promise<void>) | undefined;

async function shutdown(signal: string): Promise<void> {
  console.log(`收到 ${signal}，退出`);
  try {
    await stopPolling?.();
  } catch {
    /* ignore */
  }
  try {
    await agents.closeAll();
  } catch {
    /* ignore */
  }
  ssh.closeAll();
  closeDb();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await bot.api.setMyCommands([
  { command: "menu", description: "打开底部菜单" },
  { command: "addvps", description: "添加一台 VPS 到列表" },
  { command: "editvps", description: "编辑一台 VPS" },
  { command: "vps", description: "VPS 列表" },
  { command: "enter", description: "进入一台 VPS" },
  { command: "exit", description: "离开当前 VPS" },
  { command: "status", description: "探测机器状态" },
  { command: "who", description: "当前会话" },
  { command: "track", description: "跟踪对话进度与最近操作" },
  { command: "codehub", description: "代码仓库与密钥" },
  { command: "addrepo", description: "添加一个代码仓库" },
  { command: "cancel", description: "取消添加或取消任务" },
  { command: "stop", description: "停止对话，不再调用 Cursor API" },
  { command: "talk", description: "恢复对话" },
  { command: "reset", description: "重置对话（作废确认、换新 Agent）" },
  { command: "help", description: "命令说明" },
  { command: "start", description: "开始 / 查看自己的 user id" },
]);

console.log(
  `白名单 ${config.allowedIds.length} 人，台账 ${loadInventory().length} 台 VPS，${loadRepos().length} 个仓库；已重置过期 Agent，对话已重新打开`,
);
stopPolling = await startConcurrentPolling(bot, (info) => {
  console.log(`以 @${info.username} 登录（并发轮询，确认按钮可即时处理）`);
});
