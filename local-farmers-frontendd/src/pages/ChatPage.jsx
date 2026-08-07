import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { apiFetch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useLiveUpdates, LIVE_TOPICS } from '../lib/liveUpdates.js';

const formatTime = (value) => {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

/** "Today" / "Yesterday" / a date — used for the separators inside a thread. */
const formatDayLabel = (value) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';

  const startOf = (date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(parsed)) / 86400000);

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return parsed.toLocaleDateString([], { weekday: 'long' });
  return parsed.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
};

const formatListTime = (value) => {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  const sameDay = parsed.toDateString() === new Date().toDateString();
  return sameDay
    ? parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : parsed.toLocaleDateString([], { day: 'numeric', month: 'short' });
};

const initials = (value) => {
  const text = (value || '').trim();
  if (!text) return '?';
  return text
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
};

export default function ChatPage() {
  const { status: authStatus, user } = useAuth();
  const [searchParams] = useSearchParams();
  const requestedVendorId = searchParams.get('vendorId') || '';

  const [conversations, setConversations] = useState([]);
  const [selectedConversationId, setSelectedConversationId] = useState('');
  const [detail, setDetail] = useState(null);
  const [listStatus, setListStatus] = useState({ state: 'loading', message: '' });
  const [detailStatus, setDetailStatus] = useState({ state: 'idle', message: '' });
  const [sendStatus, setSendStatus] = useState({ state: 'idle', message: '' });
  const [draft, setDraft] = useState('');
  const [startedVendorId, setStartedVendorId] = useState('');
  const [mobileView, setMobileView] = useState('list');

  const messagesRef = useRef(null);
  const isAllowedRole = user?.role === 'customer' || user?.role === 'vendor';

  /** Returns the vendor id so the subscriber can use it without a state round-trip. */
  const loadConversations = useCallback(async () => {
    setListStatus((prev) =>
      prev.state === 'success'
        ? prev
        : { state: 'loading', message: 'Loading conversations...' },
    );
    try {
      const response = await apiFetch('/api/chat/conversations', { method: 'GET' });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to load conversations.');
      }

      const nextConversations = data.conversations || [];
      setConversations(nextConversations);
      setListStatus({ state: 'success', message: '' });
      setSelectedConversationId((prev) =>
        prev && nextConversations.some((entry) => entry.id === prev)
          ? prev
          : nextConversations[0]?.id || '',
      );
      return typeof data.vendorId === 'string' ? data.vendorId.trim() : '';
    } catch (error) {
      setListStatus({
        state: 'error',
        message: error.message || 'Unable to load conversations.',
      });
      return '';
    }
  }, []);

  const loadConversationDetail = useCallback(async (conversationId) => {
    if (!conversationId) {
      setDetail(null);
      return;
    }
    try {
      const response = await apiFetch(`/api/chat/conversations/${conversationId}`, {
        method: 'GET',
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to load conversation.');
      }
      setDetail(data.conversation || null);
      setDetailStatus({ state: 'success', message: '' });
    } catch (error) {
      setDetail(null);
      setDetailStatus({
        state: 'error',
        message: error.message || 'Unable to load conversation.',
      });
    }
  }, []);

  useEffect(() => {
    if (authStatus !== 'authenticated' || !user || !isAllowedRole) {
      return undefined;
    }
    loadConversations().catch(() => {});
    return undefined;
  }, [authStatus, user, isAllowedRole, loadConversations]);

  // SEC-01 — the conversation list used to be kept fresh by a Supabase
  // subscription in the browser. The server now decides who hears about a
  // conversation, so this no longer needs to resolve its own vendor id just to
  // build a filter.
  useLiveUpdates(
    [LIVE_TOPICS.CONVERSATIONS],
    () => {
      loadConversations().catch(() => {});
    },
    authStatus === 'authenticated' && Boolean(user) && isAllowedRole,
  );

  useEffect(() => {
    if (
      authStatus !== 'authenticated' ||
      !user ||
      user.role !== 'customer' ||
      !requestedVendorId ||
      startedVendorId === requestedVendorId
    ) {
      return undefined;
    }

    let active = true;
    const startConversation = async () => {
      try {
        const response = await apiFetch('/api/chat/conversations/start', {
          method: 'POST',
          body: JSON.stringify({ vendorId: requestedVendorId }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Unable to start chat.');
        }
        if (!active) return;

        if (data.conversation?.id) {
          setSelectedConversationId(data.conversation.id);
          setMobileView('thread');
        }
        setStartedVendorId(requestedVendorId);
        await loadConversations();
      } catch (error) {
        if (!active) return;
        setListStatus({ state: 'error', message: error.message || 'Unable to start chat.' });
      }
    };

    startConversation();
    return () => {
      active = false;
    };
  }, [authStatus, user, requestedVendorId, startedVendorId, loadConversations]);

  useEffect(() => {
    if (authStatus !== 'authenticated' || !user || !isAllowedRole) {
      return undefined;
    }
    if (!selectedConversationId) {
      setDetail(null);
      return undefined;
    }

    loadConversationDetail(selectedConversationId);
    return undefined;
  }, [
    authStatus,
    user,
    isAllowedRole,
    selectedConversationId,
    loadConversationDetail,
  ]);

  // SEC-01 — new messages arrive over the server stream. The event carries a
  // conversation id but never the message text: the browser refetches through
  // the API, which is the only thing that checks whether this user is party to
  // the conversation at all.
  useLiveUpdates(
    [LIVE_TOPICS.MESSAGES],
    (event) => {
      if (event.conversationId && event.conversationId !== selectedConversationId) {
        // Another thread moved — the list badge changes, this pane does not.
        loadConversations().catch(() => {});
        return;
      }
      Promise.all([
        loadConversationDetail(selectedConversationId),
        loadConversations(),
      ]).catch(() => {});
    },
    authStatus === 'authenticated' && Boolean(selectedConversationId) && isAllowedRole,
  );

  /** Jump to the newest message whenever the thread changes. */
  useEffect(() => {
    const node = messagesRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [detail, selectedConversationId]);

  const selectedConversation = useMemo(
    () => conversations.find((entry) => entry.id === selectedConversationId) || null,
    [conversations, selectedConversationId],
  );

  /** Groups consecutive messages by sender and inserts day separators. */
  const messageGroups = useMemo(() => {
    const messages = detail?.messages || [];
    const groups = [];
    let lastDay = null;

    messages.forEach((message) => {
      const day = formatDayLabel(message.createdAt);
      if (day !== lastDay) {
        groups.push({ type: 'day', id: `day-${message.id}`, label: day });
        lastDay = day;
      }
      const previous = groups[groups.length - 1];
      const isOwn = message.senderId === user?.id;
      if (previous?.type === 'block' && previous.isOwn === isOwn) {
        previous.messages.push(message);
      } else {
        groups.push({ type: 'block', id: `block-${message.id}`, isOwn, messages: [message] });
      }
    });

    return groups;
  }, [detail, user?.id]);

  const handleSend = async (event) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !selectedConversationId) return;

    setSendStatus({ state: 'loading', message: '' });
    try {
      const response = await apiFetch(
        `/api/chat/conversations/${selectedConversationId}/messages`,
        { method: 'POST', body: JSON.stringify({ text }) },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to send message.');
      }
      setDraft('');
      setSendStatus({ state: 'idle', message: '' });
      await Promise.all([
        loadConversationDetail(selectedConversationId),
        loadConversations(),
      ]);
    } catch (error) {
      setSendStatus({ state: 'error', message: error.message || 'Unable to send message.' });
    }
  };

  /** Enter sends, Shift+Enter makes a new line. */
  const handleDraftKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend(event);
    }
  };

  if (authStatus === 'loading') {
    return <div className="notice">Loading chat...</div>;
  }

  if (!user) {
    return (
      <div className="page-section">
        <h1>Chat</h1>
        <p className="muted">Log in to message farmers and customers.</p>
        <Link className="button primary" to="/auth/login">
          Log in
        </Link>
      </div>
    );
  }

  if (!isAllowedRole) {
    return (
      <div className="page-section">
        <h1>Chat unavailable</h1>
        <p className="muted">Chat is available for customer and farmer accounts only.</p>
      </div>
    );
  }

  const partner = selectedConversation?.participant;

  return (
    <div className="page-section chat-page">
      <div className="section-header">
        <div>
          <h1>Messages</h1>
          <p className="muted">Talk to the farm directly — no middlemen, no call centre.</p>
        </div>
      </div>

      <div className={`chat-shell view-${mobileView}`}>
        <aside className="chat-sidebar">
          <div className="chat-sidebar-head">
            <h2>Conversations</h2>
            {conversations.length > 0 && (
              <span className="chat-sidebar-count">{conversations.length}</span>
            )}
          </div>

          {listStatus.state === 'error' && (
            <p className="notice error" role="alert">
              {listStatus.message}
            </p>
          )}

          {conversations.length > 0 ? (
            <div className="chat-conversation-list">
              {conversations.map((conversation) => {
                const unread = Number(conversation.unreadCount) || 0;
                return (
                  <button
                    className={`chat-conversation-item ${
                      conversation.id === selectedConversationId ? 'active' : ''
                    }`}
                    type="button"
                    key={conversation.id}
                    onClick={() => {
                      setSelectedConversationId(conversation.id);
                      setMobileView('thread');
                    }}
                  >
                    <span className="chat-avatar" aria-hidden="true">
                      {initials(conversation.participant?.title)}
                    </span>
                    <span className="chat-conversation-body">
                      <span className="chat-conversation-top">
                        <span className="chat-conversation-title">
                          {conversation.participant?.title || 'Conversation'}
                        </span>
                        {conversation.lastMessageAt && (
                          <span className="chat-conversation-time">
                            {formatListTime(conversation.lastMessageAt)}
                          </span>
                        )}
                      </span>
                      <span className="chat-conversation-bottom">
                        <span className="chat-conversation-preview">
                          {conversation.lastMessage?.text || 'No messages yet'}
                        </span>
                        {unread > 0 && <span className="chat-unread-badge">{unread}</span>}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            listStatus.state === 'success' && (
              <div className="chat-sidebar-empty">
                <p className="muted">No conversations yet.</p>
                <Link className="button ghost small" to="/markets">
                  Find a farm
                </Link>
              </div>
            )
          )}
        </aside>

        <section className="chat-main">
          {selectedConversation ? (
            <>
              <header className="chat-header">
                <button
                  className="chat-back"
                  type="button"
                  onClick={() => setMobileView('list')}
                  aria-label="Back to conversations"
                >
                  ←
                </button>
                <span className="chat-avatar" aria-hidden="true">
                  {initials(partner?.title)}
                </span>
                <div className="chat-header-identity">
                  <p className="chat-header-title">{partner?.title || 'Conversation'}</p>
                  {partner?.subtitle && <p className="chat-header-sub">{partner.subtitle}</p>}
                </div>
                <div className="chat-header-contact">
                  {partner?.phoneNumber && (
                    <a className="chat-contact-chip" href={`tel:${partner.phoneNumber}`}>
                      {partner.phoneNumber}
                    </a>
                  )}
                  {partner?.email && (
                    <a className="chat-contact-chip" href={`mailto:${partner.email}`}>
                      {partner.email}
                    </a>
                  )}
                </div>
              </header>

              {detailStatus.state === 'error' && (
                <p className="notice error" role="alert">
                  {detailStatus.message}
                </p>
              )}

              <div className="chat-messages" ref={messagesRef}>
                {messageGroups.length > 0 ? (
                  messageGroups.map((group) =>
                    group.type === 'day' ? (
                      <p className="chat-day" key={group.id}>
                        <span>{group.label}</span>
                      </p>
                    ) : (
                      <div className={`chat-block ${group.isOwn ? 'own' : 'other'}`} key={group.id}>
                        {!group.isOwn && (
                          <p className="chat-block-sender">{group.messages[0].senderName}</p>
                        )}
                        {group.messages.map((message) => (
                          <p className="chat-bubble" key={message.id}>
                            <span className="chat-bubble-text">{message.text}</span>
                            <span className="chat-bubble-time">
                              {formatTime(message.createdAt)}
                            </span>
                          </p>
                        ))}
                      </div>
                    ),
                  )
                ) : (
                  <div className="chat-empty-thread">
                    <p className="muted">
                      No messages yet. Ask about availability, delivery, or how it was grown.
                    </p>
                  </div>
                )}
              </div>

              <form className="chat-composer" onSubmit={handleSend}>
                <label className="field chat-composer-field">
                  <span className="visually-hidden">Message</span>
                  <textarea
                    rows="1"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleDraftKeyDown}
                    placeholder="Write a message... (Enter to send)"
                    required
                  />
                </label>
                <button
                  className="button primary chat-send"
                  type="submit"
                  disabled={sendStatus.state === 'loading' || !draft.trim()}
                >
                  {sendStatus.state === 'loading' ? 'Sending' : 'Send'}
                </button>
              </form>

              {sendStatus.state === 'error' && (
                <p className="notice error" role="alert">
                  {sendStatus.message}
                </p>
              )}
            </>
          ) : (
            <div className="chat-placeholder">
              <p className="muted">
                Pick a conversation, or start one from a product card or farm page.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
