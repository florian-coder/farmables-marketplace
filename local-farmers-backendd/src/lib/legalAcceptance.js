// Recording consent to the legal documents.
//
// LEG-02/LEG-03: what must survive is *what* the user accepted, *which version*,
// *when* and *from where*. Without the version, a consent record proves nothing
// once the text changes — which is exactly when it is needed.
//
// The table is append-only. Consent is a historical fact; it is never edited.

const { supabase, TABLES } = require('./supabase');

/** Client address, trusting the proxy only through the app's `trust proxy`. */
const clientIp = (req) => {
  const ip = req?.ip || req?.socket?.remoteAddress || '';
  return String(ip).slice(0, 60);
};

const userAgent = (req) => String(req?.headers?.['user-agent'] || '').slice(0, 400);

/**
 * Write one row per accepted document.
 *
 * Never throws. A failure here must not undo an account that was just created
 * or a payment that just cleared — but it is logged loudly, because a missing
 * consent record is a compliance gap someone has to close by hand.
 */
const recordAcceptances = async ({ req, userId, documents, context, orderId = null }) => {
  const list = Array.isArray(documents) ? documents : [];
  if (list.length === 0 || !userId) {
    return { recorded: 0 };
  }

  const rows = list.map((doc) => ({
    user_id: String(userId),
    document_key: doc.key,
    document_version: doc.version,
    context,
    order_id: orderId,
    ip: clientIp(req),
    user_agent: userAgent(req),
  }));

  const { error } = await supabase.from(TABLES.legalAcceptances).insert(rows);

  if (error) {
    console.error(
      `[legal] Unable to record consent for user ${userId} (${context}):`,
      error.message,
      '— documents:',
      list.map((doc) => `${doc.key}@${doc.version}`).join(', '),
    );
    return { recorded: 0, error: error.message };
  }

  return { recorded: rows.length };
};

/** Everything a user has ever accepted — for the GDPR data export. */
const acceptancesFor = async (userId) => {
  const { data, error } = await supabase
    .from(TABLES.legalAcceptances)
    .select('document_key, document_version, context, order_id, accepted_at')
    .eq('user_id', String(userId))
    .order('accepted_at', { ascending: false });

  if (error) {
    throw new Error(error.message || 'Unable to load consent history.');
  }
  return Array.isArray(data) ? data : [];
};

module.exports = { recordAcceptances, acceptancesFor, clientIp };
