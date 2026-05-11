import React, { useState, useEffect } from "react";
import { fetchPublications } from "../lib/dataStore";
import { Publication } from "../types";
import {
  ArrowUpRight,
  BookOpen,
  GraduationCap,
  FileText,
  Layout,
} from "lucide-react";
import { useLanguage } from "../contexts/LanguageContext";

const TYPE_FILTERS = ["All", "Conference", "Journal", "Preprint", "Other"] as const;

const typeIcon = (type: string) => {
  switch (type) {
    case "Journal":
      return <BookOpen size={12} className="text-blue-500" />;
    case "Conference":
      return <GraduationCap size={12} className="text-brand-red" />;
    case "Preprint":
      return <FileText size={12} className="text-slate-400" />;
    default:
      return <Layout size={12} className="text-slate-400" />;
  }
};

const typeBadgeClass = (type: string) => {
  switch (type) {
    case "Journal":
      return "bg-blue-50 text-blue-600 border-blue-100";
    case "Conference":
      return "bg-red-50 text-brand-red border-red-100";
    case "Preprint":
      return "bg-slate-50 text-slate-500 border-slate-200";
    default:
      return "bg-slate-50 text-slate-500 border-slate-200";
  }
};

const PubCard: React.FC<{ pub: Publication }> = ({ pub }) => (
  <div className="group bg-white border border-slate-200 rounded-xl p-6 hover:shadow-lg transition-all duration-300 flex flex-col">
    {/* Type badge + year */}
    <div className="flex items-center justify-between mb-4">
      <span
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide border ${typeBadgeClass(pub.type)}`}
      >
        {typeIcon(pub.type)}
        {pub.type}
      </span>
      <span className="text-xs font-mono text-slate-400">{pub.year}</span>
    </div>

    {/* Title + authors */}
    <div className="flex-grow flex flex-col mb-4">
      {pub.link ? (
        <a
          href={pub.link}
          target="_blank"
          rel="noreferrer"
          className="text-base font-serif font-bold text-brand-dark mb-2 leading-snug hover:text-brand-red transition-colors line-clamp-3"
        >
          {pub.title}
        </a>
      ) : (
        <h3 className="text-base font-serif font-bold text-brand-dark mb-2 leading-snug line-clamp-3">
          {pub.title}
        </h3>
      )}
      <p className="text-xs text-slate-400 leading-relaxed line-clamp-2">
        {pub.authors.join(", ")}
      </p>
    </div>

    {/* Footer: venue + link */}
    <div className="mt-auto pt-4 border-t border-slate-100 flex items-center justify-between gap-3">
      <span className="text-xs italic font-semibold text-slate-600 line-clamp-1 flex-grow">
        {pub.venue}
      </span>
      {pub.link && (
        <a
          href={pub.link}
          target="_blank"
          rel="noreferrer"
          className="flex-shrink-0 flex items-center gap-1 text-xs font-bold text-brand-red hover:text-brand-red/70 transition-colors"
        >
          Link <ArrowUpRight size={12} />
        </a>
      )}
    </div>

    {/* Tags */}
    {pub.tags && pub.tags.length > 0 && (
      <div className="flex flex-wrap gap-1.5 mt-3">
        {pub.tags.map((tag) => (
          <span
            key={tag}
            className="text-[9px] font-mono uppercase tracking-widest text-slate-400 px-1.5 py-0.5 border border-slate-100 rounded"
          >
            {tag}
          </span>
        ))}
      </div>
    )}
  </div>
);

const Publications: React.FC = () => {
  const { t } = useLanguage();
  const [publications, setPublications] = useState<Publication[]>([]);
  const [filterYear, setFilterYear] = useState<string>("All");
  const [filterType, setFilterType] = useState<string>("All");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const data = await fetchPublications();
        setPublications(data);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const years = [
    "All",
    ...Array.from(new Set(publications.map((p) => p.year.toString())))
      .sort()
      .reverse(),
  ];

  const filtered = publications.filter((p) => {
    const yearOk = filterYear === "All" || p.year.toString() === filterYear;
    const typeOk = filterType === "All" || p.type === filterType;
    return yearOk && typeOk;
  });

  const grouped: Record<number, Publication[]> = {};
  filtered.forEach((pub) => {
    if (!grouped[pub.year]) grouped[pub.year] = [];
    grouped[pub.year].push(pub);
  });
  const sortedYears = Object.keys(grouped)
    .map(Number)
    .sort((a, b) => b - a);

  if (loading) {
    return (
      <div className="min-h-screen pt-32 text-center text-slate-400 font-serif">
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="bg-white min-h-screen pt-24 pb-20">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">

        {/* Header */}
        <header className="mb-10 pt-10">
          <h1 className="text-5xl md:text-6xl font-serif text-brand-dark mb-4">
            {t("publications.title")}
          </h1>
          <p className="text-xl text-slate-500 font-light max-w-2xl">
            {t("publications.subtitle")}
          </p>
        </header>

        {/* Filters */}
        <div className="mb-10 flex flex-col sm:flex-row gap-5 items-start sm:items-center justify-between border-b border-slate-100 pb-8">
          {/* Type tabs */}
          <div className="flex flex-wrap gap-2">
            {TYPE_FILTERS.map((type) => (
              <button
                key={type}
                onClick={() => setFilterType(type)}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-200 border ${
                  filterType === type
                    ? "bg-brand-red text-white border-brand-red shadow-sm"
                    : "bg-white text-slate-600 border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                }`}
              >
                {type === "All" ? t("publications.filterAll") : type}
              </button>
            ))}
          </div>

          {/* Year filter */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-[11px] font-bold uppercase tracking-widest text-slate-400">
              {t("publications.filterYear")}
            </span>
            <div className="relative">
              <select
                value={filterYear}
                onChange={(e) => setFilterYear(e.target.value)}
                className="appearance-none bg-transparent border-b border-brand-red py-1.5 pl-2 pr-6 text-brand-dark font-mono text-sm focus:outline-none cursor-pointer"
              >
                {years.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
              <div className="absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none text-brand-red">
                <ArrowUpRight size={12} className="rotate-90" />
              </div>
            </div>
          </div>
        </div>

        {/* Cards grouped by year */}
        {sortedYears.length > 0 ? (
          <div className="space-y-14">
            {sortedYears.map((year) => (
              <section key={year}>
                <div className="flex items-center gap-4 mb-6">
                  <span className="text-[11px] font-bold uppercase tracking-widest text-slate-400">
                    {year}
                  </span>
                  <div className="h-px flex-grow bg-slate-100" />
                  <span className="text-[11px] font-mono text-slate-300">
                    {grouped[year].length} {t("publications.papers")}
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
                  {grouped[year].map((pub) => (
                    <PubCard key={pub.id} pub={pub} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="py-20 text-center text-slate-400 font-light italic">
            {t("publications.noPubs")}
          </div>
        )}
      </div>
    </div>
  );
};

export default Publications;
