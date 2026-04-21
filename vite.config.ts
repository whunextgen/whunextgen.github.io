import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // 必须是根路径 "/"
  base: "/", 
  build: {
    outDir: "dist",
    assetsDir: "assets",
  },
});
