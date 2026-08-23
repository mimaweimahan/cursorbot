import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Agent, CursorAgentError } from "@cursor/sdk";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: path.join(root, ".env"), override: true });

const apiKey = process.env.CURSOR_API_KEY?.trim();
if (!apiKey) {
  console.error("没有 CURSOR_API_KEY。先写在 /root/telegrambot/.env");
  process.exit(1);
}

const cwd = process.cwd();
const model = process.env.CURSOR_MODEL?.trim() || "composer-2.5";

const agent = await Agent.create({
  apiKey,
  model: { id: model },
  local: { cwd },
});

console.log(`本机 Cursor 对话已接通  model=${model}  cwd=${cwd}`);
console.log("直接打字回车。空行或 /exit 退出。\n");

const rl = createInterface({ input: stdin, output: stdout });

try {
  while (true) {
    const text = (await rl.question("你> ")).trim();
    if (!text || text === "/exit" || text === "/quit") break;
    try {
      const run = await agent.send(text);
      process.stdout.write("Cursor> ");
      for await (const event of run.stream()) {
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "text") process.stdout.write(block.text);
          }
        } else if (event.type === "tool_call" && event.status === "running") {
          process.stdout.write(`\n[${event.name}] `);
        }
      }
      await run.wait();
      process.stdout.write("\n\n");
    } catch (err) {
      const message =
        err instanceof CursorAgentError
          ? `Cursor Agent 失败: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      console.error(message);
    }
  }
} finally {
  rl.close();
  agent.close();
}
