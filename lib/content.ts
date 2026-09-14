import { ContactInfo, NewsItem, Person, Project, Publication } from "../types";

/**
 * Build-time content loader.
 * Files under /content are edited through Decap CMS (/admin/) or by hand and
 * are converted to JS modules by the `clain-content` plugin in vite.config.ts.
 */

type Module = Record<string, any>;

const fileId = (path: string) => path.split("/").pop()!.replace(/\.[^.]+$/, "");

const loadDir = <T>(mods: Record<string, Module>): T[] =>
  Object.entries(mods).map(([path, data]) => ({ id: fileId(path), ...data }) as T);

const peopleFiles = import.meta.glob("/content/people/*.yml", { eager: true, import: "default" }) as Record<string, Module>;
const publicationFiles = import.meta.glob("/content/publications/*.yml", { eager: true, import: "default" }) as Record<string, Module>;
const projectFiles = import.meta.glob("/content/projects/*.yml", { eager: true, import: "default" }) as Record<string, Module>;
const newsEnFiles = import.meta.glob("/content/news/en/*.md", { eager: true, import: "default" }) as Record<string, Module>;
const newsZhFiles = import.meta.glob("/content/news/zh/*.md", { eager: true, import: "default" }) as Record<string, Module>;
const contactFiles = import.meta.glob("/content/contact.yml", { eager: true, import: "default" }) as Record<string, Module>;

export const PEOPLE: Person[] = loadDir<Person>(peopleFiles);
export const PUBLICATIONS: Publication[] = loadDir<Publication>(publicationFiles);
export const PROJECTS: Project[] = loadDir<Project>(projectFiles);
export const CONTACT: ContactInfo = (Object.values(contactFiles)[0] ?? {}) as ContactInfo;

// News is stored per locale (content/news/en, content/news/zh) and merged
// here into the bilingual NewsItem shape the pages expect.
const zhByName = new Map(Object.entries(newsZhFiles).map(([p, d]) => [fileId(p), d]));
export const NEWS: NewsItem[] = Object.entries(newsEnFiles).map(([path, en]) => {
  const name = fileId(path);
  const zh = zhByName.get(name) ?? {};
  // Non-translated fields are duplicated in both files; ignore empty values
  // (Decap writes `null` for untouched optional fields).
  const defined = (m: Module) => Object.fromEntries(Object.entries(m).filter(([, v]) => v != null));
  const shared = { ...defined(en), ...defined(zh) };
  return {
    id: en.id || zh.id || name,
    date: shared.date,
    category: shared.category || "News",
    coverImage: shared.coverImage,
    author: shared.author,
    isPinned: !!shared.isPinned,
    isPublished: shared.isPublished ?? true,
    order: shared.order,
    title: en.title || zh.title || name,
    subtitle: en.subtitle,
    summary: en.summary || "",
    content: en.body,
    titleZh: zh.title,
    subtitleZh: zh.subtitle,
    summaryZh: zh.summary,
    contentZh: zh.body,
  };
});

/** Format an ISO date (YYYY-MM-DD) for display in the current language. */
export const formatDate = (iso: string | undefined, lang: "en" | "zh"): string => {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
};
