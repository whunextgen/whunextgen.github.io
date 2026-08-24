// ../pages-worker.ts
var apiOrigin = "https://finance-feishu-worker.clain-finance.workers.dev";
var pages_worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const target = new URL(url.pathname + url.search, apiOrigin);
      return fetch(new Request(target, request));
    }
    return env.ASSETS.fetch(request);
  }
};
export {
  pages_worker_default as default
};
