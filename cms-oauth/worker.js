/**
 * Minimal GitHub OAuth proxy for Decap CMS, deployed as a Cloudflare Worker.
 *
 * Decap's GitHub backend cannot exchange the OAuth code itself because that
 * requires the client secret. This worker does the exchange and hands the
 * token back to the CMS window via postMessage (the protocol Decap expects).
 *
 * Secrets / vars (set with `wrangler secret put`):
 *   GITHUB_CLIENT_ID      OAuth App client id
 *   GITHUB_CLIENT_SECRET  OAuth App client secret
 *   ALLOWED_ORIGINS       optional, comma separated. Defaults to https://clain.org
 */

const html = (body) =>
  new Response(`<!doctype html><meta charset="utf-8"><body>${body}</body>`, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

const randomState = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const clientId = env.GITHUB_CLIENT_ID;
    const clientSecret = env.GITHUB_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return new Response("GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET not configured", { status: 500 });
    }

    // Step 1: Decap opens /auth?provider=github&scope=repo&site_id=...
    if (url.pathname === "/auth") {
      const state = randomState();
      const redirect = new URL("https://github.com/login/oauth/authorize");
      redirect.searchParams.set("client_id", clientId);
      redirect.searchParams.set("redirect_uri", `${url.origin}/callback`);
      redirect.searchParams.set("scope", url.searchParams.get("scope") || "repo,user");
      redirect.searchParams.set("state", state);
      return new Response(null, {
        status: 302,
        headers: {
          location: redirect.toString(),
          "set-cookie": `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        },
      });
    }

    // Step 2: GitHub redirects back with ?code=...&state=...
    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const cookieState = (request.headers.get("cookie") || "").match(/oauth_state=([a-f0-9]+)/)?.[1];
      if (!code || !state || state !== cookieState) {
        return html("<p>Invalid OAuth state. Please close this window and try again.</p>");
      }

      const tokenResp = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "user-agent": "clain-cms-oauth" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      });
      const data = await tokenResp.json();

      const allowed = (env.ALLOWED_ORIGINS || "https://clain.org")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const status = data.access_token ? "success" : "error";
      const payload = data.access_token
        ? { token: data.access_token, provider: "github" }
        : { error: data.error_description || data.error || "unknown error" };
      const message = `authorization:github:${status}:${JSON.stringify(payload)}`;

      // Decap's handshake: the opener says "authorizing:github", we reply with the token.
      return html(`<script>
        (function () {
          var allowed = ${JSON.stringify(allowed)};
          function receive(e) {
            if (allowed.indexOf(e.origin) === -1) return;
            window.opener.postMessage(${JSON.stringify(message)}, e.origin);
            window.removeEventListener("message", receive);
          }
          window.addEventListener("message", receive, false);
          allowed.forEach(function (o) { window.opener && window.opener.postMessage("authorizing:github", o); });
        })();
      </script><p>Signing in… you can close this window if it does not close by itself.</p>`);
    }

    return new Response("Decap CMS OAuth proxy for clain.org", { status: 200 });
  },
};
