import type { SDKCustomTool } from "@cursor/sdk";
import type { AuditLog } from "../audit.ts";
import { statusText } from "../codehub.ts";
import { backupRepoToR2 } from "../deploy.ts";
import { formatRepoCheck, verifyListedRepo } from "../github.ts";
import { loadInventory } from "../inventory.ts";
import { findRepo, loadRepos, repoLine } from "../repos.ts";
import { hostLine } from "../telegram/format.ts";

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function buildLocalTools(deps: { userId: number; audit: AuditLog }): Record<string, SDKCustomTool> {
  const { userId, audit } = deps;

  const list_vps: SDKCustomTool = {
    description: "列出 Bot 台账里的 VPS。要操作某台机器，请让用户先「进入VPS」。",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      const hosts = loadInventory();
      const text = hosts.length
        ? hosts.map((h) => `• ${hostLine(h)}`).join("\n")
        : "还没有 VPS。";
      audit.write({ userId, vpsId: "local", action: "list_vps", ok: true });
      return text;
    },
  };

  const list_repos: SDKCustomTool = {
    description: "列出已添加的代码仓库（只显示便签名）。",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      const repos = loadRepos();
      const text = repos.length
        ? repos.map((r) => `• ${repoLine(r)}`).join("\n")
        : "还没有仓库。";
      audit.write({ userId, vpsId: "local", action: "list_repos", ok: true });
      return text;
    },
  };

  const hub_status: SDKCustomTool = {
    description: "查看 GitHub token / R2 是否已配置。",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return statusText();
    },
  };

  const verify_repo: SDKCustomTool = {
    description: "按便签或仓库 id 向 GitHub 校验台账里的仓库。",
    inputSchema: {
      type: "object",
      properties: { repoId: { type: "string", description: "便签或仓库 id" } },
      required: ["repoId"],
    },
    async execute(args) {
      const repoId = typeof args.repoId === "string" ? args.repoId.trim() : "";
      const listed = findRepo(repoId);
      if (!listed) return toolError(`没有仓库 ${repoId}`);
      try {
        const info = await verifyListedRepo(listed);
        audit.write({ userId, vpsId: "local", action: "verify_repo", detail: listed.name, ok: true });
        return formatRepoCheck(listed, info);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(message);
      }
    },
  };

  const backup_to_r2: SDKCustomTool = {
    description: "把指定便签的 GitHub 仓库备份到 R2。对象名必须对齐：projects/{便签}/latest.tar.gz，不另起名称。",
    inputSchema: {
      type: "object",
      properties: { repoId: { type: "string", description: "便签或仓库 id" } },
      required: ["repoId"],
    },
    async execute(args) {
      const repoId = typeof args.repoId === "string" ? args.repoId.trim() : "";
      const listed = findRepo(repoId);
      if (!listed) return toolError(`没有仓库 ${repoId}`);
      try {
        const text = await backupRepoToR2(listed.id);
        audit.write({ userId, vpsId: "local", action: "backup_to_r2", detail: listed.name, ok: true });
        return text;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        audit.write({ userId, vpsId: "local", action: "backup_to_r2", ok: false, error: message });
        return toolError(message);
      }
    },
  };

  return { list_vps, list_repos, hub_status, verify_repo, backup_to_r2 };
}
