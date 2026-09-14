import React, { useEffect } from "react";
import {
  HashRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
  Outlet,
} from "react-router-dom";
import Navbar from "./components/Navbar";
import Footer from "./components/Footer";
import Tour from "./pages/Tour"; // This is now "About" visually
import News from "./pages/News";
import NewsDetail from "./pages/NewsDetail";
import People from "./pages/People";
import Publications from "./pages/Publications";
import Contact from "./pages/Contact";

// Contexts
import { LanguageProvider } from "./contexts/LanguageContext";

const ScrollToTop = () => {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
};

const PublicLayout = () => (
  <div className="min-h-screen flex flex-col bg-white selection:bg-brand-red selection:text-white">
    <Navbar />
    <main className="flex-grow flex flex-col">
      <Outlet />
    </main>
    <Footer />
  </div>
);

const App: React.FC = () => {
  return (
    <LanguageProvider>
      <HashRouter>
          <ScrollToTop />
          <Routes>
            {/* Public Routes */}
            <Route element={<PublicLayout />}>
              <Route path="/" element={<Tour />} />
              <Route path="/news" element={<News />} />
              <Route path="/news/:id" element={<NewsDetail />} />
              <Route path="/people" element={<People />} />
              <Route path="/publications" element={<Publications />} />
              <Route path="/contact" element={<Contact />} />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
      </HashRouter>
    </LanguageProvider>
  );
};

export default App;
