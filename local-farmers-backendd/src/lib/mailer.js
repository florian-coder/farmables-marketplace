// Trimiterea de email, cu furnizor comutabil.
//
// Dacă RESEND_API_KEY nu e configurată, mesajul se scrie în consolă cu un
// avertisment vizibil. Fluxul de resetare a parolei funcționează integral și
// local, fără furnizor — dar în producție lipsa cheii trebuie observată, nu
// trecută cu vederea, așa că avertismentul e explicit.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

const fromAddress = () => process.env.MAIL_FROM || 'Farmables <onboarding@resend.dev>';

const logToConsole = (message, reason) => {
  console.warn(
    [
      '',
      '  ┌─ EMAIL NOT SENT ─────────────────────────────────────',
      `  │ Reason:     ${reason}`,
      `  │ To:         ${message.to}`,
      `  │ Subject:    ${message.subject}`,
      '  │',
      ...String(message.text || '')
        .split('\n')
        .map((line) => `  │ ${line}`),
      '  └──────────────────────────────────────────────────────',
      '',
    ].join('\n'),
  );
};

/**
 * Trimite un email. Nu aruncă: apelantul nu trebuie să afle dacă adresa
 * există sau nu, altfel fluxul de resetare devine oracol de conturi.
 */
const sendMail = async (message) => {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    logToConsole(message, 'RESEND_API_KEY is not configured');
    return { delivered: false, reason: 'not_configured' };
  }

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress(),
        to: [message.to],
        subject: message.subject,
        // Both parts, always. Some clients show the text version by default,
        // and an order confirmation that only exists as HTML is a weaker
        // durable-medium record than one that also reads as plain text.
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('[mail] Delivery failed:', response.status, detail.slice(0, 200));
      return { delivered: false, reason: 'provider_error' };
    }

    return { delivered: true };
  } catch (error) {
    console.error('[mail] Delivery threw:', error?.message || error);
    return { delivered: false, reason: 'exception' };
  }
};

module.exports = { sendMail };
