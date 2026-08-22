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
}
