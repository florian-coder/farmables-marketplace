// OPS-02 / LEG-02 — what the messages actually say.
//
// The order confirmation is the one with legal weight: GEO 34/2014 art. 8
// requires the trader to confirm a distance contract on a durable medium with
// the full price breakdown. A test that only checked "an email was queued"
// would not notice the day the commission line disappeared from it.

const { TEMPLATES, renderTemplate } = require('../src/emails/templates');

describe('every template', () => {
  const payloads = {
    'order.new.farmer': {
      orderId: 'ord-12345678',
      farmName: 'Gradina Verde',
      customerName: 'Ana Pop',
      items: [{ name: 'Rosii', unit: 'kg', quantity: 5, lineTotalBani: 10000 }],
      totalBani: 11500,
      deliveryFeeBani: 1500,
    },
    'order.confirmation.customer': {
      checkoutId: 'chk-12345678',
      groups: [
        { farmName: 'Gradina Verde', productsSubtotalBani: 10000, deliveryFeeBani: 1500, commissionBani: 1000 },
      ],
      productsSubtotalBani: 10000,
      deliveryFeeBani: 1500,
      commissionBani: 1000,
      totalBani: 12500,
      acceptedTerms: [{ title: 'Terms and Conditions for Customers', version: '1.0' }],
    },
    'order.state.customer': { orderId: 'ord-1', farmName: 'Gradina', state: 'in_transit' },
    'order.cancelled.customer': {
      orderId: 'ord-1',
      farmName: 'Gradina',
      reason: 'Hail damage',
      refundAmountBani: 12500,
      cancelledBy: 'farmer',
    },
    'refund.completed.customer': { orderId: 'ord-1', amountBani: 4400, isPartial: true },
    'chat.message': { senderName: 'Gradina Verde', preview: 'Your order is ready' },
    'auth.verify_email': { verifyUrl: 'https://example.test/verify?token=x' },
    'auth.password_reset': { resetUrl: 'https://example.test/reset?token=x' },
    'connect.incomplete.farmer': { farmName: 'Gradina', requirementsDue: ['individual.id_number'] },
    'transfer.sent.farmer': { orderId: 'ord-1', amountBani: 11500 },
    'farm.approved': { farmName: 'Gradina Verde' },
    'farm.rejected': { farmName: 'Gradina Verde', reviewNote: 'The producer certificate is missing.' },
    'order.autoconfirm_warning.customer': { orderId: 'ord-1', farmName: 'Gradina', daysLeft: 3 },
  };

  test('is covered by this test', () => {
    // A new template with no payload here would render undefined into a real
    // customer's inbox before anyone noticed.
    expect(Object.keys(payloads).sort()).toEqual(Object.keys(TEMPLATES).sort());
  });

  test.each(Object.keys(payloads))('%s renders a subject, text and HTML', (template) => {
    const message = renderTemplate(template, payloads[template]);

    expect(message.subject).toBeTruthy();
    expect(message.subject.length).toBeLessThan(120);
    expect(message.text).toBeTruthy();
    expect(message.html).toContain('<table');
    // The operator identification block is a legal requirement on every one.
    expect(message.text).toContain('CUI');
    expect(message.text).toContain('ANPC SAL');
    // Nothing rendered a hole where a value should have been.
    expect(message.text).not.toMatch(/undefined|\[object Object\]|NaN/);
    expect(message.html).not.toMatch(/undefined|\[object Object\]|NaN/);
  });

  test('an unknown template is a loud programming error', () => {
    expect(() => renderTemplate('nope', {})).toThrow(/Unknown email template/);
  });
});

describe('the order confirmation is the durable-medium record', () => {
  const message = renderTemplate('order.confirmation.customer', {
    checkoutId: 'chk-12345678',
    groups: [
      { farmName: 'Gradina Verde', productsSubtotalBani: 10000, deliveryFeeBani: 1500, commissionBani: 1000 },
    ],
    productsSubtotalBani: 10000,
    deliveryFeeBani: 1500,
    commissionBani: 1000,
    totalBani: 12500,
    acceptedTerms: [{ title: 'Terms and Conditions for Customers', version: '1.0' }],
  });

  test('states every component of the price, not just the total', () => {
    expect(message.text).toContain('100.00 RON'); // products
    expect(message.text).toContain('15.00 RON'); // delivery
    expect(message.text).toContain('10.00 RON'); // platform fee
    expect(message.text).toContain('125.00 RON'); // total charged
  });

  test('names the farm, so the customer knows who the seller is', () => {
    // The platform is an intermediary and never the seller. A confirmation
    // that hides that is the thing DSA Art. 30 and the terms both object to.
    expect(message.text).toContain('Gradina Verde');
    expect(message.text).toMatch(/intermediary/i);
  });

  test('records which version of the terms was accepted', () => {
    expect(message.text).toContain('Terms and Conditions for Customers v1.0');
  });

  test('states the withdrawal-right position for fresh food', () => {
    // OUG 34/2014 art. 16: perishables are exempt from the 14-day right.
    // Silence here reads as hiding it.
    expect(message.text).toMatch(/withdrawal/i);
    expect(message.text).toContain('16');
  });
});

describe('HTML safety', () => {
  test('a farm name with markup in it cannot inject into the email', () => {
    const message = renderTemplate('farm.approved', {
      farmName: '<script>alert(1)</script>Gradina',
    });

    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
  });
});
