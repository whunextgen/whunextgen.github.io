// ../pages-worker.ts
var apiOrigin = "https://finance-feishu-worker.clain-finance.workers.dev";
var pages_worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return new Response(JSON.stringify({ ok: true, service: "finance-pages-proxy", timestamp: (/* @__PURE__ */ new Date()).toISOString() }), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
      });
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/portal/api/")) {
      const apiPath = url.pathname.startsWith("/portal/api/") ? url.pathname.slice("/portal".length) : url.pathname;
      const target = new URL(apiPath + url.search, apiOrigin);
      return fetch(new Request(target, request));
    }
    return env.ASSETS.fetch(request);
  }
};
export {
  pages_worker_default as default
};
