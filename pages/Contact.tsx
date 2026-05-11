import React, { useEffect, useState } from "react";
import { fetchContact } from "../lib/dataStore";
import { ContactInfo } from "../types";
import { useLanguage } from "../contexts/LanguageContext";
import { Mail, MapPin, GraduationCap, Users, Github } from "lucide-react";

const Contact: React.FC = () => {
  const { language, t } = useLanguage();
  const [contactInfo, setContactInfo] = useState<ContactInfo | null>(null);

  useEffect(() => {
    fetchContact()
      .then(setContactInfo)
      .catch(console.error);
  }, []);

  if (!contactInfo)
    return (
      <div className="pt-32 text-center text-slate-400 font-serif">
        {t("common.loading")}
      </div>
    );

  const isZh = language === "zh";
  const address  = isZh ? contactInfo.addressZh  : contactInfo.addressEn;
  const hiringText = isZh ? contactInfo.hiringTextZh : contactInfo.hiringTextEn;

  const parseEmails = (raw: string) =>
    raw
      .split(/[\n,;]+/)
      .map((e) => e.trim())
      .filter(Boolean);

  const generalEmails    = parseEmails(contactInfo.emailGeneral    || "");
  const admissionEmails  = parseEmails(contactInfo.emailAdmissions || "");

  return (
    <div className="bg-white min-h-screen pt-24 pb-20">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">

        {/* ── Header ── */}
        <header className="pt-12 mb-16">
          <h1 className="text-5xl md:text-6xl font-serif text-brand-dark mb-4">
            {t("nav.contact")}
          </h1>
          <p className="text-lg text-slate-500 font-light max-w-2xl leading-relaxed">
            {isZh
              ? "我们欢迎来自全球的研究者、学生和机构开展交流与合作。"
              : "We welcome researchers, prospective students, and institutions worldwide to connect and collaborate."}
          </p>
        </header>

        {/* ── Three contact blocks ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-slate-100 rounded-xl overflow-hidden border border-slate-100 mb-20">

          {/* Block 1: Research Collaboration */}
          <div className="bg-white p-8 flex flex-col gap-4">
            <div className="flex items-center gap-2 text-brand-red">
              <Users size={16} />
              <h2 className="text-[11px] font-bold uppercase tracking-widest">
                {isZh ? "学术合作" : "Research Collaboration"}
              </h2>
            </div>
            <p className="text-sm text-slate-500 font-light leading-relaxed flex-grow">
              {isZh
                ? "如您希望探讨科研合作、项目提案或访问学者事宜，欢迎通过以下方式联系我们。"
                : "For research partnerships, project proposals, or visiting researcher arrangements, please reach out via email."}
            </p>
            <div className="space-y-2 pt-2 border-t border-slate-100">
              {generalEmails.map((email) => (
                <a
                  key={email}
                  href={`mailto:${email}`}
                  className="flex items-center gap-2 text-sm text-slate-700 hover:text-brand-red transition-colors font-mono break-all"
                >
                  <Mail size={13} className="flex-shrink-0 text-slate-400" />
                  {email}
                </a>
              ))}
            </div>
            <div className="flex gap-3 pt-2">
              <a
                href="https://github.com/CLAIN-WHU"
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 text-xs font-bold text-slate-400 hover:text-slate-700 transition-colors uppercase tracking-wider"
              >
                <Github size={13} /> GitHub
              </a>
              <a
                href="https://huggingface.co/NextGenWhu"
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 text-xs font-bold text-slate-400 hover:text-slate-700 transition-colors uppercase tracking-wider"
              >
                <span className="text-sm leading-none">🤗</span> HuggingFace
              </a>
            </div>
          </div>

          {/* Block 2: Graduate Admissions */}
          <div className="bg-white p-8 flex flex-col gap-4">
            <div className="flex items-center gap-2 text-brand-red">
              <GraduationCap size={16} />
              <h2 className="text-[11px] font-bold uppercase tracking-widest">
                {isZh ? "研究生招募" : "Graduate Admissions"}
              </h2>
            </div>
            <p className="text-sm text-slate-500 font-light leading-relaxed flex-grow">
              {hiringText || (isZh
                ? "我们长期招募博士生、硕士生及博士后，欢迎有志于 AI 与 NLP 研究的同学联系。"
                : "We are recruiting PhD students, master's students, and postdoctoral researchers passionate about AI and NLP.")}
            </p>
            <div className="space-y-2 pt-2 border-t border-slate-100">
              {admissionEmails.map((email) => (
                <a
                  key={email}
                  href={`mailto:${email}`}
                  className="flex items-center gap-2 text-sm text-slate-700 hover:text-brand-red transition-colors font-mono break-all"
                >
                  <Mail size={13} className="flex-shrink-0 text-slate-400" />
                  {email}
                </a>
              ))}
              {contactInfo.hiringLink && (
                <a
                  href={contactInfo.hiringLink}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-block text-xs font-bold uppercase tracking-widest text-brand-red hover:underline mt-1"
                >
                  {isZh ? "学院官网 →" : "School Website →"}
                </a>
              )}
            </div>
          </div>

          {/* Block 3: Location */}
          <div className="bg-white p-8 flex flex-col gap-4">
            <div className="flex items-center gap-2 text-brand-red">
              <MapPin size={16} />
              <h2 className="text-[11px] font-bold uppercase tracking-widest">
                {t("common.address")}
              </h2>
            </div>
            <address className="not-italic text-sm text-slate-600 font-light leading-relaxed flex-grow whitespace-pre-line">
              {address}
            </address>
            <div className="pt-2 border-t border-slate-100 space-y-1">
              <p className="text-xs text-slate-400">{t("common.schoolName")}</p>
              <p className="text-xs text-slate-400">{t("common.location")}</p>
            </div>
          </div>
        </div>

        {/* ── Map ── */}
        {contactInfo.mapEmbedUrl && (
          <div className="rounded-xl overflow-hidden border border-slate-100 shadow-sm h-80 md:h-96 relative">
            <iframe
              width="100%"
              height="100%"
              title="map"
              className="absolute inset-0 w-full h-full grayscale hover:grayscale-0 transition-all duration-700 opacity-90 hover:opacity-100"
              frameBorder="0"
              scrolling="no"
              src={contactInfo.mapEmbedUrl}
              loading="lazy"
            />
            <div className="absolute bottom-4 left-4 bg-white/90 backdrop-blur-sm px-3 py-1.5 rounded-lg border border-slate-100 shadow-sm pointer-events-none">
              <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                {isZh ? "武汉大学 · 人工智能学院" : "Wuhan University · School of AI"}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Contact;
