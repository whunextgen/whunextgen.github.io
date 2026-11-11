import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// 本地开发时把接口请求转给 API 层（地址写在 web/.env.local 的 API_TARGET，不进仓库）
export default defineConfig(({ mode }) => {
  const target = loadEnv(mode, process.cwd(), '').API_TARGET;
  const proxy = target ? Object.fromEntries(['/api', '/auth', '/health'].map((p) => [p, { target, changeOrigin: true }])) : undefined;
  return { plugins: [react()], server: { port: 5174, proxy } };
});
