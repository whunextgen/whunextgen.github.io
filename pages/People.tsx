import React, { useState, useEffect } from "react";
import { fetchPeople } from "../lib/dataStore";
import { Person } from "../types";
import { useLanguage } from "../contexts/LanguageContext";
import {
  Mail,
  Globe,
  ChevronDown,
  ChevronUp,
  Award,
  Briefcase,
  Star,
  ArrowRight,
} from "lucide-react";
import SmartImage from "../components/SmartImage";

const TeacherCard: React.FC<{ person: Person }> = ({ person }) => {
  const { t, language } = useLanguage();
  const [expanded, setExpanded] = useState(false);
  const isZh = language === "zh";

  const name = isZh ? person.nameZh || person.name : person.name;
  const title = isZh ? person.titleZh || person.title : person.title;
  const bio = isZh ? person.bioZh || person.bio : person.bio;
  const position = isZh
    ? person.teacherProfile?.positionZh || person.teacherProfile?.position
    : person.teacherProfile?.position;

  const researchAreas = isZh
    ? person.teacherProfile?.researchAreasZh?.length
      ? person.teacherProfile.researchAreasZh
      : person.teacherProfile?.researchAreas
    : person.teacherProfile?.researchAreas;

  const achievements = isZh
    ? person.teacherProfile?.achievementsZh?.length
      ? person.teacherProfile.achievementsZh
      : person.teacherProfile?.achievements
    : person.teacherProfile?.achievements;

  const projects = isZh
    ? person.teacherProfile?.projectsZh?.length
      ? person.teacherProfile.projectsZh
      : person.teacherProfile?.projects
    : person.teacherProfile?.projects;

  const influence = isZh
    ? person.teacherProfile?.influenceZh?.length
      ? person.teacherProfile.influenceZh
      : person.teacherProfile?.influence
    : person.teacherProfile?.influence;

  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-all duration-300 mb-8 animate-fade-in-up">
      <div className="flex flex-col md:flex-row items-start">
        <div className="w-full md:w-64 md:flex-shrink-0 bg-slate-50 relative group border-b md:border-b-0 md:border-r border-slate-100">
          <div className="aspect-[3/4] w-full">
            <SmartImage
              src={person.avatar}
              alt={name}
              className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
              loading="lazy"
            />
          </div>
        </div>

        <div className="p-6 md:p-8 flex-grow flex flex-col w-full min-w-0">
          <div className="flex flex-col sm:flex-row justify-between items-start gap-4 mb-4">
            <div>
              <h3 className="text-2xl font-serif font-bold text-brand-dark mb-1 leading-tight">
                {name}
              </h3>
              <p className="text-brand-red font-medium text-sm uppercase tracking-wide mb-2">
                {title}
              </p>
              {position && (
                <p className="text-slate-500 text-sm italic">{position}</p>
              )}
            </div>

            <div className="flex gap-3 flex-shrink-0">
              {person.email && (
                <a
                  href={`mailto:${person.email}`}
                  className="flex items-center justify-center w-8 h-8 rounded-full bg-slate-50 text-slate-400 hover:text-white hover:bg-brand-red transition-colors"
                  title={t("common.email")}
                >
                  <Mail size={16} />
                </a>
              )}
              {person.homepage && (
                <a
                  href={person.homepage}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-center w-8 h-8 rounded-full bg-slate-50 text-slate-400 hover:text-white hover:bg-blue-600 transition-colors"
                  title={t("common.website")}
                >
                  <Globe size={16} />
                </a>
              )}
            </div>
          </div>

          <div
            className={`text-slate-600 leading-relaxed font-light mb-6 relative ${
              expanded ? "" : "line-clamp-4 md:line-clamp-5"
            }`}
          >
            {bio}
          </div>

          {researchAreas && researchAreas.length > 0 && (
            <div className="mb-6">
              <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">
                {t("people.profile.research")}
              </h4>
              <div className="flex flex-wrap gap-2">
                {researchAreas.map((area, idx) => (
                  <span
                    key={idx}
                    className="px-2.5 py-1 bg-slate-50 text-slate-600 text-xs rounded border border-slate-200"
                  >
                    {area}
                  </span>
                ))}
              </div>
            </div>
          )}

          {expanded && person.teacherProfile && (
            <div className="mt-2 pt-6 border-t border-slate-100 space-y-6 animate-fade-in origin-top">
              {achievements && achievements.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2 text-brand-dark font-medium">
                    <Award size={16} className="text-brand-red" />
                    <h4 className="text-sm font-bold">
                      {t("people.profile.achievements")}
                    </h4>
                  </div>
                  <ul className="list-disc list-outside ml-5 text-sm text-slate-600 space-y-1.5 marker:text-slate-300">
                    {achievements.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}

              {projects && projects.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2 text-brand-dark font-medium">
                    <Briefcase size={16} className="text-blue-600" />
                    <h4 className="text-sm font-bold">
                      {t("people.profile.projects")}
                    </h4>
                  </div>
                  <ul className="list-disc list-outside ml-5 text-sm text-slate-600 space-y-1.5 marker:text-slate-300">
                    {projects.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}

              {influence && influence.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2 text-brand-dark font-medium">
                    <Star size={16} className="text-yellow-500" />
                    <h4 className="text-sm font-bold">
                      {t("people.profile.influence")}
                    </h4>
                  </div>
                  <ul className="list-disc list-outside ml-5 text-sm text-slate-600 space-y-1.5 marker:text-slate-300">
                    {influence.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="mt-auto pt-2">
            <button
              onClick={() => setExpanded(!expanded)}
              className="group flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-brand-red transition-colors"
            >
              {expanded ? (
                <>
                  {t("people.profile.lessInfo")}
                  <ChevronUp
                    size={14}
                    className="group-hover:-translate-y-0.5 transition-transform"
                  />
                </>
              ) : (
                <>
                  {t("people.profile.moreInfo")}
                  <ChevronDown
                    size={14}
                    className="group-hover:translate-y-0.5 transition-transform"
                  />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const CompactPersonCard: React.FC<{ person: Person }> = ({ person }) => {
  const { language } = useLanguage();
  const isZh = language === "zh";
  const name = isZh ? person.nameZh || person.name : person.name;
  const title = isZh ? person.titleZh || person.title : person.title;
  const bio = isZh ? person.bioZh || person.bio : person.bio;
  const position = isZh
    ? person.teacherProfile?.positionZh || person.teacherProfile?.position
    : person.teacherProfile?.position;

  const Wrapper = person.homepage ? "a" : "div";
  const props = person.homepage
    ? { href: person.homepage, target: "_blank", rel: "noreferrer" }
    : {};

  return (
    <Wrapper
      {...props}
      className={`block bg-white border border-slate-100 rounded-lg p-5 transition-all duration-300 group hover:shadow-lg hover:border-brand-red/20 animate-fade-in-up ${
        person.homepage ? "cursor-pointer" : "cursor-default"
      }`}
    >
      <div className="flex items-start gap-4">
        <div className="w-16 h-16 rounded-full overflow-hidden bg-slate-50 flex-shrink-0 border border-slate-100">
          <SmartImage
            src={person.avatar}
            alt={name}
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
            loading="lazy"
          />
        </div>
        <div className="min-w-0 flex-grow">
          <div className="flex justify-between items-start">
            <div>
              <h3 className="font-serif font-bold text-slate-800 text-lg group-hover:text-brand-red transition-colors truncate">
                {name}
              </h3>
              <p className="text-xs uppercase text-slate-400 font-medium truncate">
                {title}
              </p>
              {position && (
                <p className="text-xs text-slate-500 mt-1 leading-snug line-clamp-2">
                  {position}
                </p>
              )}
              {person.grade && (
                <span className="inline-block mt-1 text-[10px] bg-slate-100 px-1.5 py-0.5 rounded text-slate-500">
                  {person.grade}
                </span>
              )}
            </div>
            {person.homepage && (
              <ArrowRight
                size={16}
                className="text-slate-300 group-hover:text-brand-red transition-colors opacity-0 group-hover:opacity-100"
              />
            )}
          </div>
          <p className="text-sm text-slate-500 leading-relaxed font-light line-clamp-2 mt-2">
            {bio}
          </p>
        </div>
      </div>
    </Wrapper>
  );
};

const People: React.FC = () => {
  const { t } = useLanguage();
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const data = await fetchPeople();
        data.sort((a, b) => (a.order || 99) - (b.order || 99));
        setPeople(data);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const getByCategory = (cat: string) =>
    people.filter((p) => p.category === cat);
  const getByCategories = (cats: string[]) =>
    people.filter((p) => cats.includes(p.category));

  if (loading)
    return (
      <div className="min-h-screen pt-24 text-center">
        {t("common.loading")}
      </div>
    );

  const faculty = getByCategory("Teachers");
  const visiting = getByCategory("Visiting Scholars");
  const phd = getByCategory("PhD");
  const masterAcad = getByCategory("Academic Master");
  const masterProf = getByCategory("Professional Master");
  const masterGeneral = getByCategory("Master");
  const ra = getByCategory("RA");
  const internAndSecretary = getByCategories(["Intern", "Secretary"]);

  const Section: React.FC<{
    title: string;
    children: React.ReactNode;
    count: number;
  }> = ({ title, children, count }) => {
    if (count === 0) return null;
    return (
      <section className="mb-20">
        <div className="flex items-center gap-4 mb-8 border-b border-slate-100 pb-4">
          <h2 className="text-2xl font-bold text-slate-800">{title}</h2>
          <span className="text-xs font-mono text-slate-400 bg-slate-50 px-2 py-0.5 rounded-full">
            {count}
          </span>
        </div>
        {children}
      </section>
    );
  };

  const CompactGrid: React.FC<{ items: Person[] }> = ({ items }) => (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {items.map((p) => (
        <CompactPersonCard key={p.id} person={p} />
      ))}
    </div>
  );

  return (
    <div className="bg-white min-h-screen pt-24 pb-20">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <header className="mb-16 pt-10">
          <h1 className="text-4xl md:text-5xl font-serif text-brand-dark mb-4">
            {t("nav.people")}
          </h1>
          <p className="text-lg text-slate-500 font-light max-w-2xl">
            {t("people.subtitle")}
          </p>
        </header>

        {/* Teachers */}
        <Section title={t("people.categories.Teachers")} count={faculty.length}>
          <div className="space-y-8">
            {faculty.map((p) => (
              <TeacherCard key={p.id} person={p} />
            ))}
          </div>
        </Section>

        {/* Visiting Scholars */}
        <Section
          title={t("people.categories.Visiting Scholars")}
          count={visiting.length}
        >
          <CompactGrid items={visiting} />
        </Section>

        {/* PhD Students */}
        <Section title={t("people.categories.PhD")} count={phd.length}>
          <CompactGrid items={phd} />
        </Section>

        {/* Academic Masters */}
        <Section
          title={t("people.categories.Academic Master")}
          count={masterAcad.length}
        >
          <CompactGrid items={masterAcad} />
        </Section>

        {/* Professional Masters */}
        <Section
          title={t("people.categories.Professional Master")}
          count={masterProf.length}
        >
          <CompactGrid items={masterProf} />
        </Section>

        {/* General Masters */}
        <Section
          title={t("people.categories.Master")}
          count={masterGeneral.length}
        >
          <CompactGrid items={masterGeneral} />
        </Section>

        {/* Research Assistants */}
        <Section title={t("people.categories.RA")} count={ra.length}>
          <CompactGrid items={ra} />
        </Section>

        {/* Administrative & Interns */}
        <Section
          title={t("people.categories.InternAndSecretary")}
          count={internAndSecretary.length}
        >
          <CompactGrid items={internAndSecretary} />
        </Section>

        {people.length === 0 && !loading && (
          <div className="py-20 text-center text-slate-300 italic">
            {t("common.noData")}
          </div>
        )}
      </div>
    </div>
  );
};

export default People;
