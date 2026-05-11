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

// Admin Imports
import AdminLayout from "./layouts/AdminLayout";
import AdminLogin from "./pages/admin/Login";
import NewsManager from "./pages/admin/NewsManager";
import PeopleManager from "./pages/admin/PeopleManager";
import PublicationManager from "./pages/admin/PublicationManager";
import ContactManager from "./pages/admin/ContactManager";

// Contexts
import { LanguageProvider } from "./contexts/LanguageContext";
import { AuthProvider, useAuth } from "./contexts/AuthContext";

const ScrollToTop = () => {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
};

// Protected Route Component
const ProtectedRoute = () => {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <Outlet /> : <Navigate to="/admin/login" replace />;
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
      <AuthProvider>
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

            {/* Admin Routes */}
            <Route path="/admin/login" element={<AdminLogin />} />
            <Route path="/admin" element={<ProtectedRoute />}>
              <Route element={<AdminLayout />}>
                <Route index element={<Navigate to="/admin/dashboard" />} />
                <Route
                  path="dashboard"
                  element={
                    <div className="bg-white p-8 rounded shadow text-center py-20">
                      <h1 className="text-3xl font-bold text-slate-800 mb-4">
                        Welcome to CLAIN Dashboard
                      </h1>
                      <p className="text-slate-500">
                        Select a module from the sidebar to manage content.
                      </p>
                    </div>
                  }
                />
                <Route path="news" element={<NewsManager />} />
                <Route path="people" element={<PeopleManager />} />
                <Route path="publications" element={<PublicationManager />} />
                <Route path="contact" element={<ContactManager />} />
              </Route>
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </HashRouter>
      </AuthProvider>
    </LanguageProvider>
  );
};

export default App;
