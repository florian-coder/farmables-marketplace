// SEC-11 — Jurnal de audit.
//
// Regula: aici nu ajunge niciodată o valoare sensibilă în clar. IBAN-ul,
// parolele și tokenurile se scriu mascate. Jurnalul spune „cine, ce, când",
// nu reproduce secretul.

const { supabase, TABLES } = require('./supabase');

const ACTIONS = Object.freeze({
  IBAN_CHANGED: 'iban.changed',
  PASSWORD_CHANGED: 'password.changed',
  PASSWORD_RESET: 'password.reset',
  SESSIONS_REVOKED: 'sessions.revoked',
  ORDER_STATE_CHANGED: 'order.state_changed',
  ORDER_PAID: 'order.paid',
  ADMIN_LOGIN: 'admin.login',
  ADMIN_LOGIN_FAILED: 'admin.login_failed',
  FARM_APPROVED: 'farm.approved',
  DOCUMENT_VIEWED: 'document.viewed',
  // Stripe Connect. The payout destination is now a Stripe account id rather
  // than an IBAN, but changing it is still the most valuable action an
  // attacker could take, so it still leaves a trace.
  CONNECT_ACCOUNT_CREATED: 'connect.account_created',
  CONNECT_ACCOUNT_UPDATED: 'connect.account_updated',
  CONNECT_ONBOARDING_STARTED: 'connect.onboarding_started',
  PAYOUT_SETTINGS_CHANGED: 'payout.settings_changed',
  TRANSFER_SENT: 'transfer.sent',
  // SEC-11 — the actions that move money, change who can sell, or expose a
  // private conversation. These are the ones someone will need to reconstruct
  // months later, so they leave a trace even though nothing in the request
  // path depends on them.
  ORDER_CANCELLED: 'order.cancelled',
  TRANSFER_REVERSED: 'transfer.reversed',
  REFUND_INITIATED: 'refund.initiated',
  REFUND_COMPLETED: 'refund.completed',
  REFUND_FAILED: 'refund.failed',
  REFUND_MANUAL_REQUIRED: 'refund.manual_required',
  FARM_REJECTED: 'farm.rejected',
  FARM_DELETED: 'farm.deleted',
  FARM_SUSPENDED: 'farm.suspended',
  FARM_UNSUSPENDED: 'farm.unsuspended',
  PERMISSION_CHANGED: 'permission.changed',
  CONVERSATION_VIEWED: 'conversation.viewed',
  MESSAGE_REPORTED: 'message.reported',
  USER_BLOCKED: 'user.blocked',
  USER_UNBLOCKED: 'user.unblocked',
  DISPUTE_OPENED: 'dispute.opened',
  DISPUTE_RESOLVED: 'dispute.resolved',
  ACCOUNT_DELETED: 'account.deleted',
  DATA_EXPORTED: 'data.exported',
  ADMIN_2FA_ENROLLED: 'admin.2fa_enrolled',
  ADMIN_2FA_FAILED: 'admin.2fa_failed',
  EMAIL_CHANGED: 'email.changed',
  ORDER_FULFILMENT_RECORDED: 'order.fulfilment_recorded',
  FARM_AVAILABILITY_CHANGED: 'farm.availability_changed',
  ORGANIC_CERTIFICATE_REVIEWED: 'organic_certificate.reviewed',
});

/**
 * `a***@example.com` — enough to recognise your own address in a log, not
 * enough for a leaked log to become a mailing list.
 */
const maskEmail = (value) => {
  const email = String(value || '').trim();
  const at = email.indexOf('@');
  if (at < 1) {
    return email ? '***' : '';
  }
  return `${email[0]}***${email.slice(at)}`;
};

/** Adresa clientului, cu încredere în proxy doar prin `trust proxy` din app. */
const clientIp = (req) => {
  const ip = req?.ip || req?.socket?.remoteAddress || '';
  return String(ip).slice(0, 60);
};

const truncate = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value).slice(0, 500);
};

/**
 * Scrie o intrare în jurnal. Nu aruncă niciodată: un jurnal căzut nu are voie
 * să blocheze acțiunea pe care o descrie.
 */
const recordAudit = async ({
  req = null,
  actorType = 'user',
  actorId = '',
  action,
  entityType = '',
  entityId = '',
  oldValue = null,
  newValue = null,
}) => {
  if (!action) {
    return;
  }

  try {
    await supabase.from(TABLES.auditLog).insert({
      actor_type: actorType,
      actor_id: String(actorId || ''),
      action,
      entity_type: entityType,
      entity_id: String(entityId || ''),
      old_value: truncate(oldValue),
      new_value: truncate(newValue),
      ip: req ? clientIp(req) : '',
    });
  } catch (error) {
    console.error('[audit] Unable to write audit entry:', action, error?.message || error);
  }
};

module.exports = { ACTIONS, recordAudit, maskEmail };
