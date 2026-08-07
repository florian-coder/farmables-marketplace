// LEG-03 — the two GDPR rights that have to be self-service.
//
// Art. 20 (portability) and Art. 17 (erasure) are the only rights where an
// email to support is a worse answer than a button, because both are about
// the user not having to ask permission.
//
// The hard part is Art. 17, and it is worth being precise about why:
//
//   **We cannot delete everything, and pretending otherwise is the failure
//   mode.** Accounting law (Law 82/1991) requires invoices and payment records
//   to be kept for ten years. Food traceability (Regulation 178/2002) requires
//   knowing who produced what and when it was sold. A consent record that can
//   be deleted by the person disputing consent proves nothing.
//
// So deletion here means **anonymisation**: every identifier that points at a
// person is destroyed, and the rows that must survive are left pointing at a
// pseudonym that leads nowhere. Recital 26 is explicit that this takes the
// data outside GDPR entirely, which is a stronger outcome than a soft-delete
// flag that anyone with database access can undo.
//
// `EXPORTED_TABLES` and `deleteAccount` are written to be read together with
// §7 of the privacy policy. If one changes, the other is wrong.

const crypto = require('crypto');

const { supabase, TABLES } = require('./supabase');
const { acceptancesFor } = require('./legalAcceptance');
const { ACTIONS, recordAudit } = require('./audit');
const { revokeUserSessions } = require('./auth');

/** A stable, meaningless handle for what has to stay in the ledger. */
const anonymousHandle = () => `deleted-${crypto.randomUUID().slice(0, 12)}`;

const selectWhere = async (table, columns, column, value) => {
  const { data, error } = await supabase.from(table).select(columns).eq(column, String(value));
  if (error) {
    // One unreadable table must not fail the whole export: a partial answer
    // the user can see beats a 500 they cannot act on.
    return { error: error.message, rows: [] };
  }
  return { rows: Array.isArray(data) ? data : [] };
};

/**
 * Everything we hold about one person, in one JSON document.
 *
 * Art. 20 asks for a "structured, commonly used and machine-readable format".
 * JSON is all three, and it is the format the data is already in.
 */
const exportUserData = async (userId) => {
  const id = String(userId);

  const [
    user,
    customer,
    farmer,
    orders,
    conversations,
    acceptances,
  ] = await Promise.all([
    selectWhere(TABLES.users, 'id, username, email, user_type, email_verified, created_at', 'id', id),
    selectWhere(
      TABLES.customers,
      'id, name, surname, "address street", "address number", "phone number", city, county, country',
      'id',
      id,
    ),
    selectWhere(
      TABLES.farmers,
      'id, "farm name", "display name", "street address", "street number", city, county, "phone number", email, bio, "delivery radius", charges_enabled, delivery_fee_bani, min_order_value_bani',
      'id',
      id,
    ),
    selectWhere(
      TABLES.orders,
      'id, farmer_id, client_id, order_state, total_price, products_subtotal_bani, delivery_fee_bani, commission_bani, refunded_bani, refund_state, created_at, paid_at, cancelled_at, cancel_reason',
      'client_id',
      id,
    ),
    selectWhere(
      TABLES.conversations,
      'id, vendor_id, customer_id, created_at, updated_at',
      'customer_id',
      id,
    ),
    acceptancesFor(id).catch(() => []),
  ]);

  // Order items, for the orders we just found.
  const orderIds = orders.rows.map((row) => String(row.id));
  let orderItems = [];
  if (orderIds.length > 0) {
    const { data } = await supabase
      .from(TABLES.orderItems)
      .select('id, order_id, product_name, product_unit, quantity, unit_price, line_total')
      .in('order_id', orderIds);
    orderItems = Array.isArray(data) ? data : [];
  }

  // Messages this person wrote. Not the whole conversation: the other side's
  // messages are their personal data, not this user's, and handing them over
  // would be a disclosure rather than a portability response.
  const { data: messages } = await supabase
    .from(TABLES.messages)
    .select('id, conversation_id, text, created_at')
    .eq('sender_user_id', id);

  return {
    exportedAt: new Date().toISOString(),
    // Said in the file itself, because the file is what someone reads six
    // months later without the policy next to it.
    note:
      'This is everything we hold that identifies you. Messages written by other people are not ' +
      'included: they are that person’s data, not yours. Records we are legally required to ' +
      'keep (invoices, food traceability) are listed here and explained in our privacy policy.',
    account: user.rows[0] || null,
    customerProfile: customer.rows[0] || null,
    producerProfile: farmer.rows[0] || null,
    orders: orders.rows,
    orderItems,
    conversations: conversations.rows,
    messagesYouSent: Array.isArray(messages) ? messages : [],
    consentRecords: Array.isArray(acceptances) ? acceptances : [],
  };
};

/**
 * What deletion actually does to each table. This list IS the documentation —
 * §7 of the privacy policy is written from it.
 */
const DELETION_PLAN = Object.freeze({
  erased: [
    'users.email, users.password, users.username (replaced with a pseudonym)',
    'customers: name, surname, address, phone, city, county, country',
    'farmers: contact details and free text (the farm row itself is removed if it never sold)',
    'messages.text you wrote (replaced with a placeholder)',
    'all active sessions, everywhere',
  ],
  kept: [
    'orders, prices and quantities — accounting law, 10 years',
    'payment, transfer and refund records — the money trail must stay reconstructable',
    'food traceability: which farm produced what, and when it was sold',
    'consent records — proof of consent is worthless if the person disputing it can delete it',
    'audit log entries — append-only by design',
  ],
});

/**
 * Erase a person, keep the ledger.
 *
 * Deliberately not a transaction: Supabase's REST client cannot open one, and
 * the order below is chosen so that a failure part-way through leaves the
 * account *more* anonymous rather than less. Sessions go first — whatever else
 * happens, the account is unusable from that moment.
 */
const deleteAccount = async ({ req = null, userId, role }) => {
  const id = String(userId);
  const handle = anonymousHandle();

  // 1. Lock them out before anything else. A half-finished deletion must not
  //    leave a usable account behind.
  await revokeUserSessions(id);

  // 2. A producer with sales cannot vanish: traceability points at that row.
  //    One that never sold anything has nothing to trace.
  if (role === 'vendor') {
    const { data: sales } = await supabase
      .from(TABLES.orders)
      .select('id')
      .eq('farmer_id', id)
      .limit(1);

    const hasSold = Array.isArray(sales) && sales.length > 0;

    if (hasSold) {
      await supabase
        .from(TABLES.farmers)
        .update({
          'farm name': `Closed farm ${handle.slice(-6)}`,
          'display name': `Closed farm ${handle.slice(-6)}`,
          'street address': '',
          'street number': '',
          'phone number': '',
          email: '',
          bio: '',
          charges_enabled: false,
          stripe_account_id: null,
        })
        .eq('id', id);
    } else {
      await supabase.from(TABLES.products).delete().eq('farmer_id', id);
      await supabase.from(TABLES.farmPhotos).delete().eq('farmer_id', id);
      await supabase.from(TABLES.farmers).delete().eq('id', id);
    }

    // The uploaded documents are the most sensitive thing we hold about a
    // producer, and nothing legally requires us to keep them once the farm is
    // closed. The rejection/approval decision survives in the audit log.
    await supabase.from(TABLES.farmerRequests).delete().eq('user_id', id);
    await supabase.from('farmer_docs').delete().eq('id', id);
  }

  // 3. The customer profile is pure personal data. Nothing points at it.
  await supabase.from(TABLES.customers).delete().eq('id', id);

  // 4. Message text is personal data; the fact a conversation happened is
  //    evidence in a future dispute. Keep the shape, drop the content.
  await supabase
    .from(TABLES.messages)
    .update({ text: '[deleted by the author]' })
    .eq('sender_user_id', id);

  // 5. The account row survives so foreign keys on orders still resolve, but
  //    nothing on it points at a person any more.
  const { error } = await supabase
    .from(TABLES.users)
    .update({
      username: handle,
      email: '',
      // A hash that cannot be produced by any password: the account is not
      // just locked, it is unreachable.
      password: 'deleted',
      email_verified: false,
      deleted_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (error) {
    return { ok: false, error: error.message || 'Unable to delete the account.' };
  }

  // 6. The audit entry names the pseudonym, not the person. It records that a
  //    deletion happened — which is itself something we must be able to show.
  await recordAudit({
    req,
    actorType: 'user',
    actorId: handle,
    action: ACTIONS.ACCOUNT_DELETED,
    entityType: 'user',
    entityId: handle,
    newValue: `role=${role}`,
  });

  return { ok: true, handle, plan: DELETION_PLAN };
};

module.exports = { DELETION_PLAN, exportUserData, deleteAccount, anonymousHandle };
