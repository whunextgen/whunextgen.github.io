// 配色方案（#49 配色投票）。code 与数据库 palette_option 对应。
// root：全站的颜色变量；card：「我的事项」卡片自己的一套（.ir）。现行方案不覆盖任何变量。
export type Palette = { code: string; name: string; root: Record<string, string>; card: Record<string, string> };

export const PALETTES: Palette[] = [
  { code: 'ochre', name: '赤陶 · 现行', root: {}, card: {} },
  { code: 'azure', name: '晴空 · 科技蓝',
    root: { '--brand': '#2563eb', '--brand-soft': '#eaf1fe', '--bg': '#f4f6fa', '--paper': '#ffffff', '--raise': '#f7f9fc', '--ink': '#0f172a', '--mute': '#556070', '--faint': '#556070',
      '--line': '#e2e7ef', '--track': '#e7ecf3', '--btn': '#2563eb', '--btn-hover': '#1d4ed8', '--gold': '#d97706', '--gold-lt': '#fde7c4' },
    card: { '--i-bg': '#eef3fb', '--i-ink': '#0f172a', '--i-mut': '#4a5466', '--i-line': '#0f172a', '--i-soft': '#dde6f4', '--i-red': '#2563eb', '--i-paper': '#f8faff', '--i-serif': 'var(--sans)' } },
  { code: 'jade', name: '青碧 · 墨绿',
    root: { '--brand': '#0f766e', '--brand-soft': '#e4f3f1', '--bg': '#f2f5f4', '--paper': '#ffffff', '--raise': '#f6f9f8', '--ink': '#13221f', '--mute': '#4f5e5a', '--faint': '#4f5e5a',
      '--line': '#dfe7e5', '--track': '#e4ebe9', '--btn': '#0f766e', '--btn-hover': '#115e59' },
    card: { '--i-bg': '#e9f2ef', '--i-ink': '#13221f', '--i-mut': '#475752', '--i-line': '#13221f', '--i-soft': '#d4e5e0', '--i-red': '#0f766e', '--i-paper': '#f5faf8', '--i-serif': 'var(--sans)' } },
  { code: 'night', name: '夜幕 · 深色',
    root: { '--brand': '#6b9bff', '--brand-soft': '#1b2742', '--bg': '#0f1217', '--paper': '#161a21', '--raise': '#1c2129', '--ink': '#e8ebf1', '--mute': '#a0a8b6', '--faint': '#a0a8b6',
      '--line': '#2a303b', '--track': '#252b35', '--btn': '#3b6fe0', '--btn-hover': '#5584f0', '--ok': '#4cc38a', '--warn': '#e0b04a', '--bad': '#ff7b72',
      '--nav-ink': '#c9cfd9', '--shadow': '0 1px 2px rgba(0,0,0,.3)', '--lift': '0 10px 28px rgba(0,0,0,.45)', 'color-scheme': 'dark' },
    card: { '--i-bg': '#12161d', '--i-ink': '#e8ebf1', '--i-mut': '#a0a8b6', '--i-line': '#3a4250', '--i-soft': '#1e2430', '--i-red': '#6b9bff', '--i-paper': '#171c24', '--i-serif': 'var(--sans)' } },
];

const KEY = 'zz-palette-try';
const css = (p: Palette) => `:root{${Object.entries(p.root).map(([k, v]) => `${k}:${v}`).join(';')}}\n.ir{${Object.entries(p.card).map(([k, v]) => `${k}:${v}`).join(';')}}\n` +
  (p.code === 'night' ? 'body{background:var(--bg);color:var(--ink)}\ninput,select,textarea{background:var(--raise);color:var(--ink);border-color:var(--line)}\n' : '');

// 试用：只改本人这台浏览器的显示，不影响别人；刷新后保留，直到点「恢复现行配色」
export function tryPalette(code: string | null) {
  const p = PALETTES.find((x) => x.code === code);
  let el = document.getElementById('palette-try') as HTMLStyleElement | null;
  if (!p || p.code === 'ochre') { el?.remove(); try { localStorage.removeItem(KEY); } catch { /* 无痕模式 */ } window.dispatchEvent(new Event('palette-try')); return; }
  if (!el) { el = document.createElement('style'); el.id = 'palette-try'; document.head.appendChild(el); }
  el.textContent = css(p);
  try { localStorage.setItem(KEY, p.code); } catch { /* 无痕模式 */ }
  window.dispatchEvent(new Event('palette-try'));
}
export function triedPalette(): Palette | null {
  try { const c = localStorage.getItem(KEY); return PALETTES.find((x) => x.code === c && x.code !== 'ochre') ?? null; } catch { return null; }
}
// 页面加载时恢复试用中的配色
export function restorePalette() { const p = triedPalette(); if (p) tryPalette(p.code); }
