const express = require('express');

const { requireAuth } = require('../middleware/auth');
const { supabase, TABLES } = require('../lib/supabase');
const { notifyChatMessage } = require('../lib/notifications');

const router = express.Router();

const MAX_MESSAGE_LENGTH = 1200;
const CONVERSATION_COLUMNS =
  'id, vendor_id, customer_id, created_at, updated_at, unread_for_customer, unread_for_vendor';
const MESSAGE_COLUMNS = 'id, conversation_id, sender_user_id, text, created_at';

const normalizeMessageText = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, MAX_MESSAGE_LENGTH);
};

const normalizeIdentifier = (value) => {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
};

const toTimestamp = (value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toUnreadCount = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
};

const resolveArray = (value) => (Array.isArray(value) ? value : []);

const mapConversationRow = (row) => ({
  id: normalizeIdentifier(row.id),
  vendorId: normalizeIdentifier(row.vendor_id),
  customerId: normalizeIdentifier(row.customer_id),
  createdAt: row.created_at || null,
  updatedAt: row.updated_at || null,
  unreadForCustomer: toUnreadCount(row.unread_for_customer),
  unreadForVendor: toUnreadCount(row.unread_for_vendor),
});

const mapMessageRow = (row) => ({
  id: normalizeIdentifier(row.id),
  conversationId: normalizeIdentifier(row.conversation_id),
  senderId: normalizeIdentifier(row.sender_user_id),
  text: row.text || '',
  createdAt: row.created_at || null,
});

const fetchMessagesByConversationIds = async (
  conversationIds,
  { ascending = true } = {},
) => {
  const ids = resolveArray(conversationIds)
    .map((value) => normalizeIdentifier(value))
    .filter(Boolean);
  if (ids.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from(TABLES.messages)
    .select(MESSAGE_COLUMNS)
    .in('conversation_id', ids)
    .order('created_at', { ascending })
    .order('id', { ascending });

  if (error) {
    throw new Error(error.message || 'Unable to load conversation messages.');
  }

  return resolveArray(data).map(mapMessageRow);
};

const fetchConversationById = async (conversationId) => {
  const id = normalizeIdentifier(conversationId);
  if (!id) {
    return null;
  }

  const { data, error } = await supabase
    .from(TABLES.conversations)
    .select(CONVERSATION_COLUMNS)
    .eq('id', id)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || 'Unable to load conversation.');
  }
  if (!data) {
    return null;
  }

  return mapConversationRow(data);
};

const fetchConversationsForUser = async (user, vendorRecord) => {
  if (!user) {
    return [];
  }

  const userId = normalizeIdentifier(user.id);
  if (!userId) {
    return [];
  }

  if (user.role === 'vendor' && !vendorRecord) {
    return [];
  }

  const query = supabase.from(TABLES.conversations).select(CONVERSATION_COLUMNS);
  if (user.role === 'customer') {
    query.eq('customer_id', userId);
  } else if (user.role === 'vendor') {
    query.eq('vendor_id', normalizeIdentifier(vendorRecord.id));
  } else {
    return [];
  }

  const { data, error } = await query
    .order('updated_at', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(error.message || 'Unable to load conversations.');
  }

  return resolveArray(data).map(mapConversationRow);
};

const fetchChatContext = async () => {
  const [usersResult, customersResult, farmersResult] = await Promise.all([
    supabase.from(TABLES.users).select('id, username, email, user_type'),
    supabase
      .from(TABLES.customers)
      .select(
        'id, name, surname, "address street", "address number", "phone number", city, county, country',
      ),
    supabase
      .from(TABLES.farmers)
      .select(
        'id, "farm name", "display name", city, county, "street address", "street number", "phone number", email, bio',
      ),
  ]);

  if (usersResult.error) {
    throw new Error(usersResult.error.message || 'Unable to load users.');
  }
  if (customersResult.error) {
    throw new Error(customersResult.error.message || 'Unable to load customers.');
  }
  if (farmersResult.error) {
    throw new Error(farmersResult.error.message || 'Unable to load farmers.');
  }

  const customersByUserId = new Map(
    resolveArray(customersResult.data).map((entry) => [
      normalizeIdentifier(entry.id),
      entry,
    ]),
  );
  const users = resolveArray(usersResult.data).map((entry) => {
    const userId = normalizeIdentifier(entry.id);
    const customer = customersByUserId.get(userId) || null;
    return {
      id: userId,
      username: entry.username || '',
      firstName: customer?.name || '',
      lastName: customer?.surname || '',
      streetAddress: customer?.['address street'] || '',
      streetNumber: customer?.['address number'] || '',
      phoneNumber: customer?.['phone number'] || '',
      email: entry.email || '',
      city: customer?.city || '',
      county: customer?.county || '',
      country: customer?.country || '',
    };
  });

  const usersById = new Map(users.map((entry) => [entry.id, entry]));
  const vendors = resolveArray(farmersResult.data).map((entry) => {
    const vendorId = normalizeIdentifier(entry.id);
    return {
      id: vendorId,
      userId: vendorId,
      farmName: entry['farm name'] || '',
      displayName: entry['display name'] || '',
      streetAddress: entry['street address'] || '',
      streetNumber: entry['street number'] || '',
      county: entry.county || '',
      city: entry.city || '',
      phoneNumber: entry['phone number'] || '',
      email: entry.email || usersById.get(vendorId)?.email || '',
      bio: entry.bio || '',
    };
  });

  return { users, vendors };
};

const resolveVendorForUser = (user, vendors) => {
  if (!user || user.role !== 'vendor') {
    return null;
  }
  const userId = normalizeIdentifier(user.id);
  return vendors.find((entry) => entry.userId === userId) || null;
};

const canAccessConversation = (user, vendorRecord, conversation) => {
  if (!user || !conversation) {
    return false;
  }

  const userId = normalizeIdentifier(user.id);
  if (user.role === 'customer') {
    return conversation.customerId === userId;
  }
  if (user.role === 'vendor') {
    return Boolean(vendorRecord && conversation.vendorId === vendorRecord.id);
  }
  return false;
};

const toCustomerDisplayName = (customer) => {
  if (!customer) {
    return 'Customer';
  }
  const fullName = [customer.firstName, customer.lastName]
    .filter(Boolean)
    .join(' ')
    .trim();
  return fullName || customer.username || 'Customer';
};

const toVendorDisplayName = (vendor) => {
  if (!vendor) {
    return 'Farmer';
  }
  return vendor.farmName || vendor.displayName || 'Farmer';
};

const toSummaryParticipant = (currentUser, conversation, usersById, vendorsById) => {
  if (currentUser.role === 'customer') {
    const vendor = vendorsById.get(conversation.vendorId) || null;
    return {
      role: 'vendor',
      vendorId: conversation.vendorId || null,
      userId: vendor?.userId || null,
      title: toVendorDisplayName(vendor),
      subtitle: [vendor?.city, vendor?.county].filter(Boolean).join(', '),
      phoneNumber: vendor?.phoneNumber || '',
      email: vendor?.email || '',
    };
  }

  const customer = usersById.get(conversation.customerId) || null;
  return {
    role: 'customer',
    vendorId: null,
    userId: conversation.customerId || null,
    title: toCustomerDisplayName(customer),
    subtitle: [customer?.city, customer?.county, customer?.country]
      .filter(Boolean)
      .join(', '),
    phoneNumber: customer?.phoneNumber || '',
    email: customer?.email || '',
  };
};

const toConversationSummary = (currentUser, conversation, usersById, vendorsById) => {
  const messages = resolveArray(conversation.messages);
  const lastMessage = messages[messages.length - 1] || null;
  const lastMessageAt =
    lastMessage?.createdAt || conversation.updatedAt || conversation.createdAt || null;

  return {
    id: conversation.id,
    vendorId: conversation.vendorId,
    customerId: conversation.customerId,
    createdAt: conversation.createdAt || null,
    updatedAt: conversation.updatedAt || null,
    lastMessage: lastMessage
      ? {
          id: lastMessage.id,
          senderId: lastMessage.senderId,
          text: lastMessage.text,
          createdAt: lastMessage.createdAt,
        }
      : null,
    lastMessageAt,
    unreadCount:
      currentUser.role === 'customer'
        ? toUnreadCount(conversation.unreadForCustomer)
        : toUnreadCount(conversation.unreadForVendor),
    participant: toSummaryParticipant(
      currentUser,
      conversation,
      usersById,
      vendorsById,
    ),
  };
};

const toConversationDetails = (
  currentUser,
  conversation,
  usersById,
  vendorsById,
) => {
  const vendor = vendorsById.get(conversation.vendorId) || null;
  const customer = usersById.get(conversation.customerId) || null;
  const messages = resolveArray(conversation.messages);

  return {
    ...toConversationSummary(currentUser, conversation, usersById, vendorsById),
    messages: messages.map((message) => {
      const isCustomerMessage = message.senderId === conversation.customerId;
      const senderRole = isCustomerMessage ? 'customer' : 'vendor';
      const senderName = isCustomerMessage
        ? toCustomerDisplayName(customer)
        : toVendorDisplayName(vendor);

      return {
        id: message.id,
        senderId: message.senderId,
        senderRole,
        senderName,
        text: message.text,
        createdAt: message.createdAt,
      };
    }),
  };
};

router.get('/conversations', requireAuth, async (req, res, next) => {
  try {
    const { users, vendors } = await fetchChatContext();
    const currentVendor = resolveVendorForUser(req.user, vendors);

    const conversations = await fetchConversationsForUser(req.user, currentVendor);
    const userConversations = conversations.filter((conversation) =>
      canAccessConversation(req.user, currentVendor, conversation),
    );

    const conversationIds = userConversations.map((entry) => entry.id);
    const latestMessages = await fetchMessagesByConversationIds(conversationIds, {
      ascending: false,
    });
    const latestByConversationId = new Map();
    for (const message of latestMessages) {
      if (latestByConversationId.has(message.conversationId)) {
        continue;
      }
      latestByConversationId.set(message.conversationId, message);
    }

    const conversationsWithLatestMessage = userConversations.map((conversation) => {
      const lastMessage = latestByConversationId.get(conversation.id) || null;
      return {
        ...conversation,
        messages: lastMessage ? [lastMessage] : [],
      };
    });

    const usersById = new Map(users.map((entry) => [entry.id, entry]));
    const vendorsById = new Map(vendors.map((entry) => [entry.id, entry]));

    const summaries = conversationsWithLatestMessage
      .map((conversation) =>
        toConversationSummary(req.user, conversation, usersById, vendorsById),
      )
      .sort((a, b) => toTimestamp(b.lastMessageAt) - toTimestamp(a.lastMessageAt));

    const totalUnread = summaries.reduce(
      (sum, conversation) => sum + toUnreadCount(conversation.unreadCount),
      0,
    );

    return res.json({
      conversations: summaries,
      vendorId: currentVendor?.id || null,
      totalUnread,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/conversations/start', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'customer') {
      return res.status(403).json({
        error: 'Only customer accounts can start a new conversation from farm pages.',
      });
    }

    const vendorId = normalizeIdentifier(req.body?.vendorId);
    if (!vendorId) {
      return res.status(400).json({ error: 'vendorId is required.' });
    }

    const customerId = normalizeIdentifier(req.user.id);
    const { users, vendors } = await fetchChatContext();
    const vendor = vendors.find((entry) => entry.id === vendorId);
    if (!vendor) {
      return res.status(404).json({ error: 'Vendor not found.' });
    }

    const { data: existingConversationRow, error: existingConversationError } =
      await supabase
        .from(TABLES.conversations)
        .select(CONVERSATION_COLUMNS)
        .eq('vendor_id', vendorId)
        .eq('customer_id', customerId)
        .maybeSingle();

    if (existingConversationError) {
      throw new Error(
        existingConversationError.message || 'Unable to verify existing conversation.',
      );
    }

    let conversationRow = existingConversationRow || null;
    if (!conversationRow) {
      const now = new Date().toISOString();
      const { data: createdConversationRow, error: createConversationError } =
        await supabase
          .from(TABLES.conversations)
          .insert({
            vendor_id: vendorId,
            customer_id: customerId,
            created_at: now,
            updated_at: now,
            unread_for_customer: 0,
            unread_for_vendor: 0,
          })
          .select(CONVERSATION_COLUMNS)
          .single();

      if (createConversationError) {
        // Handle concurrent starts where another request created the same row.
        if (createConversationError.code === '23505') {
          const {
            data: retryConversationRow,
            error: retryConversationError,
          } = await supabase
            .from(TABLES.conversations)
            .select(CONVERSATION_COLUMNS)
            .eq('vendor_id', vendorId)
            .eq('customer_id', customerId)
            .maybeSingle();

          if (retryConversationError || !retryConversationRow) {
            throw new Error(
              retryConversationError?.message ||
                createConversationError.message ||
                'Unable to start conversation.',
            );
          }
          conversationRow = retryConversationRow;
        } else {
          throw new Error(createConversationError.message || 'Unable to start conversation.');
        }
      } else {
        conversationRow = createdConversationRow;
      }
    }

    const conversation = {
      ...mapConversationRow(conversationRow),
      messages: [],
    };
    const usersById = new Map(users.map((entry) => [entry.id, entry]));
    const vendorsById = new Map(vendors.map((entry) => [entry.id, entry]));

    return res.status(201).json({
      conversation: toConversationSummary(req.user, conversation, usersById, vendorsById),
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/conversations/:conversationId', requireAuth, async (req, res, next) => {
  try {
    const conversationId = normalizeIdentifier(req.params.conversationId);
    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId is required.' });
    }

    const conversation = await fetchConversationById(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    const { users, vendors } = await fetchChatContext();
    const currentVendor = resolveVendorForUser(req.user, vendors);
    if (!canAccessConversation(req.user, currentVendor, conversation)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const unreadField =
      req.user.role === 'customer' ? 'unread_for_customer' : 'unread_for_vendor';

    const { data: updatedConversationRow, error: updateConversationError } = await supabase
      .from(TABLES.conversations)
      .update({ [unreadField]: 0 })
      .eq('id', conversationId)
      .select(CONVERSATION_COLUMNS)
      .maybeSingle();

    if (updateConversationError) {
      throw new Error(
        updateConversationError.message || 'Unable to mark conversation as read.',
      );
    }

    const messages = await fetchMessagesByConversationIds([conversationId], {
      ascending: true,
    });
    const effectiveConversation = updatedConversationRow
      ? mapConversationRow(updatedConversationRow)
      : conversation;
    const conversationWithMessages = {
      ...effectiveConversation,
      messages,
    };

    const usersById = new Map(users.map((entry) => [entry.id, entry]));
    const vendorsById = new Map(vendors.map((entry) => [entry.id, entry]));
    return res.json({
      conversation: toConversationDetails(
        req.user,
        conversationWithMessages,
        usersById,
        vendorsById,
      ),
    });
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/conversations/:conversationId/messages',
  requireAuth,
  async (req, res, next) => {
    try {
      const conversationId = normalizeIdentifier(req.params.conversationId);
      if (!conversationId) {
        return res.status(400).json({ error: 'conversationId is required.' });
      }

      const text = normalizeMessageText(req.body?.text);
      if (!text) {
        return res.status(400).json({ error: 'Message text is required.' });
      }

      const currentConversation = await fetchConversationById(conversationId);
      if (!currentConversation) {
        return res.status(404).json({ error: 'Conversation not found.' });
      }

      const { vendors } = await fetchChatContext();
      const currentVendor = resolveVendorForUser(req.user, vendors);
      if (!canAccessConversation(req.user, currentVendor, currentConversation)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const now = new Date().toISOString();
      const { data: insertedMessageRow, error: insertMessageError } = await supabase
        .from(TABLES.messages)
        .insert({
          conversation_id: conversationId,
          sender_user_id: normalizeIdentifier(req.user.id),
          text,
          created_at: now,
        })
        .select(MESSAGE_COLUMNS)
        .single();

      if (insertMessageError || !insertedMessageRow) {
        throw new Error(insertMessageError?.message || 'Unable to send message.');
      }

      const message = mapMessageRow(insertedMessageRow);
      const isCustomerSender = req.user.role === 'customer';
      const unreadForCustomer = toUnreadCount(currentConversation.unreadForCustomer);
      const unreadForVendor = toUnreadCount(currentConversation.unreadForVendor);

      const { error: updateConversationError } = await supabase
        .from(TABLES.conversations)
        .update({
          updated_at: message.createdAt || now,
          unread_for_customer: isCustomerSender ? 0 : unreadForCustomer + 1,
          unread_for_vendor: isCustomerSender ? unreadForVendor + 1 : 0,
        })
        .eq('id', conversationId);

      if (updateConversationError) {
        throw new Error(
          updateConversationError.message || 'Unable to update conversation metadata.',
        );
      }

      // OPS-02 — the other side is probably not looking at the tab. Debounced
      // to at most one email per conversation per quarter of an hour, so a
      // back-and-forth does not become twenty messages in an inbox.
      await notifyChatMessage({
        conversationId,
        recipientUserId: isCustomerSender
          ? currentConversation.vendorId
          : currentConversation.customerId,
        senderName: req.user.username || 'Someone',
        preview: text,
      });

      return res.status(201).json({
        message: {
          id: message.id,
          senderId: message.senderId,
          text: message.text,
          createdAt: message.createdAt,
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

module.exports = router;
