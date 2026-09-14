# CMS OAuth worker

Decap CMS (served at <https://clain.org/admin/>) signs editors in with their
GitHub account. GitHub's OAuth flow needs a server-side secret, so this tiny
Cloudflare Worker does the token exchange. One-time setup:

1. **Create a GitHub OAuth App** (Settings → Developer settings → OAuth Apps → New)
   under the `whunextgen` organisation:
   - Homepage URL: `https://clain.org`
   - Authorization callback URL: `https://clain-cms-oauth.<account>.workers.dev/callback`
   Copy the *Client ID* and generate a *Client secret*.
2. **Deploy the worker** from this directory:
   ```bash
   npx wrangler login
   npx wrangler deploy
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   ```
3. **Point the CMS at it**: in `public/admin/config.yml` set `backend.base_url`
   to the worker URL printed by `wrangler deploy` (no trailing slash).
4. Every editor needs **write access to the repository**. Add them as
   collaborators or to a team with *Write* permission.

Optional: set `ALLOWED_ORIGINS` in `wrangler.toml` if the site is served from
another domain.
