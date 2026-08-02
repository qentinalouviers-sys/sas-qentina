'use client';

/**
 * ui.tsx — Composants d'interface partagés par toutes les pages.
 * Avant : chaque page redéfinissait ses cartes KPI, tooltips, modales…
 * avec des dizaines de blocs de styles inline copiés-collés.
 */

import { ReactNode } from 'react';
import { ChevronUp, ChevronDown, X } from 'lucide-react';
import { AreaChart, Area, ResponsiveContainer } from 'recharts';
import { formatCurrency } from '@/lib/utils';
import type { PeriodFilter } from '@/lib/types';

// ─── Tooltip Recharts au format monétaire ────────────────────────────────────
export const CurrencyTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: 'white',
      border: '1px solid var(--border)',
      borderRadius: 10,
      padding: '10px 14px',
      boxShadow: 'var(--shadow-md)',
      fontSize: 13,
    }}>
      <div style={{ fontWeight: 700, marginBottom: 4, color: 'var(--text-primary)' }}>{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ color: p.color, display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <span>{p.name}</span>
          <strong>{formatCurrency(p.value)}</strong>
        </div>
      ))}
    </div>
  );
};

// ─── Mini courbe de tendance ─────────────────────────────────────────────────
export const SparkLine = ({ data, color }: { data: number[]; color: string }) => {
  const pts = data.map((v, i) => ({ i, v }));
  const gradientId = `sg-${color.replace('#', '')}`;
  return (
    <ResponsiveContainer width="100%" height={48}>
      <AreaChart data={pts} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.25} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone" dataKey="v"
          stroke={color} strokeWidth={2}
          fill={`url(#${gradientId})`}
          dot={false} isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
};

// ─── Carte KPI ───────────────────────────────────────────────────────────────
export interface KpiCardProps {
  label: string;
  value: string;
  subValue?: string;
  icon?: ReactNode;
  accentColor: string;
  spark?: number[];
  trend?: number; // % de variation vs période précédente
  badge?: { text: string; type: 'good' | 'bad' | 'neutral' };
  onClick?: () => void;
}

export const KpiCard = ({ label, value, subValue, icon, accentColor, spark, trend, badge, onClick }: KpiCardProps) => {
  const trendUp = trend !== undefined && trend >= 0;
  return (
    <div className="kpi-v2" onClick={onClick} style={{ cursor: onClick ? 'pointer' : 'default' }}>
      <div className="kpi-v2-accent" style={{ background: accentColor }} />
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginTop: 4 }}>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
          <span className="kpi-v2-label">{label}</span>
          <span className="kpi-v2-value">{value}</span>
          {subValue && <span className="kpi-v2-sub">{subValue}</span>}
        </div>
        {icon && (
          <div className="kpi-v2-icon" style={{ background: `${accentColor}18`, color: accentColor }}>
            {icon}
          </div>
        )}
      </div>

      {spark && spark.length > 1 && (
        <div style={{ marginTop: 4, marginLeft: -4, marginRight: -4 }}>
          <SparkLine data={spark} color={accentColor} />
        </div>
      )}

      {(trend !== undefined || badge) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2, gap: 6 }}>
          {trend !== undefined ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600,
              color: trendUp ? 'var(--green)' : 'var(--red)',
            }}>
              {trendUp ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {Math.abs(trend).toFixed(1)}% vs période préc.
            </div>
          ) : <div />}
          {badge && (
            <span style={{
              fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 100, whiteSpace: 'nowrap',
              background: badge.type === 'good' ? 'var(--green-light)' : badge.type === 'bad' ? 'var(--red-light)' : 'var(--cream-dark)',
              color: badge.type === 'good' ? 'var(--green)' : badge.type === 'bad' ? 'var(--red)' : 'var(--text-secondary)',
            }}>
              {badge.text}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

// ─── En-tête de section ──────────────────────────────────────────────────────
export const SectionHeader = ({ title, subtitle, icon }: { title: string; subtitle?: string; icon?: ReactNode }) => (
  <div className="section-header">
    {icon && <div style={{ color: 'var(--teal)', display: 'flex', flexShrink: 0 }}>{icon}</div>}
    <div>
      <div className="section-header-title">{title}</div>
      {subtitle && <div className="section-header-sub">{subtitle}</div>}
    </div>
  </div>
);

// ─── Carte blanche avec titre (pour les graphiques) ─────────────────────────
export const ChartCard = ({
  title, subtitle, headerRight, children, style,
}: {
  title: string;
  subtitle?: string;
  headerRight?: ReactNode;
  children: ReactNode;
  style?: React.CSSProperties;
}) => (
  <div className="chart-card" style={style}>
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14, gap: 10, flexWrap: 'wrap' }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{subtitle}</div>}
      </div>
      {headerRight}
    </div>
    {children}
  </div>
);

// ─── Modale ──────────────────────────────────────────────────────────────────
export const Modal = ({
  title, onClose, children, footer, large,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  large?: boolean;
}) => (
  <div className="modal-overlay" onClick={onClose}>
    <div className={`modal ${large ? 'modal-lg' : ''}`} onClick={e => e.stopPropagation()}>
      <div className="modal-header">
        <h3 className="modal-title">{title}</h3>
        <button className="modal-close" onClick={onClose} aria-label="Fermer">
          <X size={18} />
        </button>
      </div>
      {children}
      {footer && <div className="modal-footer">{footer}</div>}
    </div>
  </div>
);

// ─── États vides & chargement ────────────────────────────────────────────────
export const EmptyState = ({ icon, text }: { icon?: ReactNode; text: string }) => (
  <div className="empty-state">
    {icon}
    <p>{text}</p>
  </div>
);

export const LoadingPage = ({ text = 'Chargement…' }: { text?: string }) => (
  <div className="loading-page">
    <div className="spinner" style={{ width: 36, height: 36 }} />
    <p>{text}</p>
  </div>
);

// ─── Sélecteur de période ────────────────────────────────────────────────────
const PERIOD_LABELS: Record<string, string> = {
  today: "Aujourd'hui",
  week: 'Semaine',
  month: 'Mois',
  year: 'Année',
};

export const PeriodSelector = ({
  value, onChange, periods = ['today', 'week', 'month', 'year'],
}: {
  value: PeriodFilter;
  onChange: (p: PeriodFilter) => void;
  periods?: PeriodFilter[];
}) => (
  <div className="period-selector">
    {periods.map(p => (
      <button key={p} className={`period-btn ${value === p ? 'active' : ''}`} onClick={() => onChange(p)}>
        {PERIOD_LABELS[p] || p}
      </button>
    ))}
  </div>
);

// ─── Bascule %/€ (utilisée par le simulateur du dashboard) ──────────────────
export const UnitToggle = ({
  mode, onChange,
}: {
  mode: 'percent' | 'euro';
  onChange: (m: 'percent' | 'euro') => void;
}) => (
  <div style={{ display: 'flex', gap: 4, background: 'var(--border-light)', padding: 2, borderRadius: 6 }}>
    {(['percent', 'euro'] as const).map(m => (
      <button
        key={m}
        type="button"
        className={`unit-toggle-btn ${mode === m ? 'active' : ''}`}
        onClick={() => onChange(m)}
      >
        {m === 'percent' ? '%' : '€'}
      </button>
    ))}
  </div>
);
