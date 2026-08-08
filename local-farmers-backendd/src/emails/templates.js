// One function per thing that can happen.
//
// Each returns `{ subject, html, text }` from a plain data payload — no
// database access, no `await`. That is what makes them testable and what
// lets the outbox re-render a message after a template is fixed.
//
// The order confirmation is the one with legal weight: GEO 34/2014 art. 8
// requires the trader to confirm a distance contract on a durable medium,
// with the full price breakdown. That is why it repeats every number the
// customer saw at checkout instead of linking to a page that could change.

const { renderEmail } = require('./layout');
const { formatBani } = require('../lib/money');
const { FRONTEND_URL } = require('../lib/config');
const { OPERATOR } = require('../lib/operator');

const orderRef = (orderId) => String(orderId || '').slice(0, 8);
const ordersUrl = `${FRONTEND_URL}/orders`;

const STATE_SENTENCES = {
  received_by_farmer: 'The farm has your order and will start preparing it.',
  preparing_order: 'The farm is preparing your order now.',
  in_transit: 'Your order is on its way.',
  arrived: 'Your order has arrived. Please confirm you received it.',
  received: 'Thank you — your order is complete.',
  // LOG-06 — a recurring basket has been built and is waiting to be paid for.
  // Nothing is charged automatically: the amount is different every week, and
  // a stored card billed for a number nobody has seen is how chargebacks
  // happen.
  basket_ready: 'Your recurring basket is ready to review and pay for.',
};

const TEMPLATES = {
  /** A farmer has a new paid order. The one email that must never be late. */
  'order.new.farmer': ({ orderId, farmName, customerName, items = [], totalBani, deliveryFeeBani }) => {
    const lines = items.map((item) => [
      `${item.quantity} ${item.unit || ''} ${item.name}`.trim(),
      formatBani(item.lineTotalBani),
    ]);

    return {
      subject: `New order #${orderRef(orderId)} — ${formatBani(totalBani)}`,
      ...renderEmail({
        title: 'You have a new order',
        preheader: `${customerName || 'A customer'} ordered ${formatBani(totalBani)} from ${farmName}.`,
        blocks: [
          { type: 'text', value: `${customerName || 'A customer'} has paid for an order from ${farmName}.` },
          { type: 'rows', rows: [...lines, ['Delivery', formatBani(deliveryFeeBani)], ['You receive', formatBani(totalBani)]] },
          { type: 'button', label: 'Open the order', url: ordersUrl },
          {
            type: 'note',
            value:
              'Accept or decline it as soon as you can — the customer is waiting and has already been charged.',
          },
          {
            type: 'note',
            value:
              `We are holding ${formatBani(totalBani)} for you and send it to your Stripe account as soon as the ` +
              'customer confirms the order arrived — automatically after seven days if they forget.',
          },
        ],
      }),
    };
  },

  /**
   * The distance-contract confirmation. Durable medium, full breakdown.
   * Every number here is read from the frozen columns on the order, not
   * recomputed, so it says exactly what was charged.
   */
  'order.confirmation.customer': ({
    checkoutId,
    groups = [],
    productsSubtotalBani,
    deliveryFeeBani,
    commissionBani,
    totalBani,
    acceptedTerms = [],
  }) => {
    const farmRows = groups.map((group) => [
      group.farmName,
      formatBani(group.productsSubtotalBani + group.deliveryFeeBani + group.commissionBani),
    ]);

    const termsNote = acceptedTerms.length
      ? `You accepted ${acceptedTerms.map((doc) => `${doc.title} v${doc.version}`).join(', ')} when you placed this order.`
      : '';

    return {
      subject: `Order confirmed — ${formatBani(totalBani)}`,
      ...renderEmail({
        title: 'Your order is confirmed',
        preheader: `We received your payment of ${formatBani(totalBani)}. Keep this email as your record.`,
        blocks: [
          { type: 'text', value: 'Thank you. Your payment went through and the farms have been notified.' },
          { type: 'heading', value: 'What you ordered' },
          { type: 'rows', rows: farmRows },
          { type: 'heading', value: 'What you paid' },
          {
            type: 'rows',
            rows: [
              ['Products', formatBani(productsSubtotalBani)],
              ['Delivery', formatBani(deliveryFeeBani)],
              ['Platform service fee', formatBani(commissionBani)],
              ['Total charged', formatBani(totalBani)],
            ],
          },
          { type: 'button', label: 'Track your order', url: ordersUrl },
          {
            type: 'note',
            value:
              `Payment reference ${orderRef(checkoutId)}. Keep this email — it is your confirmation of the contract. ` +
              `${OPERATOR.brand} is an intermediary; each farm sells to you directly and is the seller of the goods. ` +
              termsNote,
          },
          {
            type: 'note',
            value:
              'Fresh food is exempt from the 14-day withdrawal right (OUG 34/2014 art. 16), but you keep every legal ' +
              'guarantee about the goods being what was described. If something is wrong, reply or open the order and message the farm.',
          },
          {
            type: 'note',
            value:
              `${OPERATOR.brand} holds this money until you confirm the order arrived, and only then passes it to the ` +
              'farm. If it never arrives, it comes back to you.',
          },
        ],
      }),
    };
  },

  /** Anything that moves the order along, in one sentence plus a link. */
  'order.state.customer': ({ orderId, farmName, state }) => ({
    subject: `Order #${orderRef(orderId)} — ${state.replace(/_/g, ' ')}`,
    ...renderEmail({
      title: STATE_SENTENCES[state] || 'Your order has been updated',
      preheader: `${farmName}: ${STATE_SENTENCES[state] || 'status updated'}`,
      blocks: [
        { type: 'text', value: `Your order from ${farmName} has been updated.` },
        { type: 'button', label: 'View the order', url: ordersUrl },
      ],
    }),
  }),

  /** Cancelled, and the money is on its way. Never one without the other. */
  'order.cancelled.customer': ({ orderId, farmName, reason, refundAmountBani, cancelledBy }) => ({
    subject: `Order #${orderRef(orderId)} cancelled — ${formatBani(refundAmountBani)} refunded`,
    ...renderEmail({
      title: 'Your order was cancelled',
      preheader: `${formatBani(refundAmountBani)} is on its way back to your card.`,
      blocks: [
        {
          type: 'text',
          value:
            cancelledBy === 'farmer'
              ? `${farmName} could not fulfil your order and has cancelled it.`
              : `Your order from ${farmName} has been cancelled.`,
        },
        ...(reason ? [{ type: 'text', value: `Reason given: ${reason}` }] : []),
        { type: 'rows', rows: [['Refund started', formatBani(refundAmountBani)]] },
        {
          type: 'note',
          value:
            'The refund goes back to the card you paid with. Card refunds usually appear within 5–10 business days, ' +
            'depending on your bank.',
        },
        { type: 'button', label: 'View the order', url: ordersUrl },
      ],
    }),
  }),

  /** The money actually landed at the card network. */
  'refund.completed.customer': ({ orderId, amountBani, isPartial }) => ({
    subject: `${formatBani(amountBani)} refunded — order #${orderRef(orderId)}`,
    ...renderEmail({
      title: 'Your refund has been sent',
      preheader: `${formatBani(amountBani)} is on its way back to your card.`,
      blocks: [
        {
          type: 'text',
          value: isPartial
            ? `We have refunded ${formatBani(amountBani)} for the items the farm could not supply.`
            : `We have refunded ${formatBani(amountBani)} in full.`,
        },
        {
          type: 'note',
          value:
            'It goes back to the card you paid with and usually appears within 5–10 business days. ' +
            'If it has not arrived after that, reply to this email.',
        },
      ],
    }),
  }),

  /**
   * A new chat message. Debounced to at most one per conversation per 15
   * minutes by the `event_key` — a back-and-forth conversation must not turn
   * into twenty emails.
   */
  'chat.message': ({ senderName, preview }) => ({
    subject: `New message from ${senderName}`,
    ...renderEmail({
      title: `${senderName} sent you a message`,
      preheader: preview ? preview.slice(0, 90) : 'Open the chat to read it.',
      blocks: [
        ...(preview ? [{ type: 'text', value: `"${preview}"` }] : []),
        { type: 'button', label: 'Open the chat', url: `${FRONTEND_URL}/chat` },
        {
          type: 'note',
          value: 'We send at most one of these every 15 minutes per conversation.',
        },
      ],
    }),
  }),

  'auth.verify_email': ({ verifyUrl }) => ({
    subject: 'Confirm your email address',
    ...renderEmail({
      title: 'Confirm your email address',
      preheader: 'One click and your account is ready.',
      blocks: [
        { type: 'text', value: 'Confirm this address so we can send you order updates.' },
        { type: 'button', label: 'Confirm my email', url: verifyUrl },
        { type: 'note', value: 'The link works for 24 hours. If you did not create an account, ignore this email.' },
      ],
    }),
  }),

  'auth.password_reset': ({ resetUrl }) => ({
    subject: 'Reset your password',
    ...renderEmail({
      title: 'Reset your password',
      preheader: 'The link is valid for one hour.',
      blocks: [
        { type: 'text', value: 'Use the link below to choose a new password.' },
        { type: 'button', label: 'Choose a new password', url: resetUrl },
        {
          type: 'note',
          value:
            'The link works for one hour and only once. If you did not ask for this, ignore it — your password ' +
            'has not changed, and signing in anywhere else will end this link.',
        },
      ],
    }),
  }),

  /** The farmer's products are invisible until Stripe onboarding finishes. */
  'connect.incomplete.farmer': ({ farmName, requirementsDue = [] }) => ({
    subject: 'Your farm cannot receive payments yet',
    ...renderEmail({
      title: 'Finish setting up payments',
      preheader: `${farmName} is hidden from the catalogue until Stripe has what it needs.`,
      blocks: [
        {
          type: 'text',
          value:
            `${farmName} is not visible to customers yet, because Stripe still needs some details before it can ` +
            'pay you. Nothing else is blocking you.',
        },
        ...(requirementsDue.length
          ? [{ type: 'rows', rows: requirementsDue.slice(0, 8).map((item) => ['Still needed', item]) }]
          : []),
        { type: 'button', label: 'Finish setup', url: `${FRONTEND_URL}/profile` },
      ],
    }),
  }),

  /** Money left for the farmer's own Stripe account. */
  'transfer.sent.farmer': ({ orderId, amountBani }) => ({
    subject: `${formatBani(amountBani)} sent to your account`,
    ...renderEmail({
      title: 'Your payout is on its way',
      preheader: `${formatBani(amountBani)} for order #${orderRef(orderId)}.`,
      blocks: [
        {
          type: 'text',
          value: `We have sent ${formatBani(amountBani)} for order #${orderRef(orderId)} to your Stripe account.`,
        },
        {
          type: 'note',
          value:
            'When it reaches your bank depends on your Stripe payout schedule, which you control from your ' +
            'Stripe dashboard.',
        },
        { type: 'button', label: 'See your earnings', url: `${FRONTEND_URL}/earnings` },
      ],
    }),
  }),

  'farm.approved': ({ farmName }) => ({
    subject: 'Your farm has been approved',
    ...renderEmail({
      title: 'Welcome aboard',
      preheader: `${farmName} has been approved.`,
      blocks: [
        { type: 'text', value: `${farmName} has been approved and you can start listing products.` },
        {
          type: 'text',
          value:
            'One step left: connect a Stripe account so customers can pay you. Your products stay hidden until ' +
            'that is done — we never take money we cannot pass on.',
        },
        { type: 'button', label: 'Set up payments', url: `${FRONTEND_URL}/profile` },
      ],
    }),
  }),

  'farm.rejected': ({ farmName, reviewNote }) => ({
    subject: 'About your farm application',
    ...renderEmail({
      title: 'We could not approve your application yet',
      preheader: 'Here is what needs to change.',
      blocks: [
        { type: 'text', value: `We have reviewed the application for ${farmName} and cannot approve it as it stands.` },
        ...(reviewNote ? [{ type: 'text', value: reviewNote }] : []),
        {
          type: 'note',
          value: `You can reply to this email or write to ${OPERATOR.email} if you would like to discuss it.`,
        },
      ],
    }),
  }),

  /** OPS-04 — the order closes itself if nobody confirms. */
  'order.autoconfirm_warning.customer': ({ orderId, farmName, daysLeft }) => ({
    subject: `Did your order from ${farmName} arrive?`,
    ...renderEmail({
      title: 'Please confirm your order arrived',
      preheader: `Order #${orderRef(orderId)} closes automatically in ${daysLeft} days.`,
      blocks: [
        {
          type: 'text',
          value:
            `Your order from ${farmName} was marked as delivered but you have not confirmed it yet. ` +
            `If we do not hear from you, it will close automatically in ${daysLeft} days.`,
        },
        {
          type: 'text',
          value: 'If something was wrong with it, tell us before then and we will look into it.',
        },
        { type: 'button', label: 'Confirm or report a problem', url: ordersUrl },
      ],
    }),
  }),
};

/** Render one message. Throws on an unknown template — that is a code bug. */
const renderTemplate = (template, payload = {}) => {
  const build = TEMPLATES[template];
  if (typeof build !== 'function') {
    throw new Error(`Unknown email template: ${template}`);
  }
  return build(payload);
};

module.exports = { TEMPLATES, renderTemplate };
