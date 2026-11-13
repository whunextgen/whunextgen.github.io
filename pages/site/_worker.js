// 国内访问入口。workers.dev 在国内不稳定，pages.dev 可以打开，所以这里只做一件事：
// 把请求原样交给同一账户下的接口 Worker（服务绑定，走 Cloudflare 内部，不经过 workers.dev）。
// 请求的地址不改，Worker 看到的仍是本站地址，登录回调、来源校验和 Cookie 都按本站算。
export default {
  fetch(request, env) {
    return env.API.fetch(request);
  },
};
