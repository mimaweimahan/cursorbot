import fs from "node:fs";
import { config } from "./config.ts";

export interface AuditEvent {
  ts: string;
  userId: number;
  vpsId?: string;
  action: string;
  detail?: string;
  ok: boolean;
  error?: string;
}

export class AuditLog {
  write(event: Omit<AuditEvent, "ts">): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    fs.mkdirSync(config.auditPath.replace(/\/[^/]+$/, ""), { recursive: true });
    fs.appendFileSync(config.auditPath, line + "\n");
  }

  /** 读取某用户最近若干条审计（对话跟踪用） */
  recentForUser(userId: number, limit = 12): AuditEvent[] {
    if (!fs.existsSync(config.auditPath)) return [];
    const lines = fs.readFileSync(config.auditPath, "utf8").trim().split("\n").filter(Boolean);
    const picked: AuditEvent[] = [];
    for (let i = lines.length - 1; i >= 0 && picked.length < limit; i--) {
      try {
        const event = JSON.parse(lines[i]!) as AuditEvent;
        if (event.userId === userId) picked.push(event);
      } catch {
        /* skip bad line */
      }
    }
    return picked.reverse();
  }
}
