/** Cursor API Key 池：环形故障切换 + 分类型冷却，避免长跑进程卡在最后一把 key。 */

export type KeyFailKind = "auth" | "usage" | "other";

const AUTH_COOLDOWN_MS = 2 * 60 * 1000;
const USAGE_COOLDOWN_MS = 45 * 60 * 1000;
const OTHER_COOLDOWN_MS = 5 * 60 * 1000;

export function classifyKeyFail(msg: string): KeyFailKind {
  if (
    /out of usage|usage limit|increase (your )?limit|insufficient.?credits|quota.?exceeded|billing|spend.?limit|no (remaining )?credits/i.test(
      msg,
    )
  ) {
    return "usage";
  }
  if (
    /auth|401|403|unauthorized|forbidden|invalid.?api.?key|api.?key.*(invalid|expired|revoked|missing)|authentication/i.test(
      msg,
    )
  ) {
    return "auth";
  }
  return "other";
}

function cooldownMs(kind: KeyFailKind): number {
  if (kind === "usage") return USAGE_COOLDOWN_MS;
  if (kind === "auth") return AUTH_COOLDOWN_MS;
  return OTHER_COOLDOWN_MS;
}

export class CursorApiKeyPool {
  private index = 0;
  private cooldownUntil: number[];
  private readonly keys: readonly string[];

  constructor(keys: readonly string[]) {
    this.keys = keys;
    this.cooldownUntil = keys.map(() => 0);
  }

  get size(): number {
    return this.keys.length;
  }

  get currentIndex(): number {
    return this.index;
  }

  current(): string {
    if (this.keys.length === 0) return "";
    return this.keys[this.index] || this.keys[0] || "";
  }

  /**
   * 标记当前 key 失败并切到下一把可用 key（环形，跳过本轮已试与冷却中）。
   * 成功切换返回 true；本轮已无其他可试 key 返回 false。
   */
  markFailedAndRotate(reason: unknown, triedInRequest?: Set<number>): boolean {
    if (this.keys.length === 0) return false;
    const msg = reason instanceof Error ? reason.message : String(reason);
    const kind = classifyKeyFail(msg);
    const cool = cooldownMs(kind);
    const now = Date.now();
    this.cooldownUntil[this.index] = now + cool;
    triedInRequest?.add(this.index);

    const next = this.pickNext(now, triedInRequest);
    if (next === null) {
      console.warn(
        `Cursor API keys 本轮全部不可用，停在 #${this.index}（共 ${this.keys.length}）: ${msg.slice(0, 160)}`,
      );
      return false;
    }
    const prev = this.index;
    this.index = next;
    console.warn(
      `Cursor API key #${prev}→#${next}（共 ${this.keys.length}，${kind} 冷却 ${Math.round(cool / 1000)}s）: ${msg.slice(0, 160)}`,
    );
    return true;
  }

  /**
   * 当前 key 成功：清除其冷却；若主 key(#0) 已过冷却则切回主 key。
   * @returns 是否切换了下标（调用方须丢弃全部 Agent 句柄）
   */
  noteSuccess(): boolean {
    if (this.keys.length === 0) return false;
    this.cooldownUntil[this.index] = 0;
    if (this.index === 0) return false;
    if (this.cooldownUntil[0] > Date.now()) return false;
    const prev = this.index;
    this.index = 0;
    console.log(`Cursor API key 成功于 #${prev}，已切回优先 #0`);
    return true;
  }

  private pickNext(now: number, tried?: Set<number>): number | null {
    const n = this.keys.length;
    if (n <= 1) return null;

    // 1) 未试过且未冷却
    for (let step = 1; step < n; step++) {
      const i = (this.index + step) % n;
      if (tried?.has(i)) continue;
      if (this.cooldownUntil[i] > now) continue;
      return i;
    }

    // 2) 未试过但在冷却：仍切过去试（冷却可能误判；避免整轮直接放弃）
    for (let step = 1; step < n; step++) {
      const i = (this.index + step) % n;
      if (tried?.has(i)) continue;
      return i;
    }

    return null;
  }
}
