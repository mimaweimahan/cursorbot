import fs from "node:fs";
import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { AuditLog } from "../audit.ts";
import { encryptSecret } from "../crypto.ts";
import { findHost, loadInventory, removeHost, upsertHost, validateId } from "../inventory.ts";
import type { SessionStore } from "../session.ts";
import type { SshPool } from "../ssh/client.ts";
import type { VpsHost } from "../types.ts";
import { hostLine } from "./format.ts";
import { menuReply } from "./menu.ts";

export const VPS_TEMPLATE = [
  "id: vps-1",
  "name: 名称",
  "host: 1.2.3.4",
  "port: 22",
  "user: root",
  "password: 你的密码",
  "writable: yes",
  "notes:",
].join("\n");

const KEY_ALIASES: Record<string, string> = {
  id: "id",
  name: "name",
  名称: "name",
  名字: "name",
  host: "host",
  ip: "host",
  主机: "host",
  地址: "host",
  port: "port",
  端口: "port",
  user: "user",
  username: "user",
  用户: "user",
  用户名: "user",
  password: "password",
  passwd: "password",
  密码: "password",
  identityfile: "identityFile",
  key: "identityFile",
  私钥: "identityFile",
  writable: "writable",
  可写: "writable",
  notes: "notes",
  备注: "notes",
  repo: "repo",
  仓库: "repo",
  branch: "branch",
  分支: "branch",
  deploypath: "deployPath",
  部署路径: "deployPath",
  deploycmd: "deployCmd",
  部署命令: "deployCmd",
  overwrite: "overwrite",
  覆盖: "overwrite",
};

export function looksLikeVpsTemplate(text: string): boolean {
  const fields = extractFields(stripFence(text));
  return Boolean(fields.id && fields.host);
}

export class AddVpsWizard {
  private waiting = new Set<number>();
  private editingId = new Map<number, string>();

  constructor(
    private audit: AuditLog,
    private ssh: SshPool,
    private sessions: SessionStore,
  ) {}

  isActive(userId: number): boolean {
    return this.waiting.has(userId);
  }

  cancel(userId: number): boolean {
    const a = this.waiting.delete(userId);
    const b = this.editingId.delete(userId);
    return a || b;
  }

  async start(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    this.waiting.add(ctx.from.id);
    this.editingId.delete(ctx.from.id);
    const template = buildTemplate();
    await ctx.reply(
      [
        "复制下面模板，改完后<strong>整段一起发回来</strong>就会保存。",
        "<strong>每台机器的 id 必须不同</strong>，不要沿用示例里的 id。",
        "一次可以发多台，中间空一行或写 ---",
        "密码会立刻加密。发完请自己删掉聊天里的那条。",
        "取消发 /cancel。",
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("取消", "wz:cancel"),
      },
    );
    await ctx.reply(`<pre>${escapeHtml(template)}</pre>`, { parse_mode: "HTML" });
  }

  async startEdit(ctx: Context, id: string): Promise<void> {
    if (!ctx.from) return;
    const host = findHost(id);
    if (!host) {
      await ctx.reply(`列表里没有 ${id}。`, menuReply());
      return;
    }
    this.waiting.add(ctx.from.id);
    this.editingId.set(ctx.from.id, host.id);
    await ctx.reply(
      [
        `编辑 <strong>${escapeHtml(host.id)}</strong>。复制下面模板改完整段发回。`,
        "password 填 <code>*</code> 表示不改密码。要换密码就写成新密码。",
        "若改 id，会保存为新 id 并去掉旧的。",
        "取消发 /cancel。",
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("取消", "wz:cancel"),
      },
    );
    await ctx.reply(`<pre>${escapeHtml(editTemplate(host))}</pre>`, { parse_mode: "HTML" });
  }

  async handleText(ctx: Context, text: string): Promise<boolean> {
    if (!ctx.from) return false;
    if (text === "/cancel" || text === "取消") {
      this.cancel(ctx.from.id);
      await ctx.reply("已取消添加。", menuReply());
      return true;
    }
    if (!this.waiting.has(ctx.from.id) && !looksLikeVpsTemplate(text)) {
      return false;
    }
    try {
      const hosts = parseTemplates(text);
      await this.saveAll(ctx, hosts);
      await scrubMessage(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.waiting.add(ctx.from.id);
      await ctx.reply(
        `${message}\n\n请按模板整段发，示例：\n<pre>${escapeHtml(VPS_TEMPLATE)}</pre>`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("取消", "wz:cancel") },
      );
    }
    return true;
  }

  async handleCallback(ctx: Context, data: string): Promise<boolean> {
    if (!ctx.from) return false;
    if (data === "wz:cancel") {
      this.cancel(ctx.from.id);
      await ctx.reply("已取消添加。", menuReply());
      return true;
    }
    return false;
  }

  private async saveAll(ctx: Context, items: ParsedHost[]): Promise<void> {
    if (!ctx.from) return;
    const editId = this.editingId.get(ctx.from.id);
    const lines: string[] = [];
    for (const item of items) {
      const host = applyKeepPassword(item, editId);
      const existing = findHost(host.id);
      const replacingSelf = Boolean(editId && (host.id === editId || item.overwrite));
      if (existing && !item.overwrite && !replacingSelf) {
        throw new Error(
          `id「${host.id}」已存在（${existing.name} / ${existing.host}）。请换一个 id。若要覆盖原机，加一行 overwrite: yes`,
        );
      }
      const { created } = upsertHost(host);
      if (editId && host.id !== editId) {
        removeHost(editId);
        this.ssh.drop(editId);
        const session = this.sessions.get(ctx.from.id);
        if (session.currentVpsId === editId) {
          this.sessions.setCurrent(ctx.from.id, host.id);
        }
        this.sessions.clearAgent(ctx.from.id, editId);
      }
      this.ssh.drop(host.id);
      this.audit.write({
        userId: ctx.from.id,
        vpsId: host.id,
        action: created && !editId ? "vps.add" : "vps.update",
        detail: `${host.user}@${host.host}:${host.port} ${host.passwordEnc ? "password" : "key"}`,
        ok: true,
      });
      lines.push(`${editId || !created ? "已更新" : "已加入"} ${hostLine(host)}`);
    }
    this.waiting.delete(ctx.from.id);
    this.editingId.delete(ctx.from.id);
    const kb = new InlineKeyboard();
    for (const item of items) {
      kb.text(`进入 ${item.host.name}`, `en:${item.host.id}`)
        .text("部署", `dp:${item.host.id}`)
        .row();
    }
    await ctx.reply(
      [
        ...lines,
        "",
        `当前共 ${loadInventory().length} 台。点「部署」会先选已添加的仓库，再由 Cursor 拉取。`,
      ].join("\n"),
      { reply_markup: kb },
    );
  }
}

interface ParsedHost {
  host: VpsHost;
  overwrite: boolean;
  keepPassword: boolean;
}

export function parseTemplates(raw: string): ParsedHost[] {
  const blocks = splitBlocks(stripFence(raw));
  if (blocks.length === 0) {
    throw new Error("没读到有效模板。需要至少包含 id 和 host。");
  }
  const items = blocks.map(parseOne);
  const seen = new Set<string>();
  for (const { host } of items) {
    if (seen.has(host.id)) {
      throw new Error(`这次消息里 id「${host.id}」重复了，每台机器要不同的 id`);
    }
    seen.add(host.id);
  }
  return items;
}

export function parseTemplate(raw: string): VpsHost {
  return parseOne(stripFence(raw)).host;
}

function parseOne(block: string): ParsedHost {
  const fields = extractFields(block);
  const id = fields.id?.trim() ?? "";
  const idErr = validateId(id);
  if (idErr) throw new Error(idErr);

  const hostField = fields.host?.trim() ?? "";
  if (!hostField) throw new Error("缺少 host（IP 或域名）");
  const parsed = parseHostPort(hostField);

  let port = parsed.port ?? 22;
  if (fields.port?.trim()) {
    const p = Number(fields.port.trim());
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new Error("port 必须是 1–65535");
    }
    port = p;
  }

  const passwordRaw = fields.password ?? "";
  const keepPassword = isKeepPassword(passwordRaw);
  const password = keepPassword ? "" : passwordRaw;
  const identityFile = fields.identityFile?.trim() ?? "";
  if (!keepPassword && !password && !identityFile) {
    throw new Error("请填 password，或改成 identityFile 走密钥登录");
  }
  if (identityFile && !fs.existsSync(identityFile)) {
    throw new Error(`找不到私钥文件：${identityFile}`);
  }

  return {
    overwrite: parseOverwrite(fields.overwrite ?? ""),
    keepPassword,
    host: {
      id,
      name: fields.name?.trim() || id,
      host: parsed.host,
      port,
      user: fields.user?.trim() || "root",
      identityFile: password ? "" : identityFile,
      passwordEnc: password ? encryptSecret(password) : "",
      tags: [],
      notes: fields.notes?.trim() ?? "",
      writable: parseWritable(fields.writable ?? "yes"),
      allowedServices: null,
      repo: fields.repo?.trim() ?? "",
      branch: fields.branch?.trim() ?? "",
      deployPath: fields.deployPath?.trim() ?? "",
      deployCmd: fields.deployCmd?.trim() ?? "",
    },
  };
}

function splitBlocks(text: string): string[] {
  const byDash = text
    .split(/^\s*---\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
  if (byDash.length > 1) return byDash;

  const lines = text.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];
  const isId = (line: string) => /^(id|主机)\s*:/i.test(line.trim());
  for (const line of lines) {
    if (isId(line) && current.some(isId)) {
      blocks.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks.map((b) => b.trim()).filter((b) => extractFields(b).id);
}

function buildTemplate(): string {
  const used = new Set(loadInventory().map((h) => h.id));
  let n = 1;
  while (used.has(`vps-${n}`)) n++;
  return VPS_TEMPLATE.replace("id: vps-1", `id: vps-${n}`);
}

function editTemplate(host: VpsHost): string {
  const lines = [
    `id: ${host.id}`,
    `name: ${host.name}`,
    `host: ${host.host}`,
    `port: ${host.port}`,
    `user: ${host.user}`,
  ];
  if (host.passwordEnc) lines.push("password: *");
  if (host.identityFile) lines.push(`identityFile: ${host.identityFile}`);
  lines.push(`writable: ${host.writable ? "yes" : "no"}`);
  lines.push(`notes: ${host.notes}`);
  return lines.join("\n");
}

function isKeepPassword(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === "" || t === "*" || t === "-" || t === "不改" || t === "keep";
}

function applyKeepPassword(item: ParsedHost, editId: string | undefined): VpsHost {
  const host = { ...item.host };
  const prev = (editId ? findHost(editId) : undefined) ?? findHost(host.id);
  if (prev) {
    if (!host.repo) host.repo = prev.repo;
    if (!host.branch) host.branch = prev.branch;
    if (!host.deployPath) host.deployPath = prev.deployPath;
    if (!host.deployCmd) host.deployCmd = prev.deployCmd;
  }
  if (!item.keepPassword) return host;
  if (!prev?.passwordEnc && !host.identityFile && !prev?.identityFile) {
    throw new Error("这台机没有已保存的密码，请填写 password");
  }
  host.passwordEnc = prev?.passwordEnc ?? "";
  if (!host.identityFile) host.identityFile = prev?.identityFile ?? "";
  if (host.passwordEnc) host.identityFile = "";
  return host;
}

function parseOverwrite(text: string): boolean {
  const t = text.trim().toLowerCase();
  return ["yes", "y", "true", "1", "是", "覆盖"].includes(t);
}

function stripFence(text: string): string {
  return text.trim().replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
}

function extractFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = /^([^\s:]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!m) continue;
    const key = KEY_ALIASES[m[1]!.toLowerCase()];
    if (!key) continue;
    fields[key] = m[2] ?? "";
  }
  return fields;
}

function parseHostPort(input: string): { host: string; port?: number } {
  const trimmed = input.trim();
  const m = /^(.+):(\d+)$/.exec(trimmed);
  if (!m) {
    if (!trimmed) throw new Error("host 不能为空");
    return { host: trimmed };
  }
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("端口非法");
  }
  return { host: m[1]!, port };
}

function parseWritable(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t || ["yes", "y", "true", "1", "可写", "写"].includes(t)) return true;
  if (["no", "n", "false", "0", "只读", "读"].includes(t)) return false;
  throw new Error("writable 填 yes 或 no");
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function scrubMessage(ctx: Context): Promise<void> {
  if (!ctx.chat || !ctx.message) return;
  try {
    await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
  } catch {
    await ctx.reply("请自己删掉刚才那条带密码的消息。");
  }
}
