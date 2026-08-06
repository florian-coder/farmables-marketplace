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
const { purgeLegacyState } = require('./lib/legacyCleanup');

const app = express();

app.set('trust proxy', true);

const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((origin) => origin.trim())
  : ['http://localhost:5173'];

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

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
});

module.exports = app;
