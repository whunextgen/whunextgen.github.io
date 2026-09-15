import React, { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Globe, Mail } from "lucide-react";
import { useLanguage } from "../contexts/LanguageContext";
import { NEWS, PUBLICATIONS, findPersonBySlug, formatDate } from "../lib/content";
import SmartImage from "../components/SmartImage";

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="mb-10">
    <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3">{title}</h2>
    {children}
  </section>
);

const List: React.FC<{ items?: string[] }> = ({ items }) =>
  items && items.length ? (
    <ul className="space-y-2">
      {items.map((it, i) => (
        <li key={i} className="flex items-start gap-2 text-sm text-slate-600 font-light">
          <span className="mt-2 w-1 h-1 rounded-full bg-brand-red flex-shrink-0" />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  ) : null;

const PersonDetail: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const { t, language } = useLanguage();
  const isZh = language === "zh";
  const person = slug ? findPersonBySlug(slug) : undefined;

  useEffect(() => {
    const base = "Cognitive Language and Information Lab";
    document.title = person ? `${person.name} | ${base}` : `People | ${base}`;
  }, [person]);

  if (!person) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-32 text-center text-slate-400">
        <p className="mb-6">{isZh ? "未找到该成员。" : "Member not found."}</p>
        <Link to="/people" className="text-brand-red font-bold">
          {isZh ? "返回团队成员" : "Back to People"}
        </Link>
      </div>
    );
  }

  const pick = (en?: string, zh?: string) => (isZh ? zh || en : en || zh);
  const pickList = (en?: string[], zh?: string[]) => (isZh && zh?.length ? zh : en);
  const name = pick(person.name, person.nameZh);
  const altName = isZh ? person.name : person.nameZh;
  const tp = person.teacherProfile;

  const lname = person.name.trim().toLowerCase();
  const publications = PUBLICATIONS.filter((p) =>
    p.authors.some((a) => a.trim().toLowerCase() === lname || (person.nameZh && a.trim() === person.nameZh)),
  ).sort((a, b) => b.year - a.year);

  const mentioned = (s?: string) =>
    !!s && (s.includes(person.name) || (!!person.nameZh && s.includes(person.nameZh)));
  const news = NEWS.filter(
    (n) => n.isPublished !== false && [n.title, n.titleZh, n.content, n.contentZh].some(mentioned),
  ).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div className="bg-white min-h-screen pt-24 pb-20">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <Link to="/people" className="inline-flex items-center text-sm text-slate-500 hover:text-brand-red mb-10">
          <ArrowLeft size={14} className="mr-1" /> {t("nav.people")}
        </Link>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-10">
          <aside className="md:col-span-1">
            <div className="aspect-[3/4] w-full rounded-lg overflow-hidden bg-slate-50 border border-slate-100 mb-6">
              <SmartImage src={person.avatar} alt={name} className="w-full h-full object-cover" />
            </div>
            <div className="flex gap-3">
              {person.email && (
                <a
                  href={`mailto:${person.email}`}
                  className="flex items-center gap-2 text-sm text-slate-500 hover:text-brand-red"
                  title={t("common.email")}
                >
                  <Mail size={16} /> {t("common.email")}
                </a>
              )}
              {person.homepage && (
                <a
                  href={person.homepage}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 text-sm text-slate-500 hover:text-blue-600"
                  title={t("common.website")}
                >
                  <Globe size={16} /> {t("common.website")}
                </a>
              )}
            </div>
          </aside>

          <main className="md:col-span-2">
            <header className="mb-10">
              <h1 className="text-4xl font-serif font-bold text-brand-dark leading-tight mb-1">{name}</h1>
              {altName && altName !== name && <p className="text-lg text-slate-400 font-light mb-3">{altName}</p>}
              {pick(person.title, person.titleZh) && (
                <p className="text-brand-red font-medium text-sm uppercase tracking-wide">
                  {pick(person.title, person.titleZh)}
                </p>
              )}
              {tp && pick(tp.position, tp.positionZh) && (
                <p className="text-slate-500 text-sm italic mt-2">{pick(tp.position, tp.positionZh)}</p>
              )}
              <div className="flex flex-wrap gap-2 mt-4">
                <span className="text-[10px] uppercase tracking-widest px-2 py-1 border border-slate-200 rounded-sm text-slate-500">
                  {t(`people.categories.${person.category}`)}
                </span>
                {person.grade && (
                  <span className="text-[10px] px-2 py-1 bg-slate-100 rounded-sm text-slate-500">{person.grade}</span>
                )}
                {person.advisor && (
                  <span className="text-[10px] px-2 py-1 bg-slate-100 rounded-sm text-slate-500">
                    {isZh ? "导师：" : "Advisor: "}
                    {person.advisor}
                  </span>
                )}
              </div>
            </header>

            {pick(person.bio, person.bioZh) && (
              <Section title={isZh ? "简介" : "Biography"}>
                <p className="text-slate-600 leading-relaxed font-light whitespace-pre-line">
                  {pick(person.bio, person.bioZh)}
                </p>
              </Section>
            )}

            {tp && (
              <>
                {pickList(tp.researchAreas, tp.researchAreasZh)?.length ? (
                  <Section title={t("people.profile.research")}>
                    <div className="flex flex-wrap gap-2">
                      {pickList(tp.researchAreas, tp.researchAreasZh)!.map((a, i) => (
                        <span key={i} className="px-2.5 py-1 bg-slate-50 text-slate-600 text-xs rounded border border-slate-200">
                          {a}
                        </span>
                      ))}
                    </div>
                  </Section>
                ) : null}
                {pickList(tp.achievements, tp.achievementsZh)?.length ? (
                  <Section title={isZh ? "主要成果" : "Achievements"}>
                    <List items={pickList(tp.achievements, tp.achievementsZh)} />
                  </Section>
                ) : null}
                {pickList(tp.projects, tp.projectsZh)?.length ? (
                  <Section title={isZh ? "科研项目" : "Projects"}>
                    <List items={pickList(tp.projects, tp.projectsZh)} />
                  </Section>
                ) : null}
                {pickList(tp.honors, tp.honorsZh)?.length ? (
                  <Section title={isZh ? "荣誉" : "Honors"}>
                    <List items={pickList(tp.honors, tp.honorsZh)} />
                  </Section>
                ) : null}
                {pickList(tp.influence, tp.influenceZh)?.length ? (
                  <Section title={isZh ? "学术影响" : "Impact"}>
                    <List items={pickList(tp.influence, tp.influenceZh)} />
                  </Section>
                ) : null}
              </>
            )}

            {publications.length > 0 && (
              <Section title={isZh ? `论文（${publications.length}）` : `Publications (${publications.length})`}>
                <ul className="divide-y divide-slate-100">
                  {publications.map((p) => (
                    <li key={p.id} className="py-3">
                      {p.link ? (
                        <a href={p.link} target="_blank" rel="noreferrer" className="font-serif font-bold text-brand-dark hover:text-brand-red">
                          {p.title}
                        </a>
                      ) : (
                        <span className="font-serif font-bold text-brand-dark">{p.title}</span>
                      )}
                      <p className="text-xs text-slate-400 mt-1">
                        {p.authors.join(", ")} · <span className="italic">{p.venue}</span> · {p.year}
                      </p>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {news.length > 0 && (
              <Section title={isZh ? "相关新闻" : "In the news"}>
                <ul className="divide-y divide-slate-100">
                  {news.map((n) => (
                    <li key={n.id} className="py-3 flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4">
                      <span className="text-xs font-mono text-slate-400 flex-shrink-0">{formatDate(n.date, language)}</span>
                      <Link to={`/news/${n.id}`} className="font-serif text-brand-dark hover:text-brand-red">
                        {pick(n.title, n.titleZh)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </main>
        </div>
      </div>
    </div>
  );
};

export default PersonDetail;
