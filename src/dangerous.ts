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

export function dangerousReason(cmd: string): string {
  if (/\breboot|\bshutdown|\bhalt|\bpoweroff/i.test(cmd)) return "关机/重启";
  if (/rm\s+.*-.*r/i.test(cmd)) return "递归删除";
  if (/\biptables|\bnft\s|\bufw\b/i.test(cmd)) return "防火墙";
  if (/sshd/i.test(cmd)) return "SSH 服务";
  if (/\bmkfs|\bdd\s+if=/i.test(cmd)) return "磁盘破坏性操作";
  return "高风险命令";
}
