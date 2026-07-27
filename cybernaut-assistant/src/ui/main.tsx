import { type FlueConversationPart, FlueProvider, useFlueAgent } from '@flue/react';
import { createFlueClient } from '@flue/sdk';
import { type FormEvent, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const client = createFlueClient({ baseUrl: '/ai/api' });

// —— 会话持久化：localStorage 存会话列表 + 当前活跃会话，刷新不丢 ——
type Session = { id: string; title: string; ts: number };
const LS_KEY = 'cybernaut-assistant-sessions';
const LS_ACTIVE = 'cybernaut-assistant-active';

function newId() {
  // 安全上下文才有 crypto.randomUUID；HTTP 下降级
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* fall through */ }
  return 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}
function loadSessions(): Session[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}
function saveSessions(list: Session[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

function App() {
  const [sessions, setSessions] = useState<Session[]>(() => loadSessions());
  const [activeId, setActiveId] = useState<string>(() => {
    const saved = localStorage.getItem(LS_ACTIVE);
    if (saved) return saved;
    const list = loadSessions();
    if (list.length) return list[0].id;
    const id = newId();
    return id;
  });
  const [input, setInput] = useState('');
  const [err, setErr] = useState<string>();
  const agent = useFlueAgent({ name: 'assistant', id: activeId });

  // 持久化活跃会话
  useEffect(() => { localStorage.setItem(LS_ACTIVE, activeId); }, [activeId]);

  // 确保当前活跃会话在列表里（首次进入 / 新建）
  useEffect(() => {
    setSessions((prev) => {
      if (prev.some((s) => s.id === activeId)) return prev;
      const next = [{ id: activeId, title: '新会话', ts: Date.now() }, ...prev];
      saveSessions(next);
      return next;
    });
  }, [activeId]);

  // 用第一条用户消息自动命名会话标题
  useEffect(() => {
    const firstUser = agent.messages.find((m) => m.role === 'user');
    if (!firstUser) return;
    const text = firstUser.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('').trim();
    if (!text) return;
    setSessions((prev) => {
      const cur = prev.find((s) => s.id === activeId);
      if (!cur || (cur.title !== '新会话' && cur.title.length > 0)) return prev;
      const next = prev.map((s) => s.id === activeId ? { ...s, title: text.slice(0, 18) } : s);
      saveSessions(next);
      return next;
    });
  }, [agent.messages, activeId]);

  function newSession() {
    // 新建总是创建一个新会话并切过去（标题带序号以便区分），保证点击一定有可见反馈。
    const n = sessions.filter((s) => s.title.startsWith('新会话')).length;
    const title = n === 0 ? '新会话' : `新会话 ${n + 1}`;
    const id = newId();
    const next = [{ id, title, ts: Date.now() }, ...sessions];
    saveSessions(next);
    setSessions(next);
    setActiveId(id);
    setInput('');
    setErr(undefined);
  }

  function deleteSession(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    const next = sessions.filter((s) => s.id !== id);
    saveSessions(next);
    setSessions(next);
    if (id === activeId) {
      if (next.length) setActiveId(next[0].id);
      else newSession();
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = input.trim();
    if (!message) return;
    setInput('');
    setErr(undefined);
    try {
      await agent.sendMessage(message);
    } catch (error) {
      setInput(message);
      setErr(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <button className="new-session" onClick={newSession}>＋ 新建会话</button>
        <div className="session-list">
          {sessions.length === 0 && <p className="empty small">暂无会话</p>}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-item ${s.id === activeId ? 'active' : ''}`}
              onClick={() => { setActiveId(s.id); setErr(undefined); }}
            >
              <span className="session-title">{s.title || '新会话'}</span>
              <button className="session-del" onClick={(e) => deleteSession(s.id, e)} aria-label="删除">×</button>
            </div>
          ))}
        </div>
      </aside>

      <main>
        <header>
          <h1>赛智伯乐 · AI 投研助手</h1>
          <span className={`status ${agent.status}`}>{agent.status}</span>
        </header>
        <div className="messages" aria-live="polite">
          {agent.messages.length === 0 && <p className="empty">发条消息开始对话。我能检索项目资料、分析风险、处理文件、生成投委会 PPT。</p>}
          {agent.messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <strong>{message.role === 'user' ? '你' : '助手'}</strong>
              {message.parts.map((part, i) => (
                <MessagePart key={i} part={part} />
              ))}
            </article>
          ))}
        </div>
        <form onSubmit={submit}>
          <input
            aria-label="消息"
            autoComplete="off"
            onChange={(event) => setInput(event.target.value)}
            placeholder="向 AI 投研助手提问…"
            value={input}
          />
          <button disabled={!input.trim()} type="submit">发送</button>
        </form>
        {(err || agent.error) && <p className="error">{err ?? agent.error?.message}</p>}
      </main>
    </div>
  );
}

function MessagePart({ part }: { part: FlueConversationPart }) {
  if (part.type === 'text') return <p>{part.text}</p>;
  if (part.type === 'reasoning')
    return (
      <details>
        <summary>思考过程</summary>
        {part.text}
      </details>
    );
  if (part.type === 'file') {
    if (!part.url) return <span>附件（{part.mediaType}）</span>;
    return part.mediaType.startsWith('image/') ? (
      <img src={part.url} alt={part.filename ?? 'attachment'} style={{ maxWidth: 320 }} />
    ) : (
      <a href={part.url}>{part.filename ?? '附件'}</a>
    );
  }
  return (
    <pre className="tool">🔧 {part.toolName}: {part.state}</pre>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing React root element');
createRoot(root).render(
  <FlueProvider client={client}>
    <App />
  </FlueProvider>,
);
