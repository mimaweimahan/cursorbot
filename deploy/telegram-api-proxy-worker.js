/**
 * Cloudflare Worker：把请求原样转到 api.telegram.org
 * 部署后得到 https://<name>.<subdomain>.workers.dev
 * 在 data/runtime.env 写入：
 *   TELEGRAM_API_ROOT=https://<name>.<subdomain>.workers.dev
 */
export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    const target = new URL(request.url);
    target.protocol = "https:";
    target.hostname = "api.telegram.org";
    target.port = "";
    // 保留 path / query（/bot<token>/method）
    const init = {
      method: request.method,
      headers: request.headers,
      redirect: "follow",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      // @ts-expect-error duplex for streaming body
      init.duplex = "half";
    }
    return fetch(new Request(target.toString(), init));
  },
};
