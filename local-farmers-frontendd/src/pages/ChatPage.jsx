import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { apiFetch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { supabase } from '../lib/supabase.js';

const formatTime = (value) => {
  if (!value) {
    return '';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  return parsed.toLocaleString();
};

export default function ChatPage() {
  const { status: authStatus, user } = useAuth();
  const [searchParams] = useSearchParams();
  const requestedVendorId = searchParams.get('vendorId') || '';

  const [conversations, setConversations] = useState([]);
  const [selectedConversationId, setSelectedConversationId] = useState('');
  const [currentVendorId, setCurrentVendorId] = useState('');
  const [detail, setDetail] = useState(null);
  const [listStatus, setListStatus] = useState({ state: 'loading', message: '' });
  const [detailStatus, setDetailStatus] = useState({
    state: 'idle',
    message: '',
  });
  const [sendStatus, setSendStatus] = useState({ state: 'idle', message: '' });
  const [draft, setDraft] = useState('');
  const [startedVendorId, setStartedVendorId] = useState('');

  const isAllowedRole = user?.role === 'customer' || user?.role === 'vendor';

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
      const resolvedVendorId =
        typeof data.vendorId === 'string' && data.vendorId.trim()
          ? data.vendorId.trim()
          : '';
      setConversations(nextConversations);
      setCurrentVendorId(resolvedVendorId);
      setListStatus({ state: 'success', message: '' });
      setSelectedConversationId((prev) => {
        if (prev && nextConversations.some((entry) => entry.id === prev)) {
          return prev;
        }
        return nextConversations[0]?.id || '';
      });
    } catch (error) {
      setCurrentVendorId('');
      setListStatus({
        state: 'error',
        message: error.message || 'Unable to load conversations.',
      });
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

    let active = true;
    let channel = null;

    const subscribeToConversations = async () => {
      await loadConversations();
      if (!active) {
        return;
      }

      const participantId =
        user.role === 'vendor' ? currentVendorId || user.id : user.id;
      if (!participantId) {
        return;
      }

      const filter =
        user.role === 'customer'
          ? `customer_id=eq.${participantId}`
          : `vendor_id=eq.${participantId}`;

      channel = supabase
        .channel(`chat-conversations-${user.id}-${participantId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'conversations',
            filter,
          },
          () => {
            loadConversations().catch(() => {});
          },
        )
        .subscribe();
    };

    subscribeToConversations().catch(() => {});
    return () => {
      active = false;
      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, [
    authStatus,
    user,
    isAllowedRole,
    loadConversations,
    currentVendorId,
  ]);

  useEffect(() => {
    if (
      authStatus !== 'authenticated' ||
      !user ||
      user.role !== 'customer' ||
      !requestedVendorId ||
      startedVendorId === requestedVendorId
    ) {
      return;
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
        if (!active) {
          return;
        }

        const createdConversation = data.conversation;
        if (createdConversation?.id) {
          setSelectedConversationId(createdConversation.id);
        }
        setStartedVendorId(requestedVendorId);
        await loadConversations();
      } catch (error) {
        if (!active) {
          return;
        }
        setListStatus({
          state: 'error',
          message: error.message || 'Unable to start chat.',
        });
      }
    };

    startConversation();
    return () => {
      active = false;
    };
  }, [
    authStatus,
    user,
    requestedVendorId,
    startedVendorId,
    loadConversations,
  ]);

  useEffect(() => {
    if (authStatus !== 'authenticated' || !user || !isAllowedRole) {
      return undefined;
    }
    if (!selectedConversationId) {
      setDetail(null);
      return undefined;
    }

    let active = true;

    loadConversationDetail(selectedConversationId);
    const channel = supabase
      .channel(`chat-messages-${selectedConversationId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${selectedConversationId}`,
        },
        () => {
          if (!active) {
            return;
          }
          Promise.all([
            loadConversationDetail(selectedConversationId),
            loadConversations(),
          ]).catch(() => {});
        },
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [
    authStatus,
    user,
    isAllowedRole,
    selectedConversationId,
    loadConversationDetail,
    loadConversations,
  ]);

  const selectedConversation = useMemo(
    () => conversations.find((entry) => entry.id === selectedConversationId) || null,
    [conversations, selectedConversationId],
  );

  const handleSend = async (event) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !selectedConversationId) {
      return;
    }
    setSendStatus({ state: 'loading', message: 'Sending...' });

    try {
      const response = await apiFetch(
        `/api/chat/conversations/${selectedConversationId}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({ text }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to send message.');
      }

      setDraft('');
      setSendStatus({ state: 'success', message: '' });
      await Promise.all([
        loadConversationDetail(selectedConversationId),
        loadConversations(),
      ]);
    } catch (error) {
      setSendStatus({
        state: 'error',
        message: error.message || 'Unable to send message.',
      });
    }
  };

  if (authStatus === 'loading') {
    return <div className="notice">Loading chat...</div>;
  }

  if (!user) {
    return (
      <div className="page-section">
        <h1>Chat access required</h1>
        <p className="muted">Log in to chat with farmers or customers.</p>
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
        <p className="muted">Chat is available only for customer and vendor accounts.</p>
      </div>
    );
  }

  return (
    <div className="page-section">
      <div className="section-header">
        <div>
          <h1>Chat</h1>
          <p className="muted">Bidirectional messaging between farmers and customers.</p>
        </div>
      </div>

      <div className="chat-layout">
        <aside className="form-card chat-sidebar">
          <h2>Conversations</h2>
          {listStatus.state === 'loading' && conversations.length === 0 && (
            <p className="muted">Loading conversations...</p>
          )}
          {listStatus.state === 'error' && (
            <p className="notice error" role="alert">{listStatus.message}</p>
          )}
          {conversations.length > 0 ? (
            <div className="chat-conversation-list">
              {conversations.map((conversation) => (
                <button
                  className={`chat-conversation-item ${
                    conversation.id === selectedConversationId ? 'active' : ''
                  }`}
                  type="button"
                  key={conversation.id}
                  onClick={() => setSelectedConversationId(conversation.id)}
                >
                  <div className="chat-conversation-top">
                    <p className="chat-conversation-title">
                      {conversation.participant?.title || 'Conversation'}
                    </p>
                    {Number(conversation.unreadCount) > 0 && (
                      <span className="chat-unread-badge">
                        {conversation.unreadCount}
                      </span>
                    )}
                  </div>
                  {conversation.participant?.subtitle && (
                    <p className="chat-conversation-subtitle">
                      {conversation.participant.subtitle}
                    </p>
                  )}
                  {conversation.lastMessage?.text ? (
                    <p className="chat-conversation-preview">
                      {conversation.lastMessage.text}
                    </p>
                  ) : (
                    <p className="chat-conversation-preview muted">
                      No messages yet.
                    </p>
                  )}
                  {conversation.lastMessageAt && (
                    <p className="chat-conversation-time muted">
                      {formatTime(conversation.lastMessageAt)}
                    </p>
                  )}
                </button>
              ))}
            </div>
          ) : (
            listStatus.state === 'success' && (
              <p className="muted">No conversations yet.</p>
            )
          )}
        </aside>

        <section className="form-card chat-main">
          {selectedConversation ? (
            <>
              <div className="chat-header">
                <div>
                  <h2>{selectedConversation.participant?.title || 'Conversation'}</h2>
                  {selectedConversation.participant?.subtitle && (
                    <p className="muted">{selectedConversation.participant.subtitle}</p>
                  )}
                  {selectedConversation.participant?.phoneNumber && (
                    <p className="muted">
                      Phone: {selectedConversation.participant.phoneNumber}
                    </p>
                  )}
                  {selectedConversation.participant?.email && (
                    <p className="muted">
                      Email: {selectedConversation.participant.email}
                    </p>
                  )}
                </div>
              </div>

              {detailStatus.state === 'error' && (
                <p className="notice error" role="alert">{detailStatus.message}</p>
              )}

              <div className="chat-messages">
                {detail?.messages?.length > 0 ? (
                  detail.messages.map((message) => {
                    const isOwnMessage = message.senderId === user.id;
                    return (
                      <div
                        className={`chat-message ${isOwnMessage ? 'own' : 'other'}`}
                        key={message.id}
                      >
                        <p className="chat-message-meta">
                          {isOwnMessage ? 'You' : message.senderName}
                        </p>
                        <p className="chat-message-text">{message.text}</p>
                        <p className="chat-message-time muted">
                          {formatTime(message.createdAt)}
                        </p>
                      </div>
                    );
                  })
                ) : (
                  <p className="muted">No messages yet. Start the conversation.</p>
                )}
              </div>

              <form className="chat-send-form" onSubmit={handleSend}>
                <label className="field">
                  Message
                  <textarea
                    name="message"
                    rows="3"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="Write a message..."
                    required
                  />
                </label>
                <div className="chat-send-actions">
                  <button
                    className="button primary"
                    type="submit"
                    disabled={sendStatus.state === 'loading'}
                  >
                    {sendStatus.state === 'loading' ? 'Sending...' : 'Send'}
                  </button>
                  {sendStatus.state === 'error' && (
                    <p className="notice error" role="alert">{sendStatus.message}</p>
                  )}
                </div>
              </form>
            </>
          ) : (
            <p className="muted">
              Select a conversation to start chatting. You can start from a farm profile
              or product card.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
