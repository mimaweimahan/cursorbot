const DANGEROUS_CMD = [
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  /\binit\s+[06]\b/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+if=/i,
  /\biptables\b/i,
  /\bnft\s/i,
  /\bufw\b/i,
  /\buserdel\b/i,
  /\bpasswd\b/i,
  /\bchmod\s+(-R\s+)?777\b/i,
  /\bchown\s+-R\s+root\b/i,
  /\bkill\s+-9\s+1\b/i,
  /\b(systemctl|service)\s+(stop|disable|mask)\s+ssh(d)?\b/i,
  /\b(systemctl|service)\s+(restart|reload|stop|start|enable|disable)\b/i,
  /\bnginx\s+-s\s+(reload|stop|quit)/i,
  /\bkill\s+-HUP\b/i,
  /\b(cat|tee)\s+>{1,2}\s*\//i,
  /\bpython3?\s+<</i,
  /\brm\s+[^\n]*-[A-Za-z]*r/,
];

const DANGEROUS_PATH = [
  /^\/etc\/ssh(\/|$)/,
  /sshd_config/,
  /^\/etc\/(passwd|shadow|sudoers)/,
  /^\/boot(\/|$)/,
  /^\/etc\/fstab$/,
  /\/\.ssh\//,
];

export function isDangerousCommand(cmd: string): boolean {
  const stripped = cmd.replace(/\\\n/g, " ").trim();
  return DANGEROUS_CMD.some((re) => re.test(stripped));
}

export function isDangerousPath(filePath: string): boolean {
  return DANGEROUS_PATH.some((re) => re.test(filePath));
}

/** 写这些路径会改生产，必须 Telegram 确认 */
export function needsWriteConfirm(filePath: string): boolean {
  if (isDangerousPath(filePath)) return true;
  if (filePath.startsWith("/etc/")) return true;
  if (/nginx/i.test(filePath)) return true;
  if (/\/(app|core|route|config|public)\//.test(filePath)) return true;
  return false;
}

export function dangerousReason(cmd: string): string {
  if (/\breboot|\bshutdown|\bhalt|\bpoweroff/i.test(cmd)) return "关机/重启";
  if (/rm\s+.*-.*r/i.test(cmd)) return "递归删除";
  if (/\biptables|\bnft\s|\bufw\b/i.test(cmd)) return "防火墙";
  if (/sshd/i.test(cmd)) return "SSH 服务";
  if (/\b(systemctl|service)\s+(restart|reload|stop|start)/i.test(cmd)) return "服务启停";
  if (/nginx\s+-s|kill\s+-HUP/i.test(cmd)) return "重载服务";
  if (/\b(cat|tee)\s+>/i.test(cmd) || /\bpython3?\s+<</i.test(cmd)) return "脚本写文件";
  if (/\bmkfs|\bdd\s+if=/i.test(cmd)) return "磁盘破坏性操作";
  return "高风险命令";
}
