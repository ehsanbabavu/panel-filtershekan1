import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { MessageCircle, RefreshCw, Send, Trash2 } from 'lucide-react';
import { readApiResponse } from './apiResponse';
import './telegram.css';

type Chat = {
  chatId: string;
  title: string;
  username: string;
  lastMessage: string;
  lastContentType: string;
  lastDeleted: boolean;
};

type ChatMessage = {
  chatId: string;
  messageId: string;
  senderName: string;
  text: string;
  direction: 'incoming' | 'outgoing';
  sentAt: string;
  contentType: string;
  deleted: boolean;
};

type Inbox = { botId: string | null; connected: boolean; chats: Chat[] };
type RequestOptions = {
  signal?: AbortSignal;
  query?: Record<string, string>;
  body?: unknown;
};
type TelegramRequest = <T>(action: string, options?: RequestOptions) => Promise<T>;

const emptyInbox: Inbox = { botId: null, connected: false, chats: [] };
const contentLabels: Record<string, string> = {
  photo: 'تصویر', video: 'ویدئو', voice: 'پیام صوتی', audio: 'فایل صوتی', document: 'فایل',
  sticker: 'استیکر', contact: 'مخاطب', location: 'موقعیت مکانی', poll: 'نظرسنجی',
};
const sentTime = new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'short' });

function messageText(text: string, contentType: string, deleted: boolean) {
  if (deleted) return 'پیام از تلگرام حذف شده است.';
  return text || (contentLabels[contentType] ?? 'پیام غیرمتنی');
}

function useTelegramPolling<T>(load: (signal: AbortSignal) => Promise<T>, initial: T) {
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const running = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    running.current?.abort();
    setRevision(current => current + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    running.current = controller;
    let timer: number;

    const poll = async () => {
      try {
        const result = await load(controller.signal);
        if (!controller.signal.aborted) {
          setData(result);
          setError('');
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'دریافت اطلاعات تلگرام انجام نشد.');
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = window.setTimeout(poll, 10000);
        }
      }
    };

    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [load, revision]);

  return { data, setData, loading, error, refresh };
}

function TelegramConversation({ chat, botId, connected, request, onChanged, onNotify }: {
  chat: Chat;
  botId: string;
  connected: boolean;
  request: TelegramRequest;
  onChanged: () => void;
  onNotify: (message: string) => void;
}) {
  const { chatId } = chat;
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const loadMessages = useCallback((signal: AbortSignal) =>
    request<ChatMessage[]>('chat', { signal, query: { botId, chatId } }), [request, botId, chatId]);
  const { data: messages, setData: setMessages, loading, error, refresh } = useTelegramPolling<ChatMessage[]>(loadMessages, []);
  const canReply = connected && !chatId.startsWith('-');
  const latestMessageId = messages.at(-1)?.messageId;

  useEffect(() => {
    const body = bodyRef.current;
    if (followMessages.current && body) body.scrollTop = body.scrollHeight;
  }, [latestMessageId]);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !canReply || busy) return;
    setBusy(true);
    setActionError('');
    try {
      const sent = await request<ChatMessage & { notice?: string }>('send', { body: { botId, chatId, message: text } });
      if (!sent.notice) refresh();
      followMessages.current = true;
      setMessages(current => [...current.filter(message => message.messageId !== sent.messageId), sent]);
      setDraft('');
      onChanged();
      if (sent.notice) onNotify(sent.notice);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'ارسال پیام انجام نشد.');
    } finally {
      setBusy(false);
    }
  }

  async function deleteIncoming(message: ChatMessage) {
    if (busy || !window.confirm('این پیام دریافتی از تلگرام حذف شود؟')) return;
    setBusy(true);
    setActionError('');
    try {
      await request('delete-message', { body: { botId, chatId, messageId: message.messageId } });
      refresh();
      setMessages(current => current.map(item => item.messageId === message.messageId ? { ...item, deleted: true, text: '' } : item));
      onChanged();
      onNotify('پیام از تلگرام حذف شد.');
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'حذف پیام انجام نشد.');
    } finally {
      setBusy(false);
    }
  }

  return <div className="chat-thread">
    <div className="chat-heading">
      <div className="support-avatar"><MessageCircle size={20}/></div>
      <div className="admin-chat-head">
        <h2 dir="auto">{chat.title || chatId}</h2>
        <span><bdi>{chat.username ? '@' + chat.username : chatId}</bdi></span>
      </div>
    </div>
    {(actionError || error) && <div className="telegram-chat-error" role="alert">{actionError || error}</div>}
    <div className="chat-body" role="log" aria-label="پیام‌های گفت‌وگوی تلگرام" ref={bodyRef}
      onScroll={event => {
        const body = event.currentTarget;
        followMessages.current = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
      }}>
      {messages.length ? messages.map(message => {
        const outgoing = message.direction === 'outgoing';
        return <div key={message.messageId} className={`message-row ${outgoing ? 'mine' : ''}`}>
          <div className={`chat-avatar ${outgoing ? 'self' : ''}`} aria-hidden="true">{outgoing ? 'پ' : (message.senderName || 'ک').slice(0, 1)}</div>
          <div className="message-content">
            <span className="message-author" dir="auto">{outgoing ? 'پشتیبانی' : message.senderName}</span>
            <div className="bubble" dir="auto">{messageText(message.text, message.contentType, message.deleted)}</div>
            <time className="message-time" dateTime={message.sentAt}>{sentTime.format(new Date(message.sentAt))}</time>
          </div>
          {connected && !outgoing && !message.deleted && <button type="button" className="telegram-delete-message"
            title="حذف پیام از تلگرام" aria-label="حذف پیام از تلگرام" disabled={busy} onClick={() => void deleteIncoming(message)}>
            <Trash2 size={15}/>
          </button>}
        </div>;
      }) : <div className="chat-empty">
        <div className="chat-empty-icon"><MessageCircle size={22}/></div>
        <b>{loading ? 'در حال دریافت پیام‌ها…' : error ? 'دریافت پیام‌ها انجام نشد.' : 'هنوز پیامی ثبت نشده است.'}</b>
      </div>}
    </div>
    {canReply ? <form className="chat-compose" onSubmit={send}>
      <input aria-label="پیام تلگرام" placeholder="پاسخ را بنویسید…" dir="auto" maxLength={4096} value={draft}
        onChange={event => setDraft(event.target.value)} disabled={busy}/>
      <button className="send-btn" type="submit" title="ارسال در تلگرام" aria-label="ارسال در تلگرام" disabled={busy || !draft.trim()}>
        <Send size={17}/>
      </button>
    </form> : connected && <p className="telegram-chat-hint">ارسال پاسخ در گفت‌وگوهای خصوصی فعال است.</p>}
  </div>;
}

export default function TelegramChatView({ token, onNotify, onOpenSettings }: {
  token: string;
  onNotify: (message: string) => void;
  onOpenSettings: () => void;
}) {
  const [selectedChatId, setSelectedChatId] = useState('');
  const [search, setSearch] = useState('');

  const request: TelegramRequest = useCallback(async <T,>(action: string, { signal, query, body }: RequestOptions = {}) => {
    const params = new URLSearchParams({ action, ...query });
    const response = await fetch('/api/telegram?' + params, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      signal,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await readApiResponse<T & { message?: string }>(response);
    if (!response.ok) throw new Error(result.message || 'درخواست تلگرام انجام نشد.');
    return result;
  }, [token]);
  const loadInbox = useCallback((signal: AbortSignal) => request<Inbox>('chats', { signal }), [request]);
  const { data: { botId, connected, chats }, loading, error, refresh } = useTelegramPolling(loadInbox, emptyInbox);

  useEffect(() => {
    setSelectedChatId(current => chats.some(chat => chat.chatId === current) ? current : chats[0]?.chatId || '');
  }, [chats]);

  const selected = chats.find(chat => chat.chatId === selectedChatId);
  const term = search.trim().toLowerCase().replace(/^@/, '');
  const visibleChats = chats.filter(chat => [chat.title, chat.username, chat.chatId, chat.lastMessage]
    .some(value => value.toLowerCase().includes(term)));

  return <div className="telegram-support">
    {!loading && !error && !connected && <div className="telegram-connection-notice">
      <span>برای دریافت پیام و پاسخ از پنل، ربات تلگرام را وصل کنید.</span>
      <button type="button" className="soft-btn" onClick={onOpenSettings}>اتصال ربات</button>
    </div>}
    <section className="panel telegram-chat-view" aria-label="پشتیبانی تلگرام">
      <aside className="chat-conversations telegram-chat-list" aria-label="فهرست گفت‌وگوها">
        <div className="chat-list-heading">
          <h2>گفت‌وگوهای تلگرام</h2>
          <button type="button" className="icon-btn" title="به‌روزرسانی فهرست" aria-label="به‌روزرسانی فهرست" onClick={refresh}>
            <RefreshCw size={16}/>
          </button>
        </div>
        {chats.length > 0 && <div className="telegram-chat-search">
          <input type="search" aria-label="جست‌وجوی گفت‌وگو" placeholder="جست‌وجوی کاربر یا گفت‌وگو" value={search}
            onChange={event => setSearch(event.target.value)}/>
        </div>}
        {error && <div className="telegram-chat-error" role="alert">{error}</div>}
        <div className="chat-list-scroll">
          {visibleChats.length ? visibleChats.map(chat => <button type="button" key={chat.chatId}
            className={`chat-conversation ${selectedChatId === chat.chatId ? 'selected' : ''}`}
            aria-pressed={selectedChatId === chat.chatId} onClick={() => setSelectedChatId(chat.chatId)}>
            <span className="chat-list-avatar"><MessageCircle size={17}/></span>
            <span className="chat-list-copy">
              <b dir="auto">{chat.title || chat.chatId}</b>
              <small dir="auto">{messageText(chat.lastMessage, chat.lastContentType, chat.lastDeleted)}</small>
            </span>
          </button>) : !error && <div className="chat-list-empty">
            {loading ? 'در حال دریافت گفت‌وگوها…' : term ? 'گفت‌وگویی پیدا نشد.' : 'هنوز گفت‌وگویی ثبت نشده است.'}
          </div>}
        </div>
      </aside>
      {selected && botId ? <TelegramConversation key={botId + ':' + selected.chatId} chat={selected} botId={botId}
        connected={connected} request={request} onChanged={refresh} onNotify={onNotify}/> :
        <div className="chat-empty">
          <div className="chat-empty-icon"><MessageCircle size={22}/></div>
          <b>پشتیبانی تلگرام</b>
          {connected && <span>وقتی کاربر به ربات پیام بدهد، گفت‌وگو اینجا نمایش داده می‌شود.</span>}
        </div>}
    </section>
  </div>;
}
