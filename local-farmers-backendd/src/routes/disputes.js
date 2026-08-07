// OPS-03 — the customer and farmer side of a dispute.
//
// The admin side lives in `routes/admin.js`, because it needs an admin
// session and sits next to the refund tools it uses.
//
// Evidence goes into a **private** bucket and is served through short-lived
// signed URLs, for the same reason producer documents are (SEC-03): a
// photograph of someone's kitchen, next to their delivery address on the
// order, is not something to publish at a guessable URL.

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');

const { requireAuth } = require('../middleware/auth');
const { supabase, TABLES } = require('../lib/supabase');
const {
  DISPUTE_COLUMNS,
  DISPUTE_STATES,
  ACTIVE_STATES,
  mapDispute,
  openDispute,
} = require('../lib/disputes');

const router = express.Router();

const EVIDENCE_BUCKET = 'dispute-evidence';
const SIGNED_URL_TTL_SECONDS = 120;
const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
const ALLOWED_EVIDENCE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EVIDENCE_BYTES, files: 1 },
});

const actorFor = (user) => (user.role === 'vendor' ? 'farmer' : 'customer');

/** Load a dispute and confirm this user is party to it. */
const loadOwnDispute = async (disputeId, user) => {
  const { data, error } = await supabase
    .from(TABLES.disputes)
    .select(DISPUTE_COLUMNS)
    .eq('id', String(disputeId))
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  const userId = String(user.id);
  const isParty =
    (user.role === 'customer' && String(data.customer_id) === userId) ||
    (user.role === 'vendor' && String(data.farmer_id) === userId);

  return isParty ? data : null;
};

/** GET /api/disputes — the cases this user is part of. */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const column = req.user.role === 'vendor' ? 'farmer_id' : 'customer_id';
    const { data, error } = await supabase
      .from(TABLES.disputes)
      .select(DISPUTE_COLUMNS)
      .eq(column, String(req.user.id))
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Unable to load your cases.' });
    }

    return res.json({ disputes: (data || []).map(mapDispute) });
  } catch (error) {
    return next(error);
  }
});

/** POST /api/disputes — report a problem with an order. */
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const orderId = String(req.body?.orderId || '').trim();
    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required.' });
    }

    const { data: order, error } = await supabase
      .from(TABLES.orders)
      .select('id, client_id, farmer_id, checkout_id, order_state, paid_at')
      .eq('id', orderId)
      .maybeSingle();

    if (error || !order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const userId = String(req.user.id);
    const isParty =
      (req.user.role === 'customer' && String(order.client_id) === userId) ||
      (req.user.role === 'vendor' && String(order.farmer_id) === userId);
    if (!isParty) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const result = await openDispute({
      req,
      order,
      actor: actorFor(req.user),
      actorId: req.user.id,
      category: String(req.body?.category || ''),
      description: req.body?.description,
      claimedBani: req.body?.claimedBani,
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(201).json({ dispute: result.dispute });
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /api/disputes/:disputeId/respond — the farmer's side of the story.
 *
 * Responding stops the 48-hour clock. It does not decide anything: after this
 * the case is `farmer_responded` and waits for the two of them to agree or for
 * an admin to decide.
 */
router.post('/:disputeId/respond', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'vendor') {
      return res.status(403).json({ error: 'Only the farm can respond to a case.' });
    }

    const dispute = await loadOwnDispute(req.params.disputeId, req.user);
    if (!dispute) {
      return res.status(404).json({ error: 'Case not found.' });
    }
    if (!ACTIVE_STATES.includes(dispute.state)) {
      return res.status(409).json({ error: 'This case is closed.', code: 'already_closed' });
    }

    const response = String(req.body?.response || '').trim().slice(0, 2000);
    if (!response) {
      return res.status(400).json({ error: 'A response is required.' });
    }

    const { error } = await supabase
      .from(TABLES.disputes)
      .update({
        // An escalated case stays escalated: replying after the deadline is
        // welcome, but it does not take the decision back from us.
        state:
          dispute.state === DISPUTE_STATES.ESCALATED
            ? DISPUTE_STATES.ESCALATED
            : DISPUTE_STATES.FARMER_RESPONDED,
        farmer_response: response,
        farmer_responded_at: new Date().toISOString(),
      })
      .eq('id', String(dispute.id));

    if (error) {
      return res.status(500).json({ error: 'Unable to save your response.' });
    }

    return res.json({ responded: true });
  } catch (error) {
    return next(error);
  }
});

/** POST /api/disputes/:disputeId/withdraw — the customer is satisfied. */
router.post('/:disputeId/withdraw', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'customer') {
      return res.status(403).json({ error: 'Only the customer can withdraw a case.' });
    }

    const dispute = await loadOwnDispute(req.params.disputeId, req.user);
    if (!dispute) {
      return res.status(404).json({ error: 'Case not found.' });
    }
    if (!ACTIVE_STATES.includes(dispute.state)) {
      return res.status(409).json({ error: 'This case is closed.', code: 'already_closed' });
    }

    const { error } = await supabase
      .from(TABLES.disputes)
      .update({
        state: DISPUTE_STATES.WITHDRAWN,
        resolution_note: String(req.body?.note || '').slice(0, 500),
        resolved_at: new Date().toISOString(),
      })
      .eq('id', String(dispute.id));

    if (error) {
      return res.status(500).json({ error: 'Unable to withdraw the case.' });
    }

    return res.json({ withdrawn: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /api/disputes/:disputeId/evidence — a photograph is worth the argument.
 *
 * Into the private bucket. The path is stored, never a URL: storing a URL is
 * how a private file quietly becomes a public one the first time somebody
 * copies the string somewhere else.
 */
router.post('/:disputeId/evidence', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    const dispute = await loadOwnDispute(req.params.disputeId, req.user);
    if (!dispute) {
      return res.status(404).json({ error: 'Case not found.' });
    }
    if (!ACTIVE_STATES.includes(dispute.state)) {
      return res.status(409).json({ error: 'This case is closed.', code: 'already_closed' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'A file is required.' });
    }
    if (!ALLOWED_EVIDENCE_TYPES.includes(req.file.mimetype)) {
      return res.status(400).json({
        error: 'Only JPEG, PNG, WebP images and PDF files are accepted.',
      });
    }

    const extension = (req.file.originalname || '').split('.').pop()?.toLowerCase() || 'bin';
    // A random name, not the uploaded one: a filename is user input and ends
    // up in a path.
    const path = `${dispute.id}/${crypto.randomUUID()}.${extension.replace(/[^a-z0-9]/g, '')}`;

    const { error: uploadError } = await supabase.storage
      .from(EVIDENCE_BUCKET)
      .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

    if (uploadError) {
      return res.status(500).json({ error: 'Unable to store the file.' });
    }

    const { error: insertError } = await supabase.from(TABLES.disputeEvidence).insert({
      dispute_id: String(dispute.id),
      uploaded_by: String(req.user.id),
      storage_path: path,
      content_type: req.file.mimetype,
      size_bytes: req.file.size || 0,
    });

    if (insertError) {
      return res.status(500).json({ error: 'Unable to record the file.' });
    }

    return res.status(201).json({ uploaded: true });
  } catch (error) {
    return next(error);
  }
});

/** GET /api/disputes/:disputeId/evidence — signed, short-lived addresses. */
router.get('/:disputeId/evidence', requireAuth, async (req, res, next) => {
  try {
    const dispute = await loadOwnDispute(req.params.disputeId, req.user);
    if (!dispute) {
      return res.status(404).json({ error: 'Case not found.' });
    }

    const { data: rows, error } = await supabase
      .from(TABLES.disputeEvidence)
      .select('id, uploaded_by, storage_path, content_type, created_at')
      .eq('dispute_id', String(dispute.id))
      .order('created_at', { ascending: true });

    if (error) {
      return res.status(500).json({ error: 'Unable to load the evidence.' });
    }

    const files = [];
    for (const row of rows || []) {
      const { data: signed } = await supabase.storage
        .from(EVIDENCE_BUCKET)
        .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);

      files.push({
        id: String(row.id),
        uploadedBy: String(row.uploaded_by),
        contentType: row.content_type || '',
        createdAt: row.created_at || null,
        // Expires in two minutes. Long enough to render, short enough that a
        // copied address is worthless by the time it is pasted anywhere.
        url: signed?.signedUrl || null,
        expiresIn: SIGNED_URL_TTL_SECONDS,
      });
    }

    return res.json({ evidence: files });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
