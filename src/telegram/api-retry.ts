import type { Bot } from "grammy";
import { HttpError } from "grammy";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof HttpError) return true;
  const msg = err instanceof Error ? `${err.message} ${err.name}` : String(err);
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network|FetchError|UND_ERR/i.test(
    msg,
  );
}

/**
 * Telegram API 瞬时网络失败时自动重试；连续失败过多则退出进程，交给 systemd Restart。
 */
export function installTelegramApiResilience(bot: Bot, opts?: {
  retries?: number;
  exitAfterConsecutive?: number;
}): void {
  const retries = opts?.retries ?? 3;
  const exitAfter = opts?.exitAfterConsecutive ?? 8;
  let consecutive = 0;

  bot.api.config.use(async (prev, method, payload, signal) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await prev(method, payload, signal);
        consecutive = 0;
        return result;
      } catch (err) {
        lastErr = err;
        if (!isNetworkError(err) || attempt >= retries) break;
        const wait = 400 * (attempt + 1);
        console.warn(
          `telegram ${method} 网络失败，${wait}ms 后重试 (${attempt + 1}/${retries})`,
          err instanceof Error ? err.message : err,
        );
        await sleep(wait);
      }
    }

    consecutive += 1;
    console.error(
      `telegram ${method} 失败（连续网络错误 ${consecutive}/${exitAfter}）`,
      lastErr instanceof Error ? lastErr.message : lastErr,
    );
    if (consecutive >= exitAfter) {
      console.error("Telegram 连续网络失败过多，退出进程以便 systemd 自动重启");
      // 延迟一点，避免同步抛错路径卡住
      setTimeout(() => process.exit(1), 200);
    }
    throw lastErr;
  });
}
