const { getSession, SESSION_COOKIE_NAME } = require('../lib/auth');
const { supabase, TABLES } = require('../lib/supabase');
const { mapDbUserToApi } = require('../lib/domain');
const { emailStatus } = require('../lib/emailStatus');

const getUserFromRequest = async (req) => {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (!token) {
    return null;
  }

  const session = await getSession(token);
  if (!session) {
    return null;
  }

  const { data: user, error } = await supabase
    .from(TABLES.users)
    .select('id, username, email, user_type, token_version, email_verified, deleted_at')
    .eq('id', session.userId)
    .maybeSingle();

  if (error || !user) {
    return null;
  }

  // LEG-03 — an anonymised account is not an account. The password was already
  // replaced with something no input can hash to, but a session minted before
  // the deletion would otherwise still be signed and unexpired.
  if (user.deleted_at) {
    return null;
  }

  // SEC-08: un token emis înainte de ultima revocare nu mai e valabil, chiar
  // dacă semnătura lui e corectă și nu a expirat.
  const currentVersion = Number(user.token_version || 0);
  if (Number(session.tokenVersion || 0) !== currentVersion) {
    return null;
  }

  const mapped = mapDbUserToApi(user);
  return {
    ...mapped,
    email: user.email || '',
    tokenVersion: currentVersion,
    // SEC-09b — carried on the request so routes do not each re-derive it,
    // and so the frontend can prompt before the customer reaches checkout.
    emailVerified: user.email_verified === true || user.email_verified === 1,
    emailStatus: emailStatus(user),
  };
};

const requireAuth = async (req, res, next) => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
};

const requireVendor = async (req, res, next) => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (user.role !== 'vendor') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getUserFromRequest,
  requireAuth,
  requireVendor,
};
