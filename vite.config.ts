import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { load, CORE_SCHEMA } from "js-yaml";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// CORE_SCHEMA keeps dates as plain strings (YYYY-MM-DD) instead of Date objects.
const loadYaml = (text: string) => load(text, { schema: CORE_SCHEMA });
import { marked } from "marked";

/**
 * Turns the files under /content (written by Decap CMS) into JS modules at
 * build time, so the site ships plain JSON and needs no YAML/Markdown parser
 * in the browser.
 *   - *.yml / *.yaml  -> export default <parsed object>
 *   - *.md            -> export default { ...frontmatter, body: <html> }
 */
/** Lab members as [displayName, slug] pairs, longest names first. */
const loadPeopleNames = (): Array<[string, string]> => {
  const dir = join(process.cwd(), "content", "people");
  const out: Array<[string, string]> = [];
  for (const f of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const slug = f.replace(/\.ya?ml$/, "");
    const p = (loadYaml(readFileSync(join(dir, f), "utf8")) ?? {}) as Record<string, string>;
    const variants = [p.name, p.nameZh];
    // Also accept "Family Given" order for two-part Latin names (e.g. "Xie Qianqian").
    const parts = (p.name || "").trim().split(/\s+/);
    if (parts.length === 2 && /^[A-Za-z]/.test(p.name)) variants.push(`${parts[1]} ${parts[0]}`);
    for (const n of variants) {
      if (n && n.trim().length >= 2 && !out.some(([x]) => x === n.trim())) out.push([n.trim(), slug]);
    }
  }
  return out.sort((a, b) => b[0].length - a[0].length);
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Wrap the first mention of each lab member in a news body with a link to
 * their profile page. Only text outside existing <a> tags is touched.
 */
const linkPeople = (html: string, people: Array<[string, string]>): string => {
  const parts = html.split(/(<[^>]+>)/);
  const used = new Set<string>();
  let inAnchor = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith("<")) {
      if (/^<a[\s>]/i.test(part)) inAnchor++;
      else if (/^<\/a>/i.test(part)) inAnchor = Math.max(0, inAnchor - 1);
      continue;
    }
    if (inAnchor || !part.trim()) continue;
    let text = part;
    for (const [name, slug] of people) {
      if (used.has(slug)) continue;
      const esc = escapeRe(name);
      const re = /^[A-Za-z]/.test(name)
        ? new RegExp(`(?<![A-Za-z])${esc}(?![A-Za-z])`)
        : new RegExp(esc);
      if (re.test(text)) {
        text = text.replace(re, `<a href="#/people/${slug}" class="person-link">${name}</a>`);
        used.add(slug);
      }
    }
    parts[i] = text;
  }
  return parts.join("");
};

const contentPlugin = (): Plugin => ({
  name: "clain-content",
  enforce: "pre",
  transform(code, id) {
    const file = id.split("?")[0];
    if (!file.includes("/content/")) return null;
    if (/\.ya?ml$/.test(file)) {
      return { code: `export default ${JSON.stringify(loadYaml(code) ?? {})};`, map: null };
    }
    if (file.endsWith(".md")) {
      const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(code);
      const data = (m ? loadYaml(m[1]) : {}) as Record<string, unknown>;
      let body = marked.parse(m ? m[2] : code, { async: false }) as string;
      if (file.includes("/content/news/")) body = linkPeople(body, loadPeopleNames());
      return { code: `export default ${JSON.stringify({ ...data, body })};`, map: null };
    }
    return null;
  },
});

export default defineConfig({
  plugins: [contentPlugin(), react()],
  // 必须是根路径 "/"
  base: "/",
  build: {
    outDir: "dist",
    assetsDir: "assets",
  },
});
