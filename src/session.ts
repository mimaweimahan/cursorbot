import { getDb } from "./db.ts";
import type { UserSession } from "./types.ts";

function empty(): UserSession {
  return { currentVpsId: null, lastRepoId: null, chatOn: true, agents: {} };
}

interface SessionRow {
  user_id: number;
  current_vps_id: string | null;
  last_repo_id: string | null;
  chat_on: number;
  agents_json: string;
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

  setChatOn(userId: number, on: boolean): UserSession {
    const session = this.get(userId);
    session.chatOn = on;
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
    const rows = getDb().prepare("SELECT * FROM sessions").all() as unknown as SessionRow[];
    for (const row of rows) {
      this.data.set(Number(row.user_id), {
        currentVpsId: row.current_vps_id ?? null,
        lastRepoId: row.last_repo_id ?? null,
        chatOn: row.chat_on !== 0,
        agents: JSON.parse(row.agents_json || "{}") as Record<string, string>,
      });
    }
  }

  private save(): void {
    const stmt = getDb().prepare(
      `INSERT INTO sessions (user_id, current_vps_id, last_repo_id, chat_on, agents_json)
       VALUES (?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET
         current_vps_id=excluded.current_vps_id,
         last_repo_id=excluded.last_repo_id,
         chat_on=excluded.chat_on,
         agents_json=excluded.agents_json`,
    );
    for (const [id, session] of this.data) {
      stmt.run(
        id,
        session.currentVpsId,
        session.lastRepoId,
        session.chatOn ? 1 : 0,
        JSON.stringify(session.agents),
      );
    }
  }
}
