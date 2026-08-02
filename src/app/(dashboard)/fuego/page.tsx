'use client';

import { useState, useRef, useEffect } from 'react';
import { Flame, Send, Bot, User } from 'lucide-react';

type Message = {
  role: 'user' | 'assistant';
  content: string;
};

export default function FuegoPage() {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: 'Ciao ! Je suis Fuego 🔥, ton assistant IA spécialisé QENTINA. J\'ai accès en direct à tes chiffres (CA, Food Cost, Achats...). Comment puis-je t\'aider à piloter ton restaurant aujourd\'hui ?' }
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const endOfMessagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const newMessages = [...messages, { role: 'user' as const, content: input }];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    try {
      // Exclude the initial greeting if we want to save tokens, but it's fine for now
      // Or just map to the format expected by Anthropic API
      const apiMessages = newMessages.filter(m => m.content).map(m => ({
        role: m.role,
        content: m.content
      }));
      // The API route expects only user and assistant messages, not system in the messages array.
      // And the first message to the API must be from the user, but here our state has assistant first.
      // So let's slice off our initial greeting from the history sent to the API, or keep it if Anthropic supports it.
      // Wait, Anthropic requires the first message to be "user".
      let sendHistory = apiMessages;
      if (sendHistory[0].role === 'assistant') {
        sendHistory = sendHistory.slice(1);
      }

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: sendHistory })
      });
      const data = await res.json();
      
      if (data.reply) {
        setMessages(prev => [...prev, { role: 'assistant', content: data.reply }]);
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: '🔥 Désolé, j\'ai eu un coup de chaud ! Une erreur est survenue.' }]);
      }
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: '🔥 Erreur de réseau.' }]);
    }
    setLoading(false);
  };

  return (
    <>
      <div className="page-header" style={{ borderBottom: 'none', paddingBottom: 0 }}>
        <h2><Flame color="var(--orange)" style={{ verticalAlign: 'middle', marginRight: 8, paddingBottom: 4 }} /> Fuego IA</h2>
      </div>

      <div className="page-body" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)', padding: '0 24px 24px' }}>
        <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--surface)' }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {messages.map((m, i) => (
              <div key={i} style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '80%',
                flexDirection: m.role === 'user' ? 'row-reverse' : 'row'
              }}>
                <div style={{ 
                  background: m.role === 'assistant' ? 'var(--orange)' : 'var(--teal)', 
                  color: 'white', 
                  borderRadius: '50%', 
                  padding: 8,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0
                }}>
                  {m.role === 'assistant' ? <Flame size={18} /> : <User size={18} />}
                </div>
                <div style={{
                  background: m.role === 'user' ? 'var(--teal)' : 'var(--bg-color)',
                  color: m.role === 'user' ? 'white' : 'var(--text-primary)',
                  padding: '12px 16px',
                  borderRadius: '12px',
                  borderTopRightRadius: m.role === 'user' ? 0 : '12px',
                  borderTopLeftRadius: m.role === 'assistant' ? 0 : '12px',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
                  lineHeight: 1.5,
                  fontSize: 14,
                  whiteSpace: 'pre-wrap'
                }}>
                  {m.content}
                </div>
              </div>
            ))}
            {loading && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ background: 'var(--orange)', color: 'white', borderRadius: '50%', padding: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Flame size={18} />
                </div>
                <div style={{ background: 'var(--bg-color)', padding: '12px 16px', borderRadius: '12px', borderTopLeftRadius: 0, fontStyle: 'italic', color: 'var(--text-muted)' }}>
                  Fuego réfléchit... 🔥
                </div>
              </div>
            )}
            <div ref={endOfMessagesRef} />
          </div>
          
          <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border-light)', background: 'var(--surface)' }}>
            <form onSubmit={sendMessage} style={{ display: 'flex', gap: 12 }}>
              <input
                type="text"
                className="form-input"
                style={{ flex: 1, borderRadius: '24px', padding: '12px 20px', background: 'var(--bg-color)' }}
                placeholder="Pose-moi une question sur ton business..."
                value={input}
                onChange={e => setInput(e.target.value)}
                disabled={loading}
              />
              <button 
                type="submit" 
                className="btn btn-primary" 
                style={{ borderRadius: '24px', padding: '0 20px', background: 'var(--orange)', borderColor: 'var(--orange)' }}
                disabled={loading || !input.trim()}
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
