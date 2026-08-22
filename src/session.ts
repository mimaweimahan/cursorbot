import fs from "node:fs";
import { config } from "./config.ts";
import type { UserSession } from "./types.ts";

function empty(): UserSession {
  return { currentVpsId: null, lastRepoId: null, agents: {} };
}

export class SessionStore {
  private data = new Map<number, UserSession>();

  constructor() {
    this.load();
  }

  get(userId: number): UserSession {
    const existing = this.data.get(userId);
    if (existing) return existing;
    const created = empty();
    this.data.set(userId, created);
    return created;
  }

  setCurrent(userId: number, vpsId: string | null): UserSession {
    const session = this.get(userId);
    session.currentVpsId = vpsId;
    this.save();
    return session;
  }

  setLastRepo(userId: number, repoId: string | null): UserSession {
    const session = this.get(userId);
    session.lastRepoId = repoId;
    this.save();
    return session;
  }

  setAgent(userId: number, vpsId: string, agentId: string): void {
    const session = this.get(userId);
    session.agents[vpsId] = agentId;
    this.save();
  }

  clearAgent(userId: number, vpsId: string): void {
    const session = this.get(userId);
    delete session.agents[vpsId];
    this.save();
  }

  private load(): void {
    if (!fs.existsSync(config.sessionsPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(config.sessionsPath, "utf8")) as Record<
        string,
        UserSession
      >;
      for (const [id, session] of Object.entries(raw)) {
        this.data.set(Number(id), {
          currentVpsId: session.currentVpsId ?? null,
          lastRepoId: session.lastRepoId ?? null,
          agents: session.agents ?? {},
        });
      }
    } catch (err) {
      console.error("读取 sessions.json 失败，将用空会话", err);
    }
  }

  private save(): void {
    const obj: Record<string, UserSession> = {};
    for (const [id, session] of this.data) {
      obj[String(id)] = session;
    }
    fs.mkdirSync(config.sessionsPath.replace(/\/[^/]+$/, ""), { recursive: true });
    fs.writeFileSync(config.sessionsPath, JSON.stringify(obj, null, 2));
  }
}
