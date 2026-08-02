'use client';

import { useState, useEffect } from 'react';
import { Loader2, Activity } from 'lucide-react';

interface HealthData {
  status: 'green' | 'orange' | 'red';
  message: string;
  latency_ms?: number;
}

export default function ClaudeStatusIndicator() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/scanner/health');
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (data.ai) {
        setHealth(data.ai);
      } else {
        setHealth({ status: 'red', message: 'Hors ligne' });
      }
    } catch {
      setHealth({ status: 'red', message: 'Indisponible' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    // 5 min : le statut IA change rarement, inutile de marteler l'API
    const interval = setInterval(fetchStatus, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const colorMap = {
    green: { color: '#2D8F5E', bg: 'rgba(45, 143, 94, 0.1)', text: 'En ligne' },
    orange: { color: '#E89B3E', bg: 'rgba(232, 155, 62, 0.1)', text: 'Ralenti' },
    red: { color: '#D94F4F', bg: 'rgba(217, 79, 79, 0.1)', text: 'Saturé' },
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted, #6B7280)', background: 'var(--cream-light, #F9FAFB)', padding: '5px 10px', borderRadius: 100, border: '1px solid var(--border-light, #E5E7EB)' }}>
        <Loader2 size={10} style={{ animation: 'spin 1s linear infinite' }} />
        <span>Claude IA : Vérification...</span>
      </div>
    );
  }

  const current = health ? colorMap[health.status] : colorMap.red;
  const label = health ? health.message : 'Hors ligne';

  return (
    <div
      title={health?.latency_ms ? `Latence : ${health.latency_ms}ms` : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--text-secondary, #4B5563)',
        background: current.bg,
        padding: '5px 10px',
        borderRadius: 100,
        border: `1px solid ${current.color}35`,
        transition: 'all 0.2s',
      }}
    >
      <div style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: current.color,
        boxShadow: `0 0 6px ${current.color}`,
        animation: health?.status === 'red' ? 'pulse 1.5s ease-in-out infinite' : undefined,
      }} />
      <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.3px', color: 'var(--text-muted)' }}>Claude IA :</span>
      <span style={{ color: current.color }}>{label}</span>
    </div>
  );
}
