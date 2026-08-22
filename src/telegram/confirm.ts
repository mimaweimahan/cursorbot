import { randomBytes } from "node:crypto";
import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "../config.ts";

interface Pending {
  resolve: (ok: boolean) => void;
  chatId: number;
  messageId: number;
  timer: NodeJS.Timeout;
}

export class ConfirmBroker {
  private api: Api | undefined;
  private pending = new Map<string, Pending>();

  setApi(api: Api): void {
    this.api = api;
  }

  async ask(chatId: number, summary: string): Promise<boolean> {
    if (!this.api) throw new Error("ConfirmBroker 未绑定 Telegram API");
    const id = randomBytes(4).toString("hex");
    const keyboard = new InlineKeyboard()
      .text("确认执行", `cf:${id}:1`)
      .text("取消", `cf:${id}:0`);
    const msg = await this.api.sendMessage(
      chatId,
      `${summary}\n\n请在 ${Math.round(config.confirmTimeoutMs / 1000)} 秒内确认。超时视为取消。`,
      { reply_markup: keyboard },
    );

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(false);
        void this.api
          ?.editMessageText(chatId, msg.message_id, `${summary}\n\n已超时，已取消。`)
          .catch(() => undefined);
      }, config.confirmTimeoutMs);
      this.pending.set(id, {
        resolve,
        chatId,
        messageId: msg.message_id,
        timer,
      });
    });
  }

  async handle(id: string, ok: boolean): Promise<boolean> {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(ok);
    const suffix = ok ? "已确认，继续执行。" : "已取消。";
    await this.api
      ?.editMessageText(pending.chatId, pending.messageId, suffix)
      .catch(() => undefined);
    return true;
  }
}
