// What the frontend needs to know about the legal documents.
//
// The document *text* lives in the frontend repo as versioned Markdown. What
// lives here is which version is in force — so a browser that has been open
// since before an update cannot record consent to text nobody is showing any
// more.

const express = require('express');

const { publicRegistry } = require('../lib/legalDocuments');
const { requireAuth } = require('../middleware/auth');
const { acceptancesFor } = require('../lib/legalAcceptance');

const router = express.Router();

/** GET /api/legal/documents — the registry. Public: the signup page needs it. */
router.get('/documents', (_req, res) => {
  res.json({ documents: publicRegistry() });
});

/** GET /api/legal/my-acceptances — what the signed-in user has consented to. */
router.get('/my-acceptances', requireAuth, async (req, res, next) => {
  try {
    const acceptances = await acceptancesFor(req.user.id);
    return res.json({
      acceptances: acceptances.map((row) => ({
        documentKey: row.document_key,
        documentVersion: row.document_version,
        context: row.context,
        orderId: row.order_id,
        acceptedAt: row.accepted_at,
      })),
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
