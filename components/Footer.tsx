import React from "react";
import { useLanguage } from "../contexts/LanguageContext";
import { Github } from "lucide-react";

const Footer: React.FC = () => {
  const { t } = useLanguage();

  return (
    <footer className="bg-white border-t border-slate-100 mt-auto">
      <div className="max-w-7xl mx-auto py-16 px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-12">
          <div className="md:col-span-2">
            <h3 className="text-brand-red font-bold text-lg mb-4 font-serif">
              {t("common.labFullName")} (CLAIN)
            </h3>
            <p className="text-slate-500 text-sm leading-relaxed max-w-sm">
              {t("hero.description")}
            </p>
          </div>

          <div>
            <h4 className="font-semibold text-brand-dark mb-4 text-sm uppercase tracking-wider">
              {t("common.connect")}
            </h4>
            <ul className="space-y-3 text-sm text-slate-500">
              <li>
                <a
                  href="https://huggingface.co/NextGenWhu"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 hover:text-blue-600 transition-colors"
                >
                  <span className="text-lg">🤗</span> HuggingFace
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/CLAIN-WHU"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 hover:text-blue-600 transition-colors"
                >
                  <Github size={16} /> GitHub
                </a>
              </li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold text-brand-dark mb-4 text-sm uppercase tracking-wider">
              {t("common.contact")}
            </h4>
            <ul className="space-y-3 text-sm text-slate-500">
              <li>{t("common.schoolName")}</li>
              <li>{t("common.location")}</li>
            </ul>
          </div>
        </div>

        <div className="border-t border-slate-100 mt-12 pt-8 flex flex-col md:flex-row justify-between items-center text-xs text-slate-400">
          <p>
            &copy; {new Date().getFullYear()} Cognitive Language and Information Lab. {t("common.copyright")}
          </p>
          <p className="mt-2 md:mt-0">{t("common.designedBy")}</p>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
