import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// 版本号只在仓库根的 package.json 里记一处，构建时写进页面
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;

// 本地开发时把接口请求转给 API 层（地址写在 web/.env.local 的 API_TARGET，不进仓库）
export default defineConfig(({ mode }) => {
  const target = loadEnv(mode, process.cwd(), '').API_TARGET;
  const proxy = target ? Object.fromEntries(['/api', '/auth', '/health'].map((p) => [p, { target, changeOrigin: true }])) : undefined;
  return { plugins: [react()], define: { __APP_VERSION__: JSON.stringify(version) }, server: { port: 5174, proxy } };
});
