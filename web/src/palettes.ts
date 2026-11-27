// 配色方案（#49 配色投票）。code 与数据库 palette_option 对应。
// root：全站的颜色变量；card：「我的事项」卡片自己的一套（.ir）。现行方案不覆盖任何变量。
export type Palette = { code: string; name: string; root: Record<string, string>; card: Record<string, string>; side?: Record<string, string> };

// 四套都以红色为主色（与红底的「正」字标志一致），区别在底色、按钮、侧栏和字体
const RED = '#c8372d', RED_HOVER = '#a92c24';
const cool = { '--brand': RED, '--brand-soft': '#fbeceb', '--bg': '#f5f6f8', '--paper': '#ffffff', '--raise': '#f8f9fb', '--ink': '#14161b', '--mute': '#565c66', '--faint': '#565c66',
  '--line': '#e3e5ea', '--track': '#e9ebef', '--btn': RED, '--btn-hover': RED_HOVER };
const coolCard = { '--i-bg': '#ffffff', '--i-ink': '#14161b', '--i-mut': '#565c66', '--i-line': '#d5d8de', '--i-soft': '#f1f2f5', '--i-red': RED, '--i-paper': '#fafbfc', '--i-serif': 'var(--sans)' };
export const PALETTES: Palette[] = [
  { code: 'ochre', name: '赤陶 · 现行', root: {}, card: {} },
  { code: 'vermilion', name: '朱红 · 冷白', root: cool, card: coolCard },
  { code: 'inkside', name: '朱红 · 墨侧栏', root: cool, card: coolCard,
    side: { '--paper': '#17191e', '--raise': '#22252b', '--ink': '#f2f3f5', '--mute': '#a9aeb7', '--faint': '#a9aeb7', '--nav-ink': '#d9dce1', '--line': '#2b2e35', '--brand': '#ff7a6b', '--brand-soft': '#3a1f1c' } },
  { code: 'night', name: '朱红 · 深色',
    root: { '--brand': '#ff6b5b', '--brand-soft': '#3a1f1c', '--bg': '#111317', '--paper': '#181a1f', '--raise': '#1e2127', '--ink': '#eceef2', '--mute': '#a3a9b3', '--faint': '#a3a9b3',
      '--line': '#2a2d34', '--track': '#262930', '--btn': RED, '--btn-hover': '#d9483d', '--ok': '#4cc38a', '--warn': '#e0b04a', '--bad': '#ff7b72',
      '--nav-ink': '#cfd3da', '--shadow': '0 1px 2px rgba(0,0,0,.3)', '--lift': '0 10px 28px rgba(0,0,0,.45)', 'color-scheme': 'dark' },
    card: { '--i-bg': '#15171c', '--i-ink': '#eceef2', '--i-mut': '#a3a9b3', '--i-line': '#3a3e47', '--i-soft': '#20232a', '--i-red': '#ff6b5b', '--i-paper': '#191c21', '--i-serif': 'var(--sans)' } },
];

const KEY = 'zz-palette-try';
const css = (p: Palette) => `:root{${Object.entries(p.root).map(([k, v]) => `${k}:${v}`).join(';')}}\n.ir{${Object.entries(p.card).map(([k, v]) => `${k}:${v}`).join(';')}}\n` + `.brand>i{background:${RED}}\n` + (p.side ? `.sb{${Object.entries(p.side).map(([k, v]) => `${k}:${v}`).join(';')};background:var(--paper);color:var(--ink)}\n` : '') +
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
