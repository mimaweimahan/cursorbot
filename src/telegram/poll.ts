import type { Bot } from "grammy";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 并发长轮询。grammy 自带 bot.start() 会 await 每条 update，
 * 等用户点「同意执行」时整条 getUpdates 被堵住，按钮点了也不会动。
 */
export async function startConcurrentPolling(
  bot: Bot,
  onStart?: (info: { username?: string }) => void,
): Promise<() => Promise<void>> {
  await bot.init();
  await bot.api.deleteWebhook({ drop_pending_updates: false });
  onStart?.(bot.botInfo);

  let offset = 0;
  let running = true;
  const ac = new AbortController();

  const loop = (async () => {
    while (running) {
      try {
        const updates = await bot.api.getUpdates(
          { offset, timeout: 30 },
          ac.signal as never,
        );
        for (const update of updates) {
          offset = update.update_id + 1;
          void bot.handleUpdate(update).catch((err) => {
            console.error("bot error", err);
          });
        }
      } catch (err) {
        if (!running || ac.signal.aborted) break;
        console.error("getUpdates fail", err);
        await sleep(2000);
      }
    }
  })();

  return async () => {
    running = false;
    ac.abort();
    try {
      await bot.api.getUpdates({ offset, timeout: 0, limit: 1 });
    } catch {
      /* ignore */
    }
    await Promise.race([loop, sleep(1500)]);
  };
}
