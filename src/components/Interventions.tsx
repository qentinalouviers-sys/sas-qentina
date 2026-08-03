'use client';

/**
 * Interventions.tsx — Le module « À faire » de la page d'accueil.
 *
 * Il répond à une seule question : **est-ce que je peux croire les chiffres
 * affichés en dessous ?** Tant qu'une intervention critique est listée, la
 * réponse est non, et le module le dit avant tout le reste.
 *
 * Chaque ligne se déplie sur trois choses, dans cet ordre :
 *   1. ce que le chiffre faux fait croire (l'enjeu),
 *   2. ce qu'il faut faire (une seule action, à l'impératif),
 *   3. le lien vers l'écran où la faire.
 *
 * Les interventions critiques sont dépliées d'office : une alerte qu'il faut
 * cliquer pour comprendre n'est pas lue.
 */

import { useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle, AlertCircle, HelpCircle, CheckCircle2,
  ChevronDown, ChevronRight, ArrowRight, ListChecks,
} from 'lucide-react';
import type { Intervention, Severity } from '@/lib/interventions';

const STYLES: Record<Severity, {
  label: string;
  color: string;
  background: string;
  border: string;
  Icon: typeof AlertTriangle;
}> = {
  critique: {
    label: 'Chiffres faux',
    color: 'var(--red)',
    background: 'var(--red-light)',
    border: 'rgba(217, 79, 79, 0.25)',
    Icon: AlertTriangle,
  },
  important: {
    label: 'À corriger',
    color: '#9A6B1F',
    background: 'var(--orange-light)',
    border: 'rgba(232, 155, 62, 0.25)',
    Icon: AlertCircle,
  },
  a_verifier: {
    label: 'À vérifier',
    color: 'var(--text-secondary)',
    background: 'var(--cream-light)',
    border: 'var(--border)',
    Icon: HelpCircle,
  },
};

function Row({ item, defaultOpen }: { item: Intervention; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const s = STYLES[item.severity];
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div
      style={{
        background: s.background,
        border: `1px solid ${s.border}`,
        borderLeft: `4px solid ${s.color}`,
        borderRadius: 'var(--radius-sm)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 14px', background: 'transparent', border: 'none',
          textAlign: 'left', cursor: 'pointer', color: s.color,
          font: 'inherit', minHeight: 44,
        }}
      >
        <s.Icon size={16} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: 13.5, fontWeight: 700, lineHeight: 1.35 }}>
          {item.title}
        </span>
        <span
          style={{
            flexShrink: 0, fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3,
            textTransform: 'uppercase', opacity: 0.75, whiteSpace: 'nowrap',
          }}
        >
          {s.label}
        </span>
        <Chevron size={16} style={{ flexShrink: 0, opacity: 0.7 }} />
      </button>

      {open && (
        <div style={{ padding: '0 14px 14px 40px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)', margin: 0 }}>
            {item.impact}
          </p>
          <p style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-primary)', margin: 0, fontWeight: 600 }}>
            → {item.action}
          </p>
          <Link
            href={item.href}
            className="btn btn-sm"
            style={{
              alignSelf: 'flex-start', background: s.color, color: 'white',
              borderColor: s.color, textDecoration: 'none',
            }}
          >
            {item.hrefLabel} <ArrowRight size={14} />
          </Link>
        </div>
      )}
    </div>
  );
}

/**
 * @param items      interventions déjà triées par `detectInterventions`
 * @param periodLabel période analysée, affichée en sous-titre
 */
export function InterventionsCard({
  items, periodLabel,
}: { items: Intervention[]; periodLabel?: string }) {
  const critiques = items.filter(i => i.severity === 'critique').length;

  if (items.length === 0) {
    return (
      <div
        className="card"
        style={{
          marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10,
          borderLeft: '4px solid var(--green)',
        }}
      >
        <CheckCircle2 size={18} style={{ color: 'var(--green)', flexShrink: 0 }} />
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--green)' }}>
            Rien à corriger — les chiffres ci-dessous sont exploitables
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            Caisse synchronisée, TVA ventilée, dépenses justifiées.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="card"
      style={{
        marginBottom: 20,
        borderColor: critiques > 0 ? 'rgba(217, 79, 79, 0.35)' : 'var(--border)',
      }}
    >
      <div className="card-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Le signal d'alerte : il ne pulse que si un chiffre est faux. */}
          <span
            style={{
              position: 'relative', display: 'inline-flex',
              alignItems: 'center', justifyContent: 'center',
              width: 30, height: 30, borderRadius: 8,
              background: critiques > 0 ? 'var(--red-light)' : 'var(--cream-dark)',
              color: critiques > 0 ? 'var(--red)' : 'var(--text-secondary)',
              flexShrink: 0,
            }}
          >
            <ListChecks size={17} />
            {critiques > 0 && (
              <span
                aria-hidden
                style={{
                  position: 'absolute', top: -3, right: -3,
                  width: 10, height: 10, borderRadius: '50%',
                  background: 'var(--red)', border: '2px solid white',
                  animation: 'pulse 1.8s ease-in-out infinite',
                }}
              />
            )}
          </span>
          <div>
            <div className="card-title">
              À faire — {items.length} intervention{items.length > 1 ? 's' : ''}
            </div>
            <div className="card-subtitle">
              {critiques > 0
                ? `${critiques} bloque${critiques > 1 ? 'nt' : ''} la fiabilité des chiffres ci-dessous`
                : 'Aucun chiffre faux, mais des points à reprendre'}
              {periodLabel ? ` · ${periodLabel}` : ''}
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map(item => (
          <Row key={item.id} item={item} defaultOpen={item.severity === 'critique'} />
        ))}
      </div>
    </div>
  );
}
