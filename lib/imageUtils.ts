/**
 * 全球化图片加载优化工具 (v2.5 - 富文本增强版)
 */

const GITHUB_USER = "whunextgen";
const GITHUB_REPO = "whunextgen.github.io";

const CDN_BASE = `https://cdn.jsdelivr.net/gh/${GITHUB_USER}/${GITHUB_REPO}@main/`;

const getOriginBase = () => {
  if (typeof window === "undefined") return "";
  const origin = window.location.origin;
  // 确保以斜杠结尾
  return origin.endsWith("/") ? origin : `${origin}/`;
};

/**
 * 将相对路径或远程路径转换为优化的 CDN/Origin 路径
 */
export const optimizeImageUrl = (url: string, useOrigin = false): string => {
  if (!url) return "";

  // 清洗 URL：剔除末尾可能存在的反斜杠或引号
  let cleanUrl = url.trim().replace(/[\\"'，]+$/, "");

  // 1. Base64
  if (cleanUrl.startsWith("data:")) return cleanUrl;

  // 2. 处理本地资产 (./assets/ 或 assets/)
  if (cleanUrl.startsWith("./assets/") || cleanUrl.startsWith("assets/")) {
    const path = cleanUrl.replace(/^\.\//, "");

    // 开发环境下
    if (
      typeof window !== "undefined" &&
      (window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1")
    ) {
      // 在 Vite 环境中，根目录下的 assets 应该直接通过 /assets/ 访问
      return `/${path}`;
    }

    // 生产环境下
    if (useOrigin) {
      return `${getOriginBase()}${path}`;
    }
    return `${CDN_BASE}${path}`;
  }

  return cleanUrl;
};

/**
 * 核心修复：处理 HTML 字符串中的图片路径
 * 解决 dangerouslySetInnerHTML 渲染的 HTML 无法自动优化图片的问题
 */
export const processHtmlContent = (html: string): string => {
  if (!html) return "";

  // 匹配 HTML 中的 src="./assets/..." 或 src="assets/..."
  // 考虑到用户可能会手动输入，我们也匹配普通的远程链接
  const imgTagRegex = /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;

  return html.replace(imgTagRegex, (match, src) => {
    // 对提取出的 src 进行优化
    const optimizedSrc = optimizeImageUrl(src);
    return match.replace(src, optimizedSrc);
  });
};

export const isGlobalMode = (): boolean => {
  if (typeof window === "undefined") return false;
  return !navigator.language.includes("zh");
};
