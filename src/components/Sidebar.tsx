'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, FileText, ChefHat, Package, ShoppingCart,
  Settings, LogOut, X, Landmark, Flame, TrendingUp,
  MoreHorizontal, Percent,
  ChevronDown, ChevronUp, ScanLine, Coins, Calculator, Car
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import { useState, useEffect }  from 'react';

// Nav items for mobile bottom bar
const primaryNav = [
  { href: '/dashboard', label: 'Accueil',    icon: LayoutDashboard },
  { href: '/ventes',    label: 'Ventes',     icon: ShoppingCart },
  { href: '/scanner',   label: 'Scanner',    icon: ScanLine },
  { href: '/banque',    label: 'Banque',     icon: Landmark },
  { href: '/fuego',     label: 'Fuego IA',   icon: Flame },
];

// Nav items for mobile "More" drawer
const secondaryNav = [
  { href: '/pnl',               label: 'P&L / Finance',     icon: TrendingUp },
  { href: '/tva',               label: 'TVA',                icon: Percent },
  { href: '/factures',          label: 'Factures',           icon: FileText },
  { href: '/cca',               label: 'Comptes Associés',   icon: Coins },
  { href: '/trajets',           label: 'Frais kilométriques', icon: Car },
  { href: '/stock',             label: 'Stock',              icon: Package },
  { href: '/fiches-techniques', label: 'Fiches techniques',  icon: ChefHat },
  { href: '/reglages',          label: 'Réglages',           icon: Settings },
];

// Collapsible categories for desktop sidebar
const navCategories = [
  {
    id: 'dashboards',
    label: 'Pilotage & IA',
    icon: LayoutDashboard,
    items: [
      { href: '/dashboard', label: 'Accueil',      icon: LayoutDashboard },
      { href: '/scanner',   label: 'Scanner IA',   icon: ScanLine },
      { href: '/fuego',     label: 'Fuego IA',     icon: Flame },
    ]
  },
  {
    id: 'ventes',
    label: 'Activité Ventes',
    icon: ShoppingCart,
    items: [
      { href: '/ventes',           label: 'Ventes Square',    icon: ShoppingCart },
    ]
  },
  {
    id: 'operations',
    label: 'Gestion Opérations',
    icon: Package,
    items: [
      { href: '/stock',             label: 'Stock',             icon: Package },
      { href: '/fiches-techniques', label: 'Fiches techniques', icon: ChefHat },
    ]
  },
  {
    id: 'finance',
    label: 'Finance & Compta',
    icon: TrendingUp,
    items: [
      { href: '/pnl',      label: 'P&L / Finance', icon: TrendingUp },
      { href: '/factures', label: 'Factures',      icon: FileText },
      { href: '/banque',   label: 'Banque',        icon: Landmark },
      { href: '/cca',      label: 'Comptes Associés', icon: Coins },
      { href: '/trajets',  label: 'Frais kilométriques', icon: Car },
      { href: '/tva',      label: 'TVA',           icon: Percent },
    ]
  },
  {
    id: 'settings',
    label: 'Configuration',
    icon: Settings,
    items: [
      { href: '/reglages', label: 'Réglages', icon: Settings },
    ]
  }
];

// Finance-only categories for the comptable role
const financeCategory = [
  {
    id: 'finance',
    label: 'Finance & Compta',
    icon: TrendingUp,
    items: [
      { href: '/pnl',      label: 'P&L / Finance',     icon: TrendingUp },
      { href: '/factures', label: 'Factures',           icon: FileText },
      { href: '/banque',   label: 'Banque',             icon: Landmark },
      { href: '/cca',      label: 'Comptes Associés',   icon: Coins },
      { href: '/trajets',  label: 'Frais kilométriques', icon: Car },
      { href: '/tva',      label: 'TVA',                icon: Percent },
    ]
  },
];

export default function Sidebar({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [userRole, setUserRole] = useState<string | null>(null);
  
  // Manage accordion states
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});

  // Fetch user role
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }: { data: { user: { user_metadata?: { role?: string } } | null } }) => {
      const role = data.user?.user_metadata?.role ?? null;
      setUserRole(role);
      // Auto-expand finance category for comptable
      if (role === 'comptable') {
        setExpandedCategories({ finance: true });
      }
    });
  }, []);

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
  };

  const isActive = (href: string) => pathname.startsWith(href);

  // Choose visible categories based on role
  const visibleCategories = userRole === 'comptable' ? financeCategory : navCategories;

  // Auto-expand active category on load / path change
  useEffect(() => {
    const updated: Record<string, boolean> = { ...expandedCategories };
    let hasChanges = false;
    visibleCategories.forEach(cat => {
      if (cat.items.some(item => pathname.startsWith(item.href)) && !updated[cat.id]) {
        updated[cat.id] = true;
        hasChanges = true;
      }
    });
    if (hasChanges) {
      setExpandedCategories(updated);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, userRole]);

  const toggleCategory = (id: string) => {
    setExpandedCategories(prev => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <>
      {/* ══ Overlay (mobile sidebar) ══════════════════════════════════════ */}
      <div
        className={`sidebar-overlay ${isOpen ? 'open' : ''}`}
        onClick={onClose}
      />

      {/* ══ Desktop Sidebar ════════════════════════════════════════════════ */}
      <aside className={`sidebar ${isOpen ? 'open' : ''}`}>
        {/* Logo */}
        <div className="sidebar-logo">
          <div style={{ flex: 1 }}>
            <h1>QENTINA</h1>
            <span>{userRole === 'comptable' ? 'Espace Comptable' : 'Pilotage Restaurateur'}</span>
          </div>
          <button
            className="modal-close"
            onClick={onClose}
            style={{ display: isOpen ? 'flex' : 'none' }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Categorized and Collapsible Nav */}
        <nav className="sidebar-nav" style={{ padding: '14px 10px' }}>
          {visibleCategories.map(cat => {
            const isCatActive = cat.items.some(item => isActive(item.href));
            const isExpanded = !!expandedCategories[cat.id];
            
            return (
              <div key={cat.id} style={{ marginBottom: 6 }}>
                {/* Accordion header button */}
                <button
                  className="nav-category-header"
                  onClick={() => toggleCategory(cat.id)}
                  style={{
                    color: isCatActive ? 'var(--teal)' : 'var(--text-primary)'
                  }}
                >
                  <span className="nav-category-title-wrapper">
                    <cat.icon size={18} style={{ color: isCatActive ? 'var(--teal)' : 'var(--text-secondary)' }} />
                    {cat.label}
                  </span>
                  {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>

                {/* Submenu items list */}
                {isExpanded && (
                  <div className="nav-subcategory-list">
                    {cat.items.map(item => (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={`nav-subcategory-item ${isActive(item.href) ? 'active' : ''}`}
                        onClick={onClose}
                      >
                        <item.icon size={16} />
                        {item.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="sidebar-footer">
          <button
            className="nav-item"
            onClick={handleLogout}
            style={{ justifyContent: 'center', color: 'var(--text-muted)' }}
          >
            <LogOut size={16} />
            Déconnexion
          </button>
          <div style={{ marginTop: 8, fontSize: 10 }}>© 2026 QENTINA</div>
        </div>
      </aside>

      {/* ══ Bottom Navigation Bar (Mobile Only) ════════════════════════════ */}
      <nav className="bottom-nav" role="navigation" aria-label="Navigation principale">
        {userRole === 'comptable' ? (
          // Comptable simplified bottom nav
          <>
            {financeCategory[0].items.map(item => (
              <Link
                key={item.href}
                href={item.href}
                className={`bottom-nav-item ${isActive(item.href) ? 'active' : ''}`}
              >
                <item.icon size={22} />
                <span>{item.label}</span>
              </Link>
            ))}
          </>
        ) : (
          <>
            {primaryNav.map(item => (
              <Link
                key={item.href}
                href={item.href}
                className={`bottom-nav-item ${isActive(item.href) ? 'active' : ''}`}
              >
                <item.icon size={22} />
                <span>{item.label}</span>
              </Link>
            ))}

            {/* "Plus" button — opens drawer */}
            <button
              className={`bottom-nav-item ${drawerOpen || secondaryNav.some(n => isActive(n.href)) ? 'active' : ''}`}
              onClick={() => setDrawerOpen(v => !v)}
              aria-label="Plus de menus"
            >
              <MoreHorizontal size={22} />
              <span>Plus</span>
            </button>
          </>
        )}
      </nav>

      {/* ══ Mobile Drawer (secondary nav) — hidden for comptable ═══════════ */}
      {drawerOpen && userRole !== 'comptable' && (
        <>
          <div
            className="bottom-sheet-overlay"
            style={{ display: 'block' }}
            onClick={() => setDrawerOpen(false)}
          />
          <div className="bottom-sheet">
            <div className="bottom-sheet-handle" />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 8 }}>
              {secondaryNav.map(item => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`bottom-sheet-item ${isActive(item.href) ? 'active' : ''}`}
                  onClick={() => setDrawerOpen(false)}
                >
                  <item.icon size={20} />
                  <span style={{ fontSize: 14 }}>{item.label}</span>
                </Link>
              ))}
            </div>

            <button
              style={{
                width: '100%', padding: '13px', borderRadius: 10, marginTop: 4,
                border: '1px solid var(--border)', background: 'var(--cream-light)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: 8, fontSize: 14, fontWeight: 600, color: 'var(--text-muted)',
                cursor: 'pointer', fontFamily: 'inherit', touchAction: 'manipulation',
              }}
              onClick={() => { setDrawerOpen(false); handleLogout(); }}
            >
              <LogOut size={16} /> Déconnexion
            </button>
          </div>
        </>
      )}
    </>
  );
}
