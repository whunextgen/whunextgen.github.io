import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // 把 "/" 改成了你的仓库名，注意前后都要有斜杠
  base: "/clain-whu.github.io/", 
  build: {
    outDir: "dist",
    assetsDir: "assets",
  },
});
