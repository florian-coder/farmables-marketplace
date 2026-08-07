// The one email layout.
//
// Transactional email is not a place to be clever. Every message is a single
// column of table rows with inline styles, because that is the only thing
// Outlook, Gmail's clipping and a ten-year-old Android client all agree on.
// No external CSS, no web fonts, no images that have to load for the message
// to make sense.
//
// Every template produces BOTH a text and an HTML body. The text version is
// not a courtesy: some clients show it by default, some people prefer it, and
// a durable-medium record of an order (GEO 34/2014) that only exists as HTML
// is a worse record.

const { OPERATOR, operatorLine } = require('../lib/operator');
const { FRONTEND_URL } = require('../lib/config');

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const INK = '#10261a';
const MUTED = '#4f6b59';
const LEAF = '#1e7a3c';
const PAPER = '#f7f9f6';
const LINE = '#dfe7e0';

/**
 * Blocks are a tiny vocabulary on purpose. A template that needs something
 * outside it is usually a template that is trying to be a web page.
 *
 *   { type: 'text',    value }
 *   { type: 'heading', value }
 *   { type: 'button',  label, url }
 *   { type: 'rows',    rows: [[label, value], ...] }   — an order summary
 *   { type: 'note',    value }                          — small print
 */
const renderHtmlBlock = (block) => {
  if (block.type === 'heading') {
    return `<h2 style="margin:24px 0 8px;font-size:18px;line-height:1.3;color:${INK};font-family:Georgia,serif;">${escapeHtml(block.value)}</h2>`;
  }
  if (block.type === 'button') {
    return `
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
        <tr><td style="border-radius:8px;background:${LEAF};">
          <a href="${escapeHtml(block.url)}" style="display:inline-block;padding:12px 22px;font-size:15px;color:#ffffff;text-decoration:none;font-weight:600;">${escapeHtml(block.label)}</a>
        </td></tr>
      </table>`;
  }
  if (block.type === 'rows') {
    const rows = block.rows
      .map(
        ([label, value], index) => `
        <tr>
          <td style="padding:8px 0;color:${MUTED};font-size:14px;${index === 0 ? '' : `border-top:1px solid ${LINE};`}">${escapeHtml(label)}</td>
          <td style="padding:8px 0;color:${INK};font-size:14px;text-align:right;${index === 0 ? '' : `border-top:1px solid ${LINE};`}"><strong>${escapeHtml(value)}</strong></td>
        </tr>`,
      )
      .join('');
    return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:16px 0;">${rows}</table>`;
  }
  if (block.type === 'note') {
    return `<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:${MUTED};">${escapeHtml(block.value)}</p>`;
  }
  return `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${INK};">${escapeHtml(block.value)}</p>`;
};

const renderTextBlock = (block) => {
  if (block.type === 'heading') {
    return `\n${block.value}\n${'-'.repeat(block.value.length)}`;
  }
  if (block.type === 'button') {
    return `\n${block.label}: ${block.url}`;
  }
  if (block.type === 'rows') {
    return `\n${block.rows.map(([label, value]) => `  ${label}: ${value}`).join('\n')}`;
  }
  if (block.type === 'note') {
    return `\n${block.value}`;
  }
  return block.value;
};

/**
 * `preheader` is the grey line the inbox shows next to the subject. Left
 * unset, clients grab whatever text comes first — usually the greeting, which
 * tells the reader nothing.
 */
const renderEmail = ({ title, preheader = '', blocks = [] }) => {
  const htmlBlocks = blocks.map(renderHtmlBlock).join('\n');
  const textBlocks = blocks.map(renderTextBlock).join('\n');

  const html = `
<div style="margin:0;padding:24px 12px;background:${PAPER};font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</span>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid ${LINE};border-radius:12px;">
    <tr><td style="padding:28px 28px 8px;">
      <p style="margin:0 0 20px;font-size:18px;font-weight:700;color:${LEAF};font-family:Georgia,serif;">${escapeHtml(OPERATOR.brand)}</p>
      <h1 style="margin:0 0 18px;font-size:21px;line-height:1.3;color:${INK};font-family:Georgia,serif;">${escapeHtml(title)}</h1>
      ${htmlBlocks}
    </td></tr>
    <tr><td style="padding:20px 28px 26px;border-top:1px solid ${LINE};">
      <p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:${MUTED};">${escapeHtml(operatorLine())}</p>
      <p style="margin:0;font-size:12px;line-height:1.6;color:${MUTED};">
        <a href="${escapeHtml(FRONTEND_URL)}/legal/terms-customers" style="color:${MUTED};">Terms</a> ·
        <a href="${escapeHtml(FRONTEND_URL)}/legal/privacy" style="color:${MUTED};">Privacy</a> ·
        <a href="${escapeHtml(OPERATOR.anpcSalUrl)}" style="color:${MUTED};">ANPC SAL</a> ·
        <a href="${escapeHtml(OPERATOR.anpcSolUrl)}" style="color:${MUTED};">EU ODR</a>
      </p>
      <p style="margin:8px 0 0;font-size:12px;line-height:1.6;color:${MUTED};">
        This is a transactional message about your account or an order you placed. It is not marketing.
      </p>
    </td></tr>
  </table>
</div>`.trim();

  const text = [
    OPERATOR.brand.toUpperCase(),
    '',
    title,
    '='.repeat(title.length),
    '',
    textBlocks,
    '',
    '--',
    operatorLine(),
    `Terms: ${FRONTEND_URL}/legal/terms-customers`,
    `Privacy: ${FRONTEND_URL}/legal/privacy`,
    `ANPC SAL: ${OPERATOR.anpcSalUrl} · EU ODR: ${OPERATOR.anpcSolUrl}`,
    '',
    'This is a transactional message about your account or an order you placed.',
  ].join('\n');

  return { html, text };
};

module.exports = { renderEmail, escapeHtml };
