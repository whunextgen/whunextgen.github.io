import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { load, CORE_SCHEMA } from "js-yaml";

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
      const body = marked.parse(m ? m[2] : code, { async: false }) as string;
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
