'use client';

import { useState, useRef, useEffect } from 'react';
import { Flame, Send, User } from 'lucide-react';

type Message = {
  role: 'user' | 'assistant';
  content: string;
  isError?: boolean;
};

const GREETING: Message = {
  role: 'assistant',
  content: "Ciao ! Je suis Fuego 🔥, ton assistant IA spécialisé QENTINA. J'ai accès en direct à tes chiffres (CA, Food Cost, Achats...). Comment puis-je t'aider à piloter ton restaurant aujourd'hui ?",
};

const STORAGE_KEY = 'fuego_chat';
const MAX_HISTORY = 20; // messages envoyés à l'API (contient le coût en tokens)

/** Pastille ronde de l'interlocuteur. */
function Avatar({ role }: { role: 'user' | 'assistant' }) {
  return (
    <div style={{
      background: role === 'assistant' ? 'var(--orange)' : 'var(--teal)',
      color: 'white',
      borderRadius: '50%',
      padding: 8,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    }}>
      {role === 'assistant' ? <Flame size={18} /> : <User size={18} />}
    </div>
  );
}

export default function FuegoPage() {
  const [messages, setMessages] = useState<Message[]>([GREETING]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const endOfMessagesRef = useRef<HTMLDivElement>(null);

  // Restaure la conversation (survit à la navigation entre pages)
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) setMessages(parsed);
      }
    } catch {
      // conversation illisible → on repart de l'accueil
    }
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch {
      // quota dépassé — sans conséquence sur la conversation en cours
    }
  }, [messages]);

  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const newMessages: Message[] = [...messages, { role: 'user', content: input }];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    try {
      // L'API exige que le premier message soit de l'utilisateur : on retire le
      // message d'accueil et les messages d'erreur, puis on borne l'historique.
      const sendHistory = newMessages
        .filter(m => m.content && !m.isError)
        .map(m => ({ role: m.role, content: m.content }))
        .slice(-MAX_HISTORY);
      while (sendHistory.length > 0 && sendHistory[0].role === 'assistant') {
        sendHistory.shift();
      }

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: sendHistory }),
      });
      const data = await res.json();

      if (data.reply) {
        setMessages(prev => [...prev, { role: 'assistant', content: data.reply }]);
      } else {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: "🔥 Désolé, j'ai eu un coup de chaud ! Une erreur est survenue.",
          isError: true,
        }]);
      }
    } catch (e) {
      console.error('Fuego chat error:', e);
      setMessages(prev => [...prev, { role: 'assistant', content: '🔥 Erreur de réseau.', isError: true }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="page-header" style={{ borderBottom: 'none', paddingBottom: 0 }}>
        <h2>
          <Flame color="var(--orange)" style={{ verticalAlign: 'middle', marginRight: 8, paddingBottom: 4 }} />
          Fuego IA
        </h2>
      </div>

      {/* La hauteur tient compte de la barre de navigation basse en mobile,
          sinon le champ de saisie passait dessous et devenait inaccessible. */}
      <style>{`
        .fuego-body {
          display: flex;
          flex-direction: column;
          height: calc(100dvh - 120px);
          padding: 0 24px 24px;
        }
        @media (max-width: 768px) {
          .fuego-body {
            height: calc(100dvh - 60px - var(--bottom-nav-height) - var(--safe-bottom));
            padding: 0 14px 14px;
          }
        }
      `}</style>

      <div className="page-body fuego-body">
        <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 0 }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {messages.map((m, i) => (
              <div key={i} style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '80%',
                flexDirection: m.role === 'user' ? 'row-reverse' : 'row',
              }}>
                <Avatar role={m.role} />
                <div style={{
                  background: m.role === 'user' ? 'var(--teal)' : 'var(--cream-light)',
                  color: m.role === 'user' ? 'white' : 'var(--text-primary)',
                  border: m.role === 'user' ? 'none' : '1px solid var(--border-light)',
                  padding: '12px 16px',
                  borderRadius: 12,
                  borderTopRightRadius: m.role === 'user' ? 0 : 12,
                  borderTopLeftRadius: m.role === 'assistant' ? 0 : 12,
                  lineHeight: 1.5,
                  fontSize: 14,
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                }}>
                  {m.content}
                </div>
              </div>
            ))}

            {loading && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <Avatar role="assistant" />
                <div style={{
                  background: 'var(--cream-light)',
                  border: '1px solid var(--border-light)',
                  padding: '12px 16px',
                  borderRadius: 12,
                  borderTopLeftRadius: 0,
                  fontStyle: 'italic',
                  color: 'var(--text-muted)',
                }}>
                  Fuego réfléchit... 🔥
                </div>
              </div>
            )}
            <div ref={endOfMessagesRef} />
          </div>

          <div style={{ padding: 16, borderTop: '1px solid var(--border-light)', background: 'white' }}>
            <form onSubmit={sendMessage} style={{ display: 'flex', gap: 10 }}>
              <input
                type="text"
                className="form-input"
                style={{ flex: 1, minWidth: 0, borderRadius: 24, padding: '12px 18px', fontSize: 16 }}
                placeholder="Pose-moi une question sur ton business..."
                value={input}
                onChange={e => setInput(e.target.value)}
                disabled={loading}
              />
              <button
                type="submit"
                className="btn btn-primary"
                style={{ borderRadius: 24, padding: '0 20px', background: 'var(--orange)', borderColor: 'var(--orange)', flexShrink: 0 }}
                disabled={loading || !input.trim()}
                aria-label="Envoyer"
              >
                <Send size={18} />
              </button>
            </form>
          </div>
        </div>
      </div>
    </>
  );
}
