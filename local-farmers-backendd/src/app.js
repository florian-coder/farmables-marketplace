const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');

const path = require('path');
const healthRouter = require('./routes/health');
const authRouter = require('./routes/auth');
const vendorRouter = require('./routes/vendor');
const vendorsRouter = require('./routes/vendors');
const chatRouter = require('./routes/chat');
const profileRouter = require('./routes/profile');
const marketsRouter = require('./routes/markets');
const externalRouter = require('./routes/external');
const productsRouter = require('./routes/products');
const adminRouter = require('./routes/admin');
const ordersRouter = require('./routes/orders');
const earningsRouter = require('./routes/earnings');
const checkoutRouter = require('./routes/checkout');
const connectRouter = require('./routes/connect');
const legalRouter = require('./routes/legal');
const { purgeLegacyState } = require('./lib/legacyCleanup');

const app = express();

app.set('trust proxy', true);

const { ALLOWED_ORIGINS: allowedOrigins } = require('./lib/config');
const { requireSameOrigin } = require('./middleware/csrf');
const { writeLimiter } = require('./middleware/rateLimit');

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);
app.use(
  cors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  }),
);
app.use(morgan('dev'));

// Stripe Webhook MUST be before express.json()
const webhookRouter = require('./routes/webhook');
app.use('/api/webhook', webhookRouter);

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// SEC-04 — orice cerere care schimbă starea și poartă un cookie de sesiune
// trebuie să vină de la o origine cunoscută și să aibă antetul propriu.
// Se montează după cookieParser, ca middleware-ul să vadă cookie-urile.
app.use(requireSameOrigin);
// SEC-07 — plafon general pe scrieri; autentificarea are limite proprii,
// mult mai strânse, montate pe rutele ei.
app.use('/api', writeLimiter);
const uploadsPath = path.join(__dirname, '../public/uploads');
app.use(
  '/uploads',
  (req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  },
  express.static(uploadsPath),
);
app.use(express.static(path.join(__dirname, '../public')));

purgeLegacyState().catch((error) => {
  console.error('Failed to purge legacy local state', error);
});

app.get('/', (req, res) => {
  res.json({ message: 'Local Farmers API' });
});

app.use('/health', healthRouter);
app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/profile', profileRouter);
app.use('/api/chat', chatRouter);
app.use('/api/vendor', vendorRouter);
app.use('/api/vendors', vendorsRouter);
app.use('/api/markets', marketsRouter);
app.use('/api/external', externalRouter);
app.use('/api/products', productsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/earnings', earningsRouter);
app.use('/api/checkout', checkoutRouter);
app.use('/api/connect', connectRouter);
app.use('/api/legal', legalRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// SEC-13 — an error the user can report and we can find.
//
// The old handler logged the stack and answered "Internal Server Error". The
// user had nothing to tell us and we had nothing to search by, so the only
// way we learned about a broken flow was someone writing in. Every failure
// now carries a short id that appears both in the response and in a
// single-line JSON log entry.
app.use((err, req, res, _next) => {
  const requestId = require('crypto').randomUUID().slice(0, 8);

  console.error(
    JSON.stringify({
      level: 'error',
      requestId,
      method: req.method,
      path: req.originalUrl,
      userId: req.user?.id || null,
      message: err?.message || String(err),
      stack: err?.stack || null,
      at: new Date().toISOString(),
    }),
  );

  res.status(500).json({
    error: 'Something went wrong on our side. Quote this code if you contact us.',
    requestId,
  });
});

module.exports = app;
