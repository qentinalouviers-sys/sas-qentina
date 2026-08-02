'use client';

import { useState, useEffect, useCallback } from 'react';
import { Star, MessageCircle, Send, Flame, Copy } from 'lucide-react';
import { formatDate } from '@/lib/utils';

export default function AvisPage() {
  const [reviews, setReviews] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [sendingReply, setSendingReply] = useState(false);

  const fetchReviews = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/google/reviews');
      const data = await res.json();
      if (data.code === 'AUTH_REQUIRED') {
        setNeedsAuth(true);
      } else if (data.reviews) {
        setReviews(data.reviews);
      }
    } catch (error) {
      console.error(error);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchReviews(); }, [fetchReviews]);

  const handleReply = async (reviewName: string) => {
    if (!replyText.trim()) return;
    setSendingReply(true);
    try {
      const res = await fetch('/api/google/reviews/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewName, replyText })
      });
      const data = await res.json();
      if (data.success) {
        setReplyingTo(null);
        setReplyText('');
        fetchReviews(); // Refresh to show the new reply
      } else {
        alert("Erreur: " + data.error);
      }
    } catch (e) {
      alert("Erreur d'envoi");
    }
    setSendingReply(false);
  };

  const generateAIReply = async (review: any) => {
    setReplyText('Génération en cours...');
    try {
      const res = await fetch('/api/ai/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          reviewComment: review.comment || '', 
          rating: review.starRating, 
          reviewerName: review.reviewer?.displayName 
        })
      });
      const data = await res.json();
      if (data.reply) {
        setReplyText(data.reply);
      } else {
        setReplyText("Erreur lors de la génération. Veuillez écrire votre réponse.");
      }
    } catch (e) {
      setReplyText('');
      alert("Erreur de connexion à l'IA");
    }
  };

  if (loading) return <div className="loading-page"><div className="spinner" style={{ width: 40, height: 40 }} /></div>;

  if (needsAuth) {
    return (
      <div className="page-body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Star size={48} color="var(--orange)" style={{ marginBottom: 16 }} />
        <h2 style={{ marginBottom: 8 }}>Connectez Google My Business</h2>
        <p style={{ color: 'var(--text-muted)', marginBottom: 24, textAlign: 'center', maxWidth: 400 }}>
          Pour lire et répondre à vos avis Google directement depuis Qentina, vous devez autoriser l'accès à votre compte Google My Business.
        </p>
        <a href="/api/google/auth" className="btn btn-primary" style={{ background: '#4285F4', borderColor: '#4285F4', color: 'white' }}>
          Connecter avec Google
        </a>
      </div>
    );
  }

  return (
    <>
      <div className="page-header">
        <h2>Avis Google</h2>
        <div className="page-header-actions">
          <button className="btn btn-secondary" onClick={fetchReviews}>Actualiser</button>
        </div>
      </div>
      <div className="page-body">
        {reviews.length === 0 ? (
          <div className="empty-state"><MessageCircle size={48} /><p>Aucun avis trouvé.</p></div>
        ) : (
          <div style={{ display: 'grid', gap: 16 }}>
            {reviews.map((r: any) => (
              <div key={r.name} className="card" style={{ padding: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--border-color)', backgroundImage: `url(${r.reviewer?.profilePhotoUrl})`, backgroundSize: 'cover' }} />
                    <div>
                      <div style={{ fontWeight: 600 }}>{r.reviewer?.displayName}</div>
                      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{formatDate(r.createTime)}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 2, color: 'var(--orange)' }}>
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Star key={i} size={16} fill={i < (r.starRating === 'FIVE' ? 5 : r.starRating === 'FOUR' ? 4 : r.starRating === 'THREE' ? 3 : r.starRating === 'TWO' ? 2 : 1) ? 'currentColor' : 'transparent'} />
                    ))}
                  </div>
                </div>
                
                <p style={{ margin: '12px 0', lineHeight: 1.5 }}>{r.comment}</p>
                
                {r.reviewReply ? (
                  <div style={{ background: 'var(--bg-secondary)', padding: 16, borderRadius: 8, marginTop: 16, borderLeft: '3px solid var(--teal)' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8 }}>Votre réponse ({formatDate(r.reviewReply.updateTime)}) :</div>
                    <p style={{ margin: 0, fontSize: 14 }}>{r.reviewReply.comment}</p>
                  </div>
                ) : (
                  <div style={{ marginTop: 16 }}>
                    {replyingTo === r.name ? (
                      <div style={{ background: 'var(--bg-secondary)', padding: 16, borderRadius: 8 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>Rédiger une réponse</span>
                          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--orange)', fontSize: 12 }} onClick={() => generateAIReply(r)}><Flame size={14} style={{ marginRight: 4 }} /> Générer via IA</button>
                        </div>
                        <textarea 
                          className="form-input" 
                          style={{ width: '100%', minHeight: 80, marginBottom: 12 }} 
                          value={replyText} 
                          onChange={e => setReplyText(e.target.value)} 
                          placeholder="Votre réponse..."
                        />
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                          <button className="btn btn-ghost btn-sm" onClick={() => { setReplyingTo(null); setReplyText(''); }}>Annuler</button>
                          
                          {replyText && (
                            <button className="btn btn-secondary btn-sm" onClick={() => {
                              navigator.clipboard.writeText(replyText);
                              alert("Réponse copiée ! Vous pouvez maintenant la coller sur Google.");
                            }}>
                              <Copy size={14} /> Copier
                            </button>
                          )}

                          <button className="btn btn-primary btn-sm" disabled={sendingReply || !replyText.trim()} onClick={() => handleReply(r.name)}>
                            {sendingReply ? 'Envoi...' : <><Send size={14} /> Envoyer</>}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button className="btn btn-secondary btn-sm" onClick={() => { setReplyingTo(r.name); setReplyText(''); }}>Répondre</button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
