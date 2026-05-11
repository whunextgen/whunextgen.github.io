import React, { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  Newspaper,
  LogOut,
  Flame,
  BookOpen,
  MapPin,
  ShieldAlert,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext";

const AdminLayout: React.FC = () => {
  const { logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate("/admin/login");
  };

  const navClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 px-4 py-3 text-sm font-medium rounded-md transition-colors ${
      isActive
        ? "bg-brand-red text-white"
        : "text-slate-400 hover:text-white hover:bg-white/5"
    }`;

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Sidebar */}
      <aside className="w-64 bg-slate-900 text-white fixed h-full z-20 hidden md:flex flex-col">
        <div className="h-20 flex items-center px-6 border-b border-white/10">
          <Flame className="w-6 h-6 text-brand-red mr-3" />
          <span className="font-bold tracking-wider">CLAIN ADMIN</span>
        </div>

        <div className="p-4 mx-4 mt-4 bg-amber-500/10 border border-amber-500/20 rounded-lg">
          <div className="flex items-center gap-2 text-amber-500 mb-1">
            <ShieldAlert size={14} />
            <span className="text-[10px] font-bold uppercase tracking-wider">
              Static Mode
            </span>
          </div>
          <p className="text-[10px] text-slate-400 leading-tight">
            当前为 GitHub 静态模式。修改操作无法保存，请在本地 constants.ts
            中更新数据。
          </p>
        </div>

        <nav className="flex-1 px-4 py-6 space-y-2">
          <NavLink to="/admin/dashboard" className={navClass}>
            <LayoutDashboard size={18} />
            Dashboard
          </NavLink>
          <NavLink to="/admin/contact" className={navClass}>
            <MapPin size={18} />
            Site Settings
          </NavLink>
          <NavLink to="/admin/news" className={navClass}>
            <Newspaper size={18} />
            News & Updates
          </NavLink>
          <NavLink to="/admin/people" className={navClass}>
            <Users size={18} />
            People & Faculty
          </NavLink>
          <NavLink to="/admin/publications" className={navClass}>
            <BookOpen size={18} />
            Publications
          </NavLink>
        </nav>

        <div className="p-4 border-t border-white/10">
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-4 py-3 text-sm font-medium text-slate-400 hover:text-white w-full transition-colors"
          >
            <LogOut size={18} />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 md:ml-64 min-h-screen flex flex-col">
        <div className="p-8 flex-grow">
          <Outlet />
        </div>

        <footer className="px-8 py-4 text-center text-xs text-slate-400 border-t border-slate-200 bg-white">
          CLAIN Static Site | Built for GitHub Pages | Data source:{" "}
          <span className="font-mono">constants.ts</span>
        </footer>
      </main>
    </div>
  );
};

export default AdminLayout;
