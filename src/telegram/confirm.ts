import { randomBytes } from "node:crypto";
import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "../config.ts";

export type ConfirmPhase = "waiting" | "confirmed" | "rejected" | "timeout";

export interface ConfirmEvent {
  userId: number;
  chatId: number;
  phase: ConfirmPhase;
  summary: string;
  remainSec: number;
}

interface Pending {
  resolve: (ok: boolean) => void;
  userId: number;
  chatId: number;
  messageId: number;
  summary: string;
  deadline: number;
  timer: NodeJS.Timeout;
}

type Listener = (ev: ConfirmEvent) => void;

export class ConfirmBroker {
  private api: Api | undefined;
  private pending = new Map<string, Pending>();
  private listeners: Listener[] = [];

  setApi(api: Api): void {
    this.api = api;
  }

  subscribe(listener: Listener): void {
    this.listeners.push(listener);
  }

  peek(id: string): boolean {
    return this.pending.has(id);
  }

  hasPending(userId: number): boolean {
    for (const item of this.pending.values()) {
      if (item.userId === userId) return true;
    }
    return false;
  }

  pendingSummary(userId: number): string | undefined {
    for (const item of this.pending.values()) {
      if (item.userId === userId) return item.summary;
    }
    return undefined;
  }

  remainSec(userId: number): number {
    for (const item of this.pending.values()) {
      if (item.userId === userId) {
        return Math.max(0, Math.ceil((item.deadline - Date.now()) / 1000));
      }
    }
    return 0;
  }

  async ask(chatId: number, summary: string, opts: { userId: number }): Promise<boolean> {
    if (!this.api) throw new Error("ConfirmBroker 未绑定 Telegram API");
    this.rejectAll(opts.userId, "被新的确认请求替换");

    const id = randomBytes(4).toString("hex");
    const timeoutMs = config.confirmTimeoutMs;
    const keyboard = new InlineKeyboard()
      .text("同意执行", `cf:${id}:1`)
      .text("拒绝", `cf:${id}:0`);
    const msg = await this.api.sendMessage(
      chatId,
      `${summary}\n\n请在 ${Math.round(timeoutMs / 1000)} 秒内点「同意执行」或「拒绝」。超时视为拒绝。`,
      { reply_markup: keyboard },
    );

    const deadline = Date.now() + timeoutMs;
    this.emit({
      userId: opts.userId,
      chatId,
      phase: "waiting",
      summary,
      remainSec: Math.round(timeoutMs / 1000),
    });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const current = this.pending.get(id);
        if (!current) return;
        this.pending.delete(id);
        resolve(false);
        this.emit({
          userId: opts.userId,
          chatId,
          phase: "timeout",
          summary,
          remainSec: 0,
        });
        void this.edit(
          chatId,
          msg.message_id,
          `${summary}\n\n⏱ 已超时，未执行。`,
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        userId: opts.userId,
        chatId,
        messageId: msg.message_id,
        summary,
        deadline,
        timer,
      });
    });
  }

  /** 先由 callback 立刻 answerCallbackQuery，再调用本方法。不要在 answer 之前 await 网络。 */
  handle(id: string, ok: boolean): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(ok);
    console.log(`confirm ${ok ? "accepted" : "rejected"} user=${pending.userId} chat=${pending.chatId}`);
    this.emit({
      userId: pending.userId,
      chatId: pending.chatId,
      phase: ok ? "confirmed" : "rejected",
      summary: pending.summary,
      remainSec: 0,
    });
    const suffix = ok ? "✅ 已同意，正在执行。" : "🚫 已拒绝，不会执行这条命令。";
    void this.edit(pending.chatId, pending.messageId, `${pending.summary}\n\n${suffix}`);
    return true;
  }

  rejectAll(userId: number, reason = "已取消"): number {
    let n = 0;
    for (const [id, pending] of [...this.pending.entries()]) {
      if (pending.userId !== userId) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve(false);
      n += 1;
      this.emit({
        userId,
        chatId: pending.chatId,
        phase: "rejected",
        summary: pending.summary,
        remainSec: 0,
      });
      void this.edit(
        pending.chatId,
        pending.messageId,
        `${pending.summary}\n\n🚫 ${reason}`,
      );
    }
    return n;
  }

  private emit(ev: ConfirmEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(ev);
      } catch (err) {
        console.error("confirm listener", err);
      }
    }
  }

  private async edit(chatId: number, messageId: number, text: string): Promise<void> {
    await this.api
      ?.editMessageText(chatId, messageId, text, {
        reply_markup: { inline_keyboard: [] },
      })
      .catch(() => undefined);
  }
}
