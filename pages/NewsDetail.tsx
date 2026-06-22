import React, { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { fetchNewsItem, trackNewsView } from "../lib/dataStore";
import { NewsItem } from "../types";
import { useLanguage } from "../contexts/LanguageContext";
import { ArrowLeft, Calendar, User, X, Eye } from "lucide-react";
import { processHtmlContent } from "../lib/imageUtils";

const NewsDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t, language } = useLanguage();

  const [article, setArticle] = useState<NewsItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  // Fetch Data and Track View
  useEffect(() => {
    const fetchData = async () => {
      if (!id) return;
      setLoading(true);
      try {
        const item = await fetchNewsItem(id);
        if (item) {
          setArticle(item);
          // 异步增加浏览量
          trackNewsView(id).catch((err) =>
            console.warn("View tracking failed", err),
          );
        }
      } catch (err) {
        console.error("Failed to fetch news detail", err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [id]);

  // SEO Title Update
  useEffect(() => {
    if (article) {
      const displayTitle =
        language === "zh"
          ? article.titleZh || article.title
          : article.title || article.titleZh;
      document.title = `${displayTitle} | Cognitive Language and Information Lab`;
    }
  }, [article, language]);

  const handleContentClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "IMG") {
      setLightboxSrc((target as HTMLImageElement).src);
    }
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-24 animate-pulse">
        <div className="h-4 bg-slate-200 w-24 mb-8 rounded"></div>
        <div className="h-12 bg-slate-200 w-3/4 mb-4 rounded"></div>
        <div className="h-6 bg-slate-200 w-1/2 mb-8 rounded"></div>
        <div className="w-full h-64 bg-slate-200 rounded-lg mb-8"></div>
        <div className="space-y-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-4 bg-slate-200 w-full rounded"></div>
          ))}
        </div>
      </div>
    );
  }

  if (!article)
    return (
      <div className="pt-32 text-center text-slate-500">Article not found.</div>
    );

  const isZh = language === "zh";
  const displayTitle = isZh
    ? article.titleZh || article.title
    : article.title || article.titleZh;
  const displaySubtitle = isZh
    ? article.subtitleZh || article.subtitle
    : article.subtitle || article.subtitleZh;
  const displayContent = isZh
    ? article.contentZh || article.content
    : article.content || article.contentZh;
  const displayAuthor = article.author || "CLAIN Lab Team";

  return (
    <div className="bg-white min-h-screen pt-24 pb-20">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <nav className="flex items-center text-sm text-slate-500 mb-8">
          <Link to="/" className="hover:text-brand-red">
            Home
          </Link>
          <span className="mx-2">/</span>
          <Link to="/news" className="hover:text-brand-red">
            {t("nav.news")}
          </Link>
          <span className="mx-2">/</span>
          <span className="text-slate-800 font-medium truncate max-w-[200px]">
            {displayTitle}
          </span>
        </nav>

        <header className="mb-10">
          <div className="flex items-center gap-4 text-xs font-bold uppercase tracking-widest text-brand-red mb-4">
            <span>{article.category}</span>
            <div className="w-px h-3 bg-slate-300"></div>
            <div className="flex items-center text-slate-400">
              <Calendar size={12} className="mr-1" />
              {article.date}
            </div>
            {article.views !== undefined && (
              <>
                <div className="w-px h-3 bg-slate-300"></div>
                <div className="flex items-center text-slate-400">
                  <Eye size={12} className="mr-1" />
                  {article.views} views
                </div>
              </>
            )}
          </div>

          <h1 className="text-3xl md:text-5xl font-serif font-bold text-brand-dark mb-4 leading-tight">
            {displayTitle}
          </h1>

          {displaySubtitle && (
            <p className="text-xl md:text-2xl text-slate-500 font-light leading-relaxed">
              {displaySubtitle}
            </p>
          )}

          <div className="flex justify-between items-end mt-6 border-b border-slate-100 pb-6">
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center">
                <User size={16} />
              </div>
              <span>
                {t("news.by")}{" "}
                <span className="text-brand-dark font-medium">
                  {displayAuthor}
                </span>
              </span>
            </div>
          </div>
        </header>

        {article.coverImage && (
          <div className="mb-12 rounded-lg overflow-hidden shadow-sm">
            <img
              src={
                processHtmlContent(`<img src="${article.coverImage}">`).match(
                  /src="([^"]+)"/,
                )?.[1] || article.coverImage
              }
              alt={displayTitle}
              className="w-full h-auto object-cover max-h-[500px]"
            />
          </div>
        )}

        <div
          className="prose prose-lg prose-slate max-w-none 
            prose-headings:font-serif prose-headings:font-medium prose-headings:text-brand-dark
            prose-p:font-light prose-p:leading-relaxed prose-p:text-slate-600
            prose-img:rounded-lg prose-img:shadow-md prose-img:w-full prose-img:cursor-zoom-in prose-img:my-8
            prose-a:text-blue-600 prose-a:no-underline hover:prose-a:underline
            [&>table]:w-full [&>table]:text-sm [&>table]:text-left [&>table]:border-collapse [&>table]:my-8 [&>table]:block [&>table]:overflow-x-auto
            [&>table_th]:border-b [&>table_th]:border-slate-300 [&>table_th]:pb-2 [&>table_th]:font-bold [&>table_th]:min-w-[100px]
            [&>table_td]:border-b [&>table_td]:border-slate-100 [&>table_td]:py-3 [&>table_td]:text-slate-500
          "
          onClick={handleContentClick}
          dangerouslySetInnerHTML={{
            __html: processHtmlContent(displayContent || ""),
          }}
        ></div>

        {!displayContent && (
          <div className="py-12 text-center text-slate-400 italic bg-slate-50 rounded-lg">
            {isZh ? "暂无中文内容" : "No content available in English."}
          </div>
        )}

        <div className="mt-16 pt-10 border-t border-slate-200 flex justify-between">
          <button
            onClick={() => navigate("/news")}
            className="flex items-center text-slate-500 hover:text-brand-dark font-medium transition-colors"
          >
            <ArrowLeft size={20} className="mr-2" /> {t("common.back")}
          </button>
        </div>
      </div>

      {lightboxSrc && (
        <div
          className="fixed inset-0 z-[60] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in"
          onClick={() => setLightboxSrc(null)}
        >
          <button className="absolute top-4 right-4 text-white/70 hover:text-white">
            <X size={32} />
          </button>
          <img
            src={lightboxSrc}
            alt="Fullscreen"
            className="max-w-full max-h-[90vh] object-contain shadow-2xl rounded-sm"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
};

export default NewsDetail;
