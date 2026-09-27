import fs from "node:fs";
import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { config } from "../config.ts";
import { decryptSecret } from "../crypto.ts";
import type { ExecResult, VpsHost } from "../types.ts";

const METRICS_SCRIPT = [
  "echo HOST=$(hostname 2>/dev/null || echo unknown)",
  "echo USER=$(whoami 2>/dev/null)",
  'echo UPTIME="$(uptime)"',
  "echo ----- memory -----",
  "free -h 2>/dev/null || true",
  "echo ----- disk -----",
  "df -hT -x tmpfs -x devtmpfs 2>/dev/null || df -h",
  "echo ----- load -----",
  "cat /proc/loadavg 2>/dev/null || true",
].join("\n");

interface Pooled {
  client: Client;
  ready: Promise<Client>;
}

/** 连接失败后的熔断：避免 Agent 连续打 SSH 把对话拖成数分钟 */
interface Unreachable {
  until: number;
  reason: string;
}

const UNREACHABLE_COOLDOWN_MS = 90_000;

export class SshPool {
  private pool = new Map<string, Pooled>();
  private unreachable = new Map<string, Unreachable>();

  /** 进入 VPS 时探测；成功则清除熔断 */
  async probe(vps: VpsHost): Promise<{ ok: true } | { ok: false; error: string }> {
    this.clearUnreachable(vps.id);
    try {
      await this.connect(vps);
      const r = await execOn(await this.connect(vps), "echo ok", 8_000);
      if (r.timedOut || (r.code !== 0 && r.code !== null)) {
        const err = `探测失败 code=${r.code} ${r.stderr || r.stdout}`.trim();
        this.markUnreachable(vps.id, err);
        return { ok: false, error: err };
      }
      return { ok: true };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.markUnreachable(vps.id, error);
      this.drop(vps.id);
      return { ok: false, error };
    }
  }

  clearUnreachable(vpsId: string): void {
    this.unreachable.delete(vpsId);
  }

  getUnreachable(vpsId: string): string | null {
    const u = this.unreachable.get(vpsId);
    if (!u) return null;
    if (Date.now() > u.until) {
      this.unreachable.delete(vpsId);
      return null;
    }
    return u.reason;
  }

  private markUnreachable(vpsId: string, reason: string): void {
    this.unreachable.set(vpsId, {
      until: Date.now() + UNREACHABLE_COOLDOWN_MS,
      reason,
    });
  }

  private assertReachable(vps: VpsHost): void {
    const reason = this.getUnreachable(vps.id);
    if (reason) {
      throw new Error(
        `SSH 熔断中（${vps.id}）：${reason}。约 90s 内勿再重试远程工具，请直接告知用户机器不可达。`,
      );
    }
  }

  private noteConnectFailure(vpsId: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (/超时|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|Timed out|connect/i.test(msg)) {
      this.markUnreachable(vpsId, msg);
    }
  }

  async exec(vps: VpsHost, command: string, timeoutMs = config.cmdTimeoutMs): Promise<ExecResult> {
    this.assertReachable(vps);
    try {
      return await execOn(await this.connect(vps), command, timeoutMs);
    } catch (err) {
      this.drop(vps.id);
      this.noteConnectFailure(vps.id, err);
      // 连接超时/拒绝：不再二次重连（会把等待翻倍）
      if (isConnectFatal(err)) throw err;
      this.assertReachable(vps);
      try {
        return await execOn(await this.connect(vps), command, timeoutMs);
      } catch (err2) {
        this.noteConnectFailure(vps.id, err2);
        throw err2;
      }
    }
  }

  async metrics(vps: VpsHost): Promise<ExecResult> {
    return this.exec(vps, METRICS_SCRIPT, Math.min(config.cmdTimeoutMs, 15_000));
  }

  async readFile(vps: VpsHost, remotePath: string): Promise<Buffer> {
    this.assertReachable(vps);
    try {
      const sftp = await this.sftp(vps);
      const stat = await statPath(sftp, remotePath);
      if (stat.isDirectory) {
        throw new Error(`${remotePath} 是目录，请用 list_dir`);
      }
      if (stat.size > config.readFileMaxBytes) {
        throw new Error(
          `文件 ${remotePath} 大小 ${stat.size} 超过上限 ${config.readFileMaxBytes} 字节`,
        );
      }
      return readRemote(sftp, remotePath);
    } catch (err) {
      this.noteConnectFailure(vps.id, err);
      throw err;
    }
  }

  async writeFile(vps: VpsHost, remotePath: string, content: string): Promise<void> {
    this.assertReachable(vps);
    try {
      const sftp = await this.sftp(vps);
      await writeRemote(sftp, remotePath, Buffer.from(content, "utf8"));
    } catch (err) {
      this.noteConnectFailure(vps.id, err);
      throw err;
    }
  }

  async writeBuffer(vps: VpsHost, remotePath: string, data: Buffer): Promise<void> {
    this.assertReachable(vps);
    try {
      const sftp = await this.sftp(vps);
      await writeRemote(sftp, remotePath, data);
    } catch (err) {
      this.noteConnectFailure(vps.id, err);
      throw err;
    }
  }

  async listDir(vps: VpsHost, remotePath: string): Promise<string> {
    this.assertReachable(vps);
    try {
      const sftp = await this.sftp(vps);
      const entries = await readdir(sftp, remotePath);
      if (entries.length === 0) return "(空目录)";
      const lines = entries
        .sort((a, b) => a.filename.localeCompare(b.filename))
        .map((e) => {
          const kind = e.longname.startsWith("d") ? "dir " : "file";
          return `${kind}\t${e.attrs.size}\t${e.filename}`;
        });
      return lines.join("\n");
    } catch (err) {
      this.noteConnectFailure(vps.id, err);
      throw err;
    }
  }

  drop(vpsId: string): void {
    const pooled = this.pool.get(vpsId);
    if (!pooled) return;
    this.pool.delete(vpsId);
    try {
      pooled.client.end();
    } catch {
      /* ignore */
    }
  }

  closeAll(): void {
    for (const id of [...this.pool.keys()]) this.drop(id);
  }

  private async sftp(vps: VpsHost): Promise<SFTPWrapper> {
    const client = await this.connect(vps);
    return openSftp(client);
  }

  private async connect(vps: VpsHost): Promise<Client> {
    this.assertReachable(vps);
    const existing = this.pool.get(vps.id);
    if (existing) {
      try {
        return await existing.ready;
      } catch (err) {
        this.drop(vps.id);
        this.noteConnectFailure(vps.id, err);
        throw err;
      }
    }

    const auth = authFields(vps);
    const client = new Client();
    const ready = new Promise<Client>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error(`SSH 连接超时 ${vps.user}@${vps.host}:${vps.port}`));
      }, config.sshTimeoutMs);

      client.once("ready", () => {
        clearTimeout(timer);
        resolve(client);
      });
      client.once("error", (err) => {
        clearTimeout(timer);
        this.drop(vps.id);
        reject(err);
      });
      client.once("close", () => {
        this.pool.delete(vps.id);
      });
      if (auth.password) {
        client.on("keyboard-interactive", (_n, _i, _l, prompts, finish) => {
          finish(prompts.map(() => auth.password as string));
        });
      }

      client.connect({
        host: vps.host,
        port: vps.port,
        username: vps.user,
        ...auth,
        tryKeyboard: Boolean(auth.password),
        readyTimeout: config.sshTimeoutMs,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
      });
    });

    this.pool.set(vps.id, { client, ready });
    try {
      return await ready;
    } catch (err) {
      this.noteConnectFailure(vps.id, err);
      throw err;
    }
  }
}

function isConnectFatal(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /SSH 连接超时|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|熔断/i.test(msg);
}

function authFields(vps: VpsHost): Pick<ConnectConfig, "password" | "privateKey"> {
  if (vps.passwordEnc) {
    return { password: decryptSecret(vps.passwordEnc) };
  }
  if (!vps.identityFile) {
    throw new Error(`${vps.id} 既没有加密密码也没有私钥`);
  }
  if (!fs.existsSync(vps.identityFile)) {
    throw new Error(`找不到私钥 ${vps.identityFile}`);
  }
  const mode = fs.statSync(vps.identityFile).mode & 0o777;
  if (mode & 0o077) {
    console.warn(`私钥 ${vps.identityFile} 权限 ${mode.toString(8)} 过宽，建议 chmod 600`);
  }
  return { privateKey: fs.readFileSync(vps.identityFile) };
}

function execOn(client: Client, command: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        stream.signal("TERM");
        setTimeout(() => stream.destroy(), 1500);
      }, timeoutMs);

      stream.on("data", (chunk: Buffer) => stdout.push(chunk));
      stream.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      stream.on("close", (code: number | null) => {
        clearTimeout(timer);
        const out = Buffer.concat(stdout).toString("utf8");
        const errText = Buffer.concat(stderr).toString("utf8");
        const { text: stdoutText, truncated: t1 } = clip(out, config.cmdMaxOutput);
        const { text: stderrText, truncated: t2 } = clip(errText, config.cmdMaxOutput);
        resolve({
          stdout: stdoutText,
          stderr: stderrText,
          code: code ?? null,
          truncated: t1 || t2,
          timedOut,
        });
      });
      stream.on("error", (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  });
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: text.slice(0, max) + `\n...[截断，共 ${text.length} 字符]`,
    truncated: true,
  };
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) reject(err);
      else resolve(sftp);
    });
  });
}

function statPath(
  sftp: SFTPWrapper,
  remotePath: string,
): Promise<{ size: number; isDirectory: boolean }> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, stats) => {
      if (err) reject(err);
      else resolve({ size: stats.size, isDirectory: stats.isDirectory() });
    });
  });
}

function readRemote(sftp: SFTPWrapper, remotePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = sftp.createReadStream(remotePath);
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function writeRemote(sftp: SFTPWrapper, remotePath: string, content: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(remotePath);
    stream.on("close", () => resolve());
    stream.on("error", reject);
    stream.end(content);
  });
}

function readdir(
  sftp: SFTPWrapper,
  remotePath: string,
): Promise<Array<{ filename: string; longname: string; attrs: { size: number } }>> {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (err, list) => {
      if (err) reject(err);
      else resolve(list);
    });
  });
}

export function formatExec(result: ExecResult): string {
  const parts = [
    `exit=${result.code ?? "?"}${result.timedOut ? " timed_out" : ""}`,
    result.stdout ? `stdout:\n${result.stdout}` : "stdout: (empty)",
  ];
  if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
  if (result.truncated) parts.push("(output truncated)");
  return parts.join("\n");
}
