export interface Publication {
  id: string;
  title: string;
  authors: string[];
  venue: string; // 发表会议/期刊
  year: number;
  type: "Conference" | "Journal" | "Preprint" | "Other"; // 文献类型
  link?: string;
  tags?: string[];
  order?: number;
  pdf?: string;
}

export interface ProjectLink {
  label: "Try Online" | "GitHub" | "Model" | "Dataset" | "Paper" | "Other";
  url: string;
}

export interface Project {
  id: string;
  title: string;
  description: string;
  content?: string;
  image?: string;
  links: ProjectLink[];
  order?: number;
}

export type PersonCategory =
  | "Teachers"
  | "Visiting Scholars"
  | "PhD"
  | "Master"
  | "Professional Master"
  | "Academic Master"
  | "RA"
  | "Intern"
  | "Secretary";

export interface TeacherProfile {
  position: string;
  positionZh?: string;
  // Fix: changed from [string] to string[] to resolve type errors where empty arrays or string arrays were being assigned.
  researchAreas: string[];
  researchAreasZh?: string[];
  achievements: string[];
  achievementsZh?: string[];
  projects: string[];
  projectsZh?: string[];
  honors?: string[];
  honorsZh?: string[];
  influence?: string[];
  influenceZh?: string[];
  publications?: string[];
}

export interface Person {
  id: string;
  /** URL slug, derived from the content file name */
  slug: string;
  name: string;
  nameZh?: string;
  category: PersonCategory;
  title?: string;
  titleZh?: string;
  avatar: string;
  email?: string;
  homepage?: string;
  bio: string;
  bioZh?: string;
  order: number;
  teacherProfile?: TeacherProfile;
  grade?: string;
  advisor?: string;
}

export interface NewsVisitorLog {
  ip: string;
  timestamp: string;
}

export interface NewsItem {
  id: string;
  date: string;
  title: string;
  subtitle?: string;
  summary: string;
  content?: string;
  titleZh?: string;
  subtitleZh?: string;
  summaryZh?: string;
  contentZh?: string;
  category: string;
  coverImage?: string;
  author?: string;
  isPublished?: boolean;
  isPinned?: boolean;
  order?: number;
  views?: number;
  visitorLogs?: NewsVisitorLog[];
}

export interface Partner {
  name: string;
  nameZh?: string;
  logo: string;
  link?: string;
  bgColor?: string; // Hex color string
}

export interface ContactInfo {
  addressEn: string;
  addressZh: string;
  emailGeneral: string;
  emailAdmissions: string;
  introEn: string;
  introZh: string;
  hiringTextEn: string;
  hiringTextZh: string;
  hiringLink: string;
  mapEmbedUrl: string;
  heroImages?: string[];
  welcomeTitleEn?: string;
  welcomeTitleZh?: string;
  welcomeTextEn?: string;
  welcomeTextZh?: string;
  researchAreasTextEn?: string;
  researchAreasTextZh?: string;
  partners?: Partner[];
}

export interface EventItem {
  id: string;
  date: string;
  time: string;
  location: string;
  title: string;
  description: string;
}

export type Language = "en" | "zh";
