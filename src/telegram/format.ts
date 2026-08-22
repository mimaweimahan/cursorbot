const TG_LIMIT = 3900;

export function clipTelegram(text: string): string {
  if (text.length <= TG_LIMIT) return text;
  return text.slice(0, TG_LIMIT) + `\n…[截断 ${text.length} 字符]`;
}

export function splitTelegram(text: string): string[] {
  if (text.length <= TG_LIMIT) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += TG_LIMIT) {
    chunks.push(text.slice(i, i + TG_LIMIT));
  }
  return chunks;
}

export function hostLine(vps: {
  id: string;
  name: string;
  user: string;
  host: string;
  port: number;
  writable: boolean;
  tags: string[];
  passwordEnc?: string;
  identityFile?: string;
}): string {
  const tags = vps.tags.length ? `  [${vps.tags.join(", ")}]` : "";
  const ro = vps.writable ? "" : "  只读";
  return `${vps.id}  ${vps.name}  ${vps.user}@${vps.host}:${vps.port}${tags}${ro}`;
}
