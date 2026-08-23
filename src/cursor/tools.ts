import type { SDKCustomTool } from "@cursor/sdk";
import type { AuditLog } from "../audit.ts";
import { dangerousReason, isDangerousCommand, isDangerousPath } from "../dangerous.ts";
import { formatExec, type SshPool } from "../ssh/client.ts";
import type { VpsHost } from "../types.ts";
import type { ConfirmBroker } from "../telegram/confirm.ts";
import { deployToVps, backupRepoToR2, resolveCodeRepo } from "../deploy.ts";
import { formatRepoCheck, verifyListedRepo } from "../github.ts";

interface ToolDeps {
  vps: VpsHost;
  userId: number;
  chatId: number;
  ssh: SshPool;
  confirm: ConfirmBroker;
  audit: AuditLog;
  lastRepoId?: string;
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`缺少参数 ${key}`);
  }
  return value.trim();
}

function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${key} 必须是数字`);
  return n;
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function buildVpsTools(deps: ToolDeps): Record<string, SDKCustomTool> {
  const { vps, userId, ssh, confirm, audit, chatId, lastRepoId } = deps;

  const exec: SDKCustomTool = {
    description:
      `在远程 VPS ${vps.id} (${vps.user}@${vps.host}) 上执行 shell 命令。不要用本机 shell。`,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "要在远程机执行的命令" },
      },
      required: ["command"],
    },
    async execute(args) {
      if (!vps.writable) {
        audit.write({ userId, vpsId: vps.id, action: "exec", detail: "denied-readonly", ok: false });
        return toolError("这台机器是只读，禁止 exec。请用 metrics / logs / read_file / list_dir。");
      }
      const command = str(args, "command");
      if (isDangerousCommand(command)) {
        const ok = await confirm.ask(
          chatId,
          `危险操作（${dangerousReason(command)}）\n机器: ${vps.id}\n命令:\n${command}`,
        );
        if (!ok) {
          audit.write({ userId, vpsId: vps.id, action: "exec", detail: command, ok: false, error: "cancelled" });
          return toolError("用户取消了该命令。");
        }
      }
      try {
        const result = await ssh.exec(vps, command);
        audit.write({
          userId,
          vpsId: vps.id,
          action: "exec",
          detail: command.slice(0, 200),
          ok: result.code === 0 && !result.timedOut,
        });
        return formatExec(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        audit.write({ userId, vpsId: vps.id, action: "exec", detail: command, ok: false, error: message });
        return toolError(message);
      }
    },
  };

  const readFile: SDKCustomTool = {
    description: `读取远程 VPS ${vps.id} 上的文本文件。`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "远程绝对路径" },
      },
      required: ["path"],
    },
    async execute(args) {
      const remotePath = str(args, "path");
      try {
        const buf = await ssh.readFile(vps, remotePath);
        audit.write({ userId, vpsId: vps.id, action: "read_file", detail: remotePath, ok: true });
        return buf.toString("utf8");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        audit.write({ userId, vpsId: vps.id, action: "read_file", detail: remotePath, ok: false, error: message });
        return toolError(message);
      }
    },
  };

  const writeFile: SDKCustomTool = {
    description: `写入远程 VPS ${vps.id} 上的文本文件。只读机器不可用。`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "远程绝对路径" },
        content: { type: "string", description: "完整文件内容" },
      },
      required: ["path", "content"],
    },
    async execute(args) {
      if (!vps.writable) {
        return toolError("这台机器是只读，禁止 write_file。");
      }
      const remotePath = str(args, "path");
      const content = typeof args.content === "string" ? args.content : String(args.content ?? "");
      if (isDangerousPath(remotePath)) {
        const ok = await confirm.ask(
          chatId,
          `即将覆盖敏感文件\n机器: ${vps.id}\n路径: ${remotePath}\n大小: ${content.length} 字符`,
        );
        if (!ok) {
          audit.write({ userId, vpsId: vps.id, action: "write_file", detail: remotePath, ok: false, error: "cancelled" });
          return toolError("用户取消了写入。");
        }
      }
      try {
        await ssh.writeFile(vps, remotePath, content);
        audit.write({ userId, vpsId: vps.id, action: "write_file", detail: remotePath, ok: true });
        return `已写入 ${remotePath}（${content.length} 字符）`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        audit.write({ userId, vpsId: vps.id, action: "write_file", detail: remotePath, ok: false, error: message });
        return toolError(message);
      }
    },
  };

  const listDir: SDKCustomTool = {
    description: `列出远程 VPS ${vps.id} 上的目录内容。`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "远程目录绝对路径" },
      },
      required: ["path"],
    },
    async execute(args) {
      const remotePath = str(args, "path");
      try {
        const listing = await ssh.listDir(vps, remotePath);
        audit.write({ userId, vpsId: vps.id, action: "list_dir", detail: remotePath, ok: true });
        return listing;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        audit.write({ userId, vpsId: vps.id, action: "list_dir", detail: remotePath, ok: false, error: message });
        return toolError(message);
      }
    },
  };

  const service: SDKCustomTool = {
    description: `用 systemctl 管理远程 VPS ${vps.id} 上的服务。action: status/start/stop/restart/enable/disable。`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "status | start | stop | restart | enable | disable" },
        name: { type: "string", description: "systemd 单元名，如 nginx" },
      },
      required: ["action", "name"],
    },
    async execute(args) {
      const action = str(args, "action").toLowerCase();
      const name = str(args, "name");
      if (!/^(status|start|stop|restart|enable|disable)$/.test(action)) {
        return toolError("action 只能是 status/start/stop/restart/enable/disable");
      }
      if (!/^[a-zA-Z0-9@._-]+$/.test(name)) {
        return toolError("非法服务名");
      }
      if (vps.allowedServices && !vps.allowedServices.includes(name)) {
        return toolError(`服务 ${name} 不在允许列表: ${vps.allowedServices.join(", ")}`);
      }
      if (action !== "status" && !vps.writable) {
        return toolError("只读机器只能 status。");
      }
      if (action !== "status") {
        const ok = await confirm.ask(
          chatId,
          `即将 systemctl ${action} ${name}\n机器: ${vps.id}`,
        );
        if (!ok) {
          audit.write({ userId, vpsId: vps.id, action: "service", detail: `${action} ${name}`, ok: false, error: "cancelled" });
          return toolError("用户取消了服务操作。");
        }
      }
      try {
        const result = await ssh.exec(vps, `systemctl ${action} ${name} --no-pager`);
        audit.write({
          userId,
          vpsId: vps.id,
          action: "service",
          detail: `${action} ${name}`,
          ok: result.code === 0,
        });
        return formatExec(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        audit.write({ userId, vpsId: vps.id, action: "service", detail: `${action} ${name}`, ok: false, error: message });
        return toolError(message);
      }
    },
  };

  const logs: SDKCustomTool = {
    description: `读取远程 VPS ${vps.id} 日志。source 为 journal / docker / file。`,
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "journal | docker | file" },
        target: { type: "string", description: "journal 单元名 / docker 容器名 / 文件路径" },
        lines: { type: "number", description: "行数，默认 80，最大 200" },
      },
      required: ["source", "target"],
    },
    async execute(args) {
      const source = str(args, "source").toLowerCase();
      const target = str(args, "target");
      const lines = Math.min(200, Math.max(1, num(args, "lines", 80)));
      let command: string;
      if (source === "journal") {
        if (!/^[a-zA-Z0-9@._-]+$/.test(target)) return toolError("非法 journal 单元名");
        command = `journalctl -u ${target} -n ${lines} --no-pager`;
      } else if (source === "docker") {
        if (!/^[a-zA-Z0-9._-]+$/.test(target)) return toolError("非法容器名");
        command = `docker logs --tail ${lines} ${target}`;
      } else if (source === "file") {
        if (!target.startsWith("/")) return toolError("file 路径必须是绝对路径");
        command = `tail -n ${lines} -- ${JSON.stringify(target)}`;
      } else {
        return toolError("source 只能是 journal / docker / file");
      }
      try {
        const result = await ssh.exec(vps, command);
        audit.write({ userId, vpsId: vps.id, action: "logs", detail: `${source} ${target}`, ok: true });
        return formatExec(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        audit.write({ userId, vpsId: vps.id, action: "logs", detail: `${source} ${target}`, ok: false, error: message });
        return toolError(message);
      }
    },
  };

  const metrics: SDKCustomTool = {
    description: `采集远程 VPS ${vps.id} 的 uptime / 内存 / 磁盘 / 负载。`,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      try {
        const result = await ssh.metrics(vps);
        audit.write({ userId, vpsId: vps.id, action: "metrics", ok: true });
        return formatExec(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        audit.write({ userId, vpsId: vps.id, action: "metrics", ok: false, error: message });
        return toolError(message);
      }
    },
  };

  const verify_repo: SDKCustomTool = {
    description:
      "向 GitHub 校验台账里的仓库名字和链接是否就是要部署的那个仓库。部署前必须先调用。",
    inputSchema: {
      type: "object",
      properties: {
        repoId: { type: "string", description: "已添加仓库的 id" },
      },
    },
    async execute(args) {
      const repoId =
        (typeof args.repoId === "string" && args.repoId.trim()) || lastRepoId || "";
      try {
        const listed = resolveCodeRepo(repoId || undefined);
        if (lastRepoId && listed.id !== lastRepoId) {
          return toolError(
            `不是当前要部署的仓库。用户选的是 ${lastRepoId}，请求的是 ${listed.id}。`,
          );
        }
        const info = await verifyListedRepo(listed);
        const text = formatRepoCheck(listed, info);
        audit.write({ userId, vpsId: vps.id, action: "verify_repo", detail: listed.githubRepo, ok: true });
        return text;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        audit.write({ userId, vpsId: vps.id, action: "verify_repo", ok: false, error: message });
        return toolError(message);
      }
    },
  };

  const deploy_code: SDKCustomTool = {
    description:
      `把已添加仓库的成品代码部署到 VPS ${vps.id}。GitHub 为主，失败用 R2。必须先在 Bot 里添加仓库。`,
    inputSchema: {
      type: "object",
      properties: {
        repoId: { type: "string", description: "已添加仓库的 id" },
      },
    },
    async execute(args) {
      const repoId =
        (typeof args.repoId === "string" && args.repoId.trim()) || lastRepoId || "";
      try {
        const listed = resolveCodeRepo(repoId || undefined);
        if (lastRepoId && listed.id !== lastRepoId) {
          return toolError(`不是当前要部署的仓库。用户选的是 ${lastRepoId}，请求的是 ${listed.id}。`);
        }
        const info = await verifyListedRepo(listed);
        const ok = await confirm.ask(
          chatId,
          `校验通过，确认部署到 ${vps.id}（${vps.name}）？\n\n${formatRepoCheck(listed, info)}`,
        );
        if (!ok) return toolError("用户取消了部署。");
        const text = await deployToVps(ssh, vps, listed.id);
        audit.write({ userId, vpsId: vps.id, action: "deploy_code", detail: listed.githubRepo, ok: true });
        return text;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        audit.write({ userId, vpsId: vps.id, action: "deploy_code", detail: repoId, ok: false, error: message });
        return toolError(message);
      }
    },
  };

  const backup_to_r2: SDKCustomTool = {
    description: "把已添加仓库从 GitHub 备份到 R2。对象名必须对齐便签：projects/{便签}/latest.tar.gz，不另起名称。",
    inputSchema: {
      type: "object",
      properties: {
        repoId: { type: "string", description: "已添加仓库的 id" },
      },
    },
    async execute(args) {
      const repoId =
        (typeof args.repoId === "string" && args.repoId.trim()) || lastRepoId || undefined;
      try {
        const text = await backupRepoToR2(repoId);
        audit.write({ userId, vpsId: vps.id, action: "backup_to_r2", detail: repoId, ok: true });
        return text;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        audit.write({ userId, vpsId: vps.id, action: "backup_to_r2", ok: false, error: message });
        return toolError(message);
      }
    },
  };

  return {
    exec,
    read_file: readFile,
    write_file: writeFile,
    list_dir: listDir,
    service,
    logs,
    metrics,
    verify_repo,
    deploy_code,
    backup_to_r2,
  };
}
