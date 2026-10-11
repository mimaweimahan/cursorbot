/**
 * 固化「发域名 → 配前端 → 不要 SSL」简流程到 knowledge.sqlite
 */
import { bootstrapKnowledge } from "../src/knowledge/bootstrap.ts";
import { savePlaybookRecord, setFact, getFact } from "../src/knowledge/store.ts";

const VPS = "vps-5";

await bootstrapKnowledge();

const factExtra = [
  "- 门户前端 root：与已有 ensgea* 站相同（常见 `/www/wwwroot/www.sgeapex.com`；以模板 conf 的 root 为准）",
  "- 新域名默认：只复制已有前端 Nginx，不签本机证书（证书在 Cloudflare）",
].join("\n");

const old = getFact(VPS, "环境速查") || "";
if (!old.includes("新域名默认")) {
  setFact(VPS, "环境速查", `${old.trim()}\n${factExtra}\n`);
}

await savePlaybookRecord({
  vpsId: VPS,
  title: "新域名配到前端（不要SSL）",
  problem:
    "用户发一个或多个已解析域名，要求配置到前端；证书在云端/Cloudflare，本机不要 SSL",
  steps: [
    "1. read_file 一台已有前端站模板（优先同系列，如 www.ensgeaf.com.conf），记下 root / rewrite / extension。",
    "2. 每个新域名只写 3 个文件：vhost/nginx/{domain}.conf、rewrite/{domain}.conf、extension/{domain}/site_total.conf；内容=模板拷贝，仅改 server_name。",
    "3. root 必须与模板一致，指向现有前端目录；不要新建站点目录、不要部署代码。",
    "4. exec: /www/server/nginx/sbin/nginx -t ；通过后 service reload nginx 一次。",
    "5. 用中文简短汇报：域名列表、root、已 reload。结束。",
    "",
    "禁止：openssl 自签、acme、certbot、翻 panel 源码、python/heredoc、反复 curl/dig、同一路径重复 write_file。",
    "用户取消某路径后：本轮不再写该路径。",
  ].join("\n"),
  tags: ["域名", "前端", "nginx", "ssl"],
  source: "manual",
});

// 路径速查也标明：默认不碰证书
await savePlaybookRecord({
  vpsId: VPS,
  title: "宝塔/Nginx 路径速查",
  problem: "找站点配置、证书、访问日志",
  steps: [
    "Nginx: /www/server/nginx/sbin/nginx",
    "vhost: /www/server/panel/vhost/nginx/{domain}.conf",
    "rewrite: /www/server/panel/vhost/rewrite/{domain}.conf",
    "extension: /www/server/panel/vhost/nginx/extension/{domain}/",
    "证书目录(仅查阅): /www/server/panel/vhost/cert/{domain}/",
    "日志: /www/wwwlogs/{domain}.*",
    "",
    "注意：用户说证书在云端/Cloudflare/不要SSL时，只配 HTTP 或复制模板 listen，禁止申请/自签证书。",
    "新域名配前端请走 playbook「新域名配到前端（不要SSL）」。",
  ].join("\n"),
  tags: ["nginx", "bt", "paths", "证书"],
  source: "manual",
});

console.log("seed ok");
