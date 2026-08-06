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
});

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

module.exports = { ACTIONS, recordAudit };
