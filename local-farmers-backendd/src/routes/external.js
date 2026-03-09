const express = require('express');

const { getCacheEntry, setCacheEntry } = require('../lib/cacheStore');
const { fetchPexels } = require('../lib/external/pexels');
const { getProductImage } = require('../lib/productMedia');

const router = express.Router();
const CACHE_SCOPES = {
  pexels: 'external-pexels',
};

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

router.get('/pexels', async (req, res, next) => {
  try {
    const query = req.query.q || 'farmers market';
    const perPage = Number(req.query.per_page || 1);
    const safePerPage = Number.isFinite(perPage) && perPage > 0 ? perPage : 1;

    const key = `pexels:${query}:${safePerPage}`;
    const cached = await getCacheEntry(CACHE_SCOPES.pexels, key);
    if (cached?.photos?.length) {
      return res.json(cached);
    }

    const fresh = await fetchPexels({ query, perPage: safePerPage, locale: 'ro-RO' });
    if (fresh?.photos?.length) {
      await setCacheEntry(
        CACHE_SCOPES.pexels,
        key,
        fresh,
        1000 * 60 * 60 * 24,
      );
    }

    return res.json(fresh);
  } catch (error) {
    return next(error);
  }
});

router.get('/product-image', async (req, res, next) => {
  try {
    const name = req.query.name;
    if (!name) {
      return res.status(400).json({ error: 'name is required.' });
    }

    const image = await getProductImage(name);
    return res.json({ name, image });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
