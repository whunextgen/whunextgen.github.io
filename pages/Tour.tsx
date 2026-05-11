import React, { useState, useEffect } from "react";
import {
  Flame,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  GraduationCap,
  FileText,
  Layout,
} from "lucide-react";
import { Link } from "react-router-dom";
import {
  fetchContact,
  fetchNews,
  fetchPeople,
  fetchPublications,
  fetchProjects,
} from "../lib/dataStore";
import { useLanguage } from "../contexts/LanguageContext";
import { ContactInfo, NewsItem, Person, Publication, Project } from "../types";
import SmartImage from "../components/SmartImage";

// ─── Default hero images (used when heroImages is not set in data) ────────────
const DEFAULT_HERO_IMAGES = [
  "./assets/index-0.jpeg",
  "./assets/index-1.jpeg",
  "./assets/index-2.jpeg",
];

// ─── Partner categorisation ───────────────────────────────────────────────────
const INTL_NAMES = new Set([
  "The University of Manchester",
  "MBZUAI",
  "National Centre for Text Mining (NaCTeM), University of Manchester",
  "Université de Montréal",
  "Halmstad University",
  "Universiti Malaya",
  "Krirk University",
  "The University of Edinburgh",
  "Cardiff University",
  "The Chinese University of Hong Kong, Shenzhen",
  "Hong Kong Metropolitan University",
]);

const INDUSTRY_NAMES = new Set([
  "Tencent",
  "Curefun",
  "Chinese People's Liberation Army (PLA) General Hospital",
  "People's Government of Dongxihu District, Wuhan",
  "ZHONGSHAN HOSPITAL",
  "HUAWEI Health",
  "China Musical Instruments Association",
]);

// ─── Vision content ───────────────────────────────────────────────────────────
const VISIONS = [
  {
    num: "01",
    phrase: "of humanity",
    titleZh: "源于人类",
    descEn:
      "Our research is grounded in human language, knowledge, and culture — building AI that genuinely understands the richness of human expression.",
    descZh:
      "我们的研究深植于人类的语言、知识与文化，致力于构建真正理解人类表达丰富内涵的 AI。",
  },
  {
    num: "02",
    phrase: "by humanity",
    titleZh: "协同人类",
    descEn:
      "We believe the best AI is built through interdisciplinary collaboration — combining NLP, medicine, finance, and social science to reflect human values.",
    descZh:
      "最好的 AI 由跨学科合作铸就——融合 NLP、医学、金融与社会科学，让技术映照人类价值。",
  },
  {
    num: "03",
    phrase: "for humanity",
    titleZh: "造福人类",
    descEn:
      "Every model we build, every dataset we release is ultimately aimed at solving real problems in healthcare, finance, and society at large.",
    descZh:
      "我们构建的每个模型、发布的每个数据集，最终都指向解决医疗、金融与社会中的真实问题。",
  },
];

// ─── Publication type icon ────────────────────────────────────────────────────
const pubTypeIcon = (type: string) => {
  switch (type) {
    case "Journal":    return <BookOpen size={11} className="text-blue-500" />;
    case "Conference": return <GraduationCap size={11} className="text-brand-red" />;
    case "Preprint":   return <FileText size={11} className="text-slate-400" />;
    default:           return <Layout size={11} className="text-slate-400" />;
  }
};

// ─── Main component ───────────────────────────────────────────────────────────
const Tour: React.FC = () => {
  const { t, language } = useLanguage();
  const [contactInfo, setContactInfo]   = useState<ContactInfo | null>(null);
  const [newsItems, setNewsItems]       = useState<NewsItem[]>([]);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [projects, setProjects]         = useState<Project[]>([]);
  const [people, setPeople]             = useState<Person[]>([]);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [loading, setLoading]           = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [contactData, newsData, peopleData, pubData, projData] =
          await Promise.all([
            fetchContact(),
            fetchNews(),
            fetchPeople(),
            fetchPublications(),
            fetchProjects(),
          ]);
        setContactInfo(contactData);
        setNewsItems(newsData.slice(0, 4));
        setPeople(peopleData);
        setPublications(pubData);
        setProjects(projData);
      } catch (err) {
        console.error("[Home] Load Failed:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    const imgs = contactInfo?.heroImages;
    if (imgs && imgs.length > 1) {
      const id = setInterval(
        () => setCurrentImageIndex((p) => (p + 1) % imgs.length),
        5000,
      );
      return () => clearInterval(id);
    }
  }, [contactInfo]);

  const isZh = language === "zh";
  const getText = (zh?: string, en?: string, def = "") =>
    isZh ? zh || en || def : en || zh || def;

  const welcomeText = getText(contactInfo?.welcomeTextZh, contactInfo?.welcomeTextEn, "");

  const featuredPubs = publications.slice(0, 3);
  const rawHeroImages = (contactInfo?.heroImages ?? []).map(s => s.trim()).filter(Boolean);
  const heroImages = rawHeroImages.length > 0 ? rawHeroImages : DEFAULT_HERO_IMAGES;
  const partners   = contactInfo?.partners || [];
  const intlParts    = partners.filter((p) => INTL_NAMES.has(p.name));
  const industParts  = partners.filter((p) => INDUSTRY_NAMES.has(p.name));
  const domParts     = partners.filter(
    (p) => !INTL_NAMES.has(p.name) && !INDUSTRY_NAMES.has(p.name),
  );

  const stats = [
    { value: publications.length ? `${publications.length}+` : "—", label: isZh ? "发表论文" : "Publications" },
    { value: people.length       ? `${people.length}+`       : "—", label: isZh ? "团队成员" : "Team Members"  },
    { value: projects.length     ? `${projects.length}+`     : "—", label: isZh ? "研究项目" : "Projects"       },
  ];

  // Partner section helper
  const PartnerGroup: React.FC<{ title: string; items: typeof partners }> = ({ title, items }) => {
    if (!items.length) return null;
    return (
      <div>
        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-4">
          {title}
          <span className="ml-2 font-mono text-slate-300 normal-case">{items.length}</span>
        </p>
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3">
          {items.map((partner, i) => {
            // Use the stored bgColor from data (currently #D3D3D3 for all).
            // Admin can set darker bgColor for logos with white text.
            const bg = partner.bgColor || "#F1F5F9";
            return (
              <a
                key={i}
                href={partner.link || "#"}
                target="_blank"
                rel="noreferrer"
                title={getText(partner.nameZh, partner.name)}
                className="group flex flex-col"
              >
                <div
                  className="rounded-lg p-3 flex items-center justify-center h-14 transition-all duration-200 border border-transparent group-hover:shadow-sm group-hover:scale-105"
                  style={{ backgroundColor: bg }}
                >
                  <SmartImage
                    src={partner.logo}
                    alt={getText(partner.nameZh, partner.name)}
                    className="max-h-7 max-w-full object-contain"
                  />
                </div>
                <p className="mt-1.5 text-[9px] text-center text-slate-400 group-hover:text-slate-600 transition-colors leading-tight line-clamp-2 font-medium px-0.5">
                  {getText(partner.nameZh, partner.name)}
                </p>
              </a>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="bg-white">

      {/* ═══ HERO ════════════════════════════════════════════════════════════ */}
      <section className="relative w-full h-[65vh] min-h-[460px] mt-20 overflow-hidden bg-slate-900">
        {/* Image slides */}
        {heroImages.length > 0
          ? heroImages.map((img, idx) => (
              <div
                key={idx}
                className={`absolute inset-0 transition-opacity duration-1000 ease-in-out ${
                  idx === currentImageIndex ? "opacity-100" : "opacity-0"
                }`}
              >
                <SmartImage
                  src={img}
                  alt={`Slide ${idx + 1}`}
                  className="w-full h-full object-cover"
                />
              </div>
            ))
          : (
              <div className="absolute inset-0 flex items-center justify-center">
                <Flame className="w-20 h-20 text-slate-700" />
              </div>
            )}

        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />

        {/* Text overlay */}
        <div className="absolute bottom-0 left-0 right-0">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-10">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-white/10 backdrop-blur-sm border border-white/20 rounded-full text-white text-[11px] font-bold uppercase tracking-widest mb-4">
              <Flame size={11} fill="currentColor" fillOpacity={0.8} />
              {t("common.wuhanUniversity")}
            </div>
            <h1 className="text-4xl sm:text-5xl md:text-6xl font-serif font-medium text-white mb-5 leading-tight max-w-3xl">
              {t("common.labFullName")}
            </h1>
            <div className="flex flex-wrap items-center gap-3 mb-5">
              <Link
                to="/people"
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-brand-red text-white text-sm font-bold rounded-lg hover:bg-brand-red/90 transition-colors"
              >
                {t("hero.meetTeam")} <ArrowRight size={14} />
              </Link>
              <Link
                to="/publications"
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-white/10 backdrop-blur-sm border border-white/30 text-white text-sm font-bold rounded-lg hover:bg-white/20 transition-colors"
              >
                {t("hero.viewPubs")}
              </Link>
            </div>
            {heroImages.length > 1 && (
              <div className="flex gap-2">
                {heroImages.map((_, idx) => (
                  <button
                    key={idx}
                    onClick={() => setCurrentImageIndex(idx)}
                    className={`transition-all duration-300 rounded-full ${
                      idx === currentImageIndex
                        ? "w-6 h-2 bg-white"
                        : "w-2 h-2 bg-white/30 hover:bg-white/50"
                    }`}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ═══ WELCOME TEXT ════════════════════════════════════════════════════ */}
      {!loading && welcomeText && (
        <section className="py-10 border-b border-slate-100">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <p className="text-base text-slate-500 font-light leading-relaxed max-w-3xl">
              {welcomeText}
            </p>
          </div>
        </section>
      )}

      {/* ═══ VISION ══════════════════════════════════════════════════════════ */}
      <section className="bg-brand-dark">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-slate-800">
            {VISIONS.map((v, i) => (
              <div
                key={i}
                className="px-0 md:px-10 py-10 md:py-0 first:md:pl-0 last:md:pr-0"
              >
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-600 mb-5">
                  {v.num}
                </p>
                <h3 className="text-3xl md:text-4xl font-serif italic text-white mb-1 leading-tight">
                  {v.phrase}
                </h3>
                {isZh && (
                  <p className="text-xs uppercase tracking-widest text-slate-500 font-bold mb-5">
                    {v.titleZh}
                  </p>
                )}
                {!isZh && <div className="mb-5" />}
                <p className="text-sm text-slate-400 font-light leading-relaxed">
                  {isZh ? v.descZh : v.descEn}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ STATS BAR ════════════════════════════════════════════════════════ */}
      {!loading && (
        <section className="border-b border-slate-100 bg-slate-50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="grid grid-cols-3 divide-x divide-slate-200">
              {stats.map((s, i) => (
                <div key={i} className="text-center px-6">
                  <p className="text-2xl md:text-3xl font-bold font-serif text-brand-dark">
                    {s.value}
                  </p>
                  <p className="text-[11px] uppercase tracking-widest text-slate-400 font-medium mt-1">
                    {s.label}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ═══ FEATURED PUBLICATIONS ════════════════════════════════════════════ */}
      {featuredPubs.length > 0 && (
        <section className="py-16 border-b border-slate-100">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-baseline justify-between mb-8">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                {isZh ? "代表性论文" : "Featured Research"}
              </p>
              <Link
                to="/publications"
                className="text-[11px] font-bold uppercase tracking-widest text-brand-red hover:underline"
              >
                {t("hero.viewPubs")} →
              </Link>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              {featuredPubs.map((pub) => (
                <div
                  key={pub.id}
                  className="group border border-slate-200 rounded-xl p-5 hover:shadow-md transition-all duration-300 flex flex-col"
                >
                  <div className="flex items-center justify-between mb-3">
                    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide bg-slate-50 border border-slate-200 text-slate-600">
                      {pubTypeIcon(pub.type)}
                      {pub.type}
                    </span>
                    <span className="text-xs font-mono text-slate-400">{pub.year}</span>
                  </div>
                  <div className="flex-grow mb-4">
                    {pub.link ? (
                      <a
                        href={pub.link}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm font-serif font-bold text-brand-dark leading-snug line-clamp-3 hover:text-brand-red transition-colors"
                      >
                        {pub.title}
                      </a>
                    ) : (
                      <p className="text-sm font-serif font-bold text-brand-dark leading-snug line-clamp-3">
                        {pub.title}
                      </p>
                    )}
                  </div>
                  <div className="mt-auto pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
                    <span className="text-xs italic text-slate-500 line-clamp-1 flex-grow">
                      {pub.venue}
                    </span>
                    {pub.link && (
                      <a href={pub.link} target="_blank" rel="noreferrer" className="flex-shrink-0 text-brand-red hover:opacity-70">
                        <ArrowUpRight size={15} />
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ═══ LATEST NEWS + JOIN US ════════════════════════════════════════════ */}
      <section className="py-16 border-b border-slate-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-12">

            <div className="md:col-span-2">
              <div className="flex items-baseline justify-between mb-6">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                  {t("nav.news")}
                </p>
                <Link to="/news" className="text-[11px] font-bold uppercase tracking-widest text-brand-red hover:underline">
                  {t("sections.viewArchive")} →
                </Link>
              </div>
              <ul className="divide-y divide-slate-100">
                {newsItems.map((item) => (
                  <li key={item.id} className="group py-4 flex items-start gap-4">
                    <span className="flex-shrink-0 text-[11px] font-mono text-slate-300 tabular-nums pt-0.5 w-16">
                      {item.date.slice(0, 7)}
                    </span>
                    <div className="flex-grow min-w-0">
                      <Link
                        to={`/news/${item.id}`}
                        className="text-sm font-medium text-slate-700 group-hover:text-brand-red transition-colors line-clamp-2 leading-snug"
                      >
                        {getText(item.titleZh, item.title)}
                      </Link>
                      {item.category && (
                        <span className="mt-1 inline-block text-[10px] uppercase tracking-widest text-slate-400 font-bold">
                          {item.category}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            {/* Join Us */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-6">
                {t("contact.joinUs")}
              </p>
              <div className="bg-slate-900 rounded-2xl p-7 flex flex-col">
                <Flame size={26} className="text-brand-red mb-5" fill="currentColor" fillOpacity={0.15} />
                <p className="text-white font-serif text-xl leading-snug mb-3">
                  {isZh ? "加入 CLAIN" : "Join CLAIN"}
                </p>
                <p className="text-slate-400 text-sm font-light leading-relaxed mb-6">
                  {isZh
                    ? "我们长期招募博士生、硕士生和研究实习生。欢迎对 AI 与 NLP 有热情的你联系我们。"
                    : "We are recruiting PhD students, master's students, and research interns passionate about AI and NLP."}
                </p>
                <Link to="/contact" className="inline-flex items-center gap-2 text-sm font-bold text-brand-red hover:text-white transition-colors mt-auto">
                  {t("nav.contact")} <ArrowRight size={14} />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ═══ COLLABORATING INSTITUTIONS ══════════════════════════════════════ */}
      {!loading && partners.length > 0 && (
        <section className="py-16">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-12 text-center">
              {t("common.partners")}
            </p>
            <div className="space-y-12">
              <PartnerGroup
                title={isZh ? "国际合作" : "International"}
                items={intlParts}
              />
              <PartnerGroup
                title={isZh ? "国内高校与科研机构" : "Domestic Universities & Institutes"}
                items={domParts}
              />
              <PartnerGroup
                title={isZh ? "产业与医疗合作" : "Industry & Medical"}
                items={industParts}
              />
            </div>
          </div>
        </section>
      )}
    </div>
  );
};

export default Tour;
