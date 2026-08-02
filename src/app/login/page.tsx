'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) {
      setError('Email ou mot de passe incorrect.');
      setLoading(false);
    } else {
      router.push('/dashboard');
      router.refresh();
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>QENTINA</h1>
        <p>Connectez-vous à votre espace de pilotage</p>
        {error && <div className="alert alert-danger" style={{ marginBottom: 16, textAlign: 'left' }}>{error}</div>}
        <form onSubmit={handleLogin}>
          <div className="form-group">
            <label className="form-label">Email</label>
            <input
              type="email"
              className="form-input"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="votre@email.com"
              required
              id="login-email"
            />
          </div>
          <div className="form-group">
            <label className="form-label">Mot de passe</label>
            <input
              type="password"
              className="form-input"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              id="login-password"
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={loading} style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}>
            {loading ? <span className="spinner" /> : 'Se connecter'}
          </button>
        </form>
        <p style={{ marginTop: 20, fontSize: 12, color: 'var(--text-muted)' }}>
          Pizzeria Napolitaine au feu de bois — Louviers
        </p>
      </div>
    </div>
  );
}
