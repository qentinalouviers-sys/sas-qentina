'use client';

import { useState } from 'react';
import { Menu } from 'lucide-react';
import Sidebar from '@/components/Sidebar';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="app-layout">
      {/* Hamburger for mobile (opens the side drawer) */}
      <button
        className="mobile-toggle"
        onClick={() => setSidebarOpen(true)}
        aria-label="Ouvrir le menu"
      >
        <Menu size={20} />
      </button>

      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <main className="main-content">
        {children}
      </main>
    </div>
  );
}
