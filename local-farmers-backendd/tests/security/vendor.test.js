// SEC-03 (documente private, adrese semnate), SEC-10 (PDF acceptat),
// SEC-11 (jurnal de audit la schimbarea IBAN-ului).

const request = require('supertest');

const {
  buildApp,
  browserHeaders,
  sessionCookieFor,
  adminCookie,
} = require('../helpers/appHarness');

const VENDOR = { id: '77', role: 'vendor', tokenVersion: 0 };

const PDF_BYTES = Buffer.from('%PDF-1.4\n%fake pdf pentru test\n');
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489',
  'hex',
);

const seed = () => ({
  users: [
    { id: '77', username: 'ferma', email: 'ferma@example.com', user_type: 'farmer', token_version: 0 },
  ],
  farmers: [
    {
      id: '77',
      'farm name': 'Gradina Verde',
      'display name': 'Gradina',
      email: 'ferma@example.com',
      IBAN: 'RO49AAAA1B31007593840000',
    },
  ],
  farmer_requests: [
    {
      id: 'req-1',
      user_id: '77',
      farm_name: 'Gradina Verde',
      status: 'approved',
      iban: 'RO49AAAA1B31007593840000',
      farm_images: [],
      documents: {
        atestat_prod: 'folder_abc/atestat_prod.jpg',
        // Adresă publică salvată înainte de migrare: trebuie tot semnată.
        cui: 'https://x.supabase.co/storage/v1/object/public/docs/folder_vechi/cui.pdf',
      },
    },
  ],
  farm_photos: [],
  audit_log: [],
});

const baseProfile = {
  farmName: 'Gradina Verde',
  displayName: 'Gradina',
  email: 'ferma@example.com',
  bio: 'Legume de sezon',
};

describe('SEC-10 — încărcarea actelor', () => {
  it('acceptă un PDF, formatul firesc pentru un certificat', async () => {
    const { app, fake } = buildApp(seed());
    const cookie = await sessionCookieFor(VENDOR);

    const response = await request(app)
      .post('/api/vendor/profile')
      .set('Cookie', cookie)
      .set(browserHeaders)
      .field('farmName', baseProfile.farmName)
      .field('iban', 'RO49AAAA1B31007593840000')
      .attach('carnet_commerce', PDF_BYTES, {
        filename: 'carnet.pdf',
        contentType: 'application/pdf',
      });

    expect(response.status).toBe(200);
    expect(fake._calls.uploads.some((u) => u.path.endsWith('.pdf'))).toBe(true);
  });

  it('acceptă în continuare imaginile', async () => {
    const { app } = buildApp(seed());
    const cookie = await sessionCookieFor(VENDOR);

    const response = await request(app)
      .post('/api/vendor/profile')
      .set('Cookie', cookie)
      .set(browserHeaders)
      .field('farmName', baseProfile.farmName)
      .field('iban', 'RO49AAAA1B31007593840000')
      .attach('atestat_prod', PNG_BYTES, {
        filename: 'atestat.png',
        contentType: 'image/png',
      });

    expect(response.status).toBe(200);
  });

  it('respinge un tip nepermis cu mesaj clar, nu cu 500', async () => {
    const { app } = buildApp(seed());
    const cookie = await sessionCookieFor(VENDOR);

    const response = await request(app)
      .post('/api/vendor/profile')
      .set('Cookie', cookie)
      .set(browserHeaders)
      .field('farmName', baseProfile.farmName)
      .field('iban', 'RO49AAAA1B31007593840000')
      .attach('atestat_prod', Buffer.from('MZ executabil'), {
        filename: 'virus.exe',
        contentType: 'application/x-msdownload',
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Invalid file type/i);
  });
});

describe('SEC-03 — documentele nu mai au adrese publice', () => {
  it('salvează calea din bucket, nu o adresă publică', async () => {
    const { app, fake } = buildApp(seed());
    const cookie = await sessionCookieFor(VENDOR);

    await request(app)
      .post('/api/vendor/profile')
      .set('Cookie', cookie)
      .set(browserHeaders)
      .field('farmName', baseProfile.farmName)
      .field('iban', 'RO49AAAA1B31007593840000')
      .attach('carnet_commerce', PDF_BYTES, {
        filename: 'carnet.pdf',
        contentType: 'application/pdf',
      });

    const stored = fake._db.farmer_requests[0].documents.carnet_commerce;
    expect(stored).toBeTruthy();
    expect(stored).not.toMatch(/^https?:/);
    expect(stored).not.toMatch(/\/public\//);
  });

  it('adminul primește o adresă semnată, cu expirare scurtă', async () => {
    const { app, fake } = buildApp(seed());

    const response = await request(app)
      .get('/api/admin/farmer-requests/req-1/documents/atestat_prod')
      .set('Cookie', adminCookie());

    expect(response.status).toBe(200);
    expect(response.body.url).toMatch(/\/signed\//);
    expect(response.body.expiresIn).toBeLessThanOrEqual(300);
    expect(fake._calls.signedUrls[0].path).toBe('folder_abc/atestat_prod.jpg');
  });

  it('semnează și documentele salvate înainte cu adresă publică', async () => {
    const { app, fake } = buildApp(seed());

    const response = await request(app)
      .get('/api/admin/farmer-requests/req-1/documents/cui')
      .set('Cookie', adminCookie());

    expect(response.status).toBe(200);
    // Calea a fost extrasă din vechea adresă publică.
    expect(fake._calls.signedUrls[0].path).toBe('folder_vechi/cui.pdf');
  });

  it('refuză accesul fără sesiune de admin', async () => {
    const { app } = buildApp(seed());
    const vendorCookie = await sessionCookieFor(VENDOR);

    const anonymous = await request(app).get(
      '/api/admin/farmer-requests/req-1/documents/atestat_prod',
    );
    const asVendor = await request(app)
      .get('/api/admin/farmer-requests/req-1/documents/atestat_prod')
      .set('Cookie', vendorCookie);

    expect(anonymous.status).toBe(401);
    expect(asVendor.status).toBe(401);
  });

  it('scrie în jurnal fiecare consultare a unui act', async () => {
    const { app, fake } = buildApp(seed());

    await request(app)
      .get('/api/admin/farmer-requests/req-1/documents/atestat_prod')
      .set('Cookie', adminCookie());

    const entry = fake._db.audit_log.find((row) => row.action === 'document.viewed');
    expect(entry).toBeTruthy();
    expect(entry.actor_type).toBe('admin');
    expect(entry.new_value).toBe('atestat_prod');
  });
});

describe('SEC-11 — jurnal la schimbarea IBAN-ului', () => {
  it('înregistrează schimbarea, cu valorile mascate', async () => {
    const { app, fake } = buildApp(seed());
    const cookie = await sessionCookieFor(VENDOR);

    await request(app)
      .post('/api/vendor/profile')
      .set('Cookie', cookie)
      .set(browserHeaders)
      .field('farmName', baseProfile.farmName)
      .field('iban', 'DE89 3704 0044 0532 0130 00');

    const entry = fake._db.audit_log.find((row) => row.action === 'iban.changed');
    expect(entry).toBeTruthy();
    expect(entry.actor_id).toBe('77');
    // Niciodată IBAN-ul complet în jurnal.
    expect(entry.old_value).toBe('RO49 •••• 0000');
    expect(entry.new_value).toBe('DE89 •••• 3000');
    expect(entry.new_value).not.toContain('37040044');
  });

  it('nu scrie nimic dacă IBAN-ul rămâne același', async () => {
    const { app, fake } = buildApp(seed());
    const cookie = await sessionCookieFor(VENDOR);

    await request(app)
      .post('/api/vendor/profile')
      .set('Cookie', cookie)
      .set(browserHeaders)
      .field('farmName', 'Alt nume de fermă')
      .field('iban', 'RO49AAAA1B31007593840000');

    expect(fake._db.audit_log.filter((row) => row.action === 'iban.changed')).toHaveLength(0);
  });

  it('respinge un IBAN cu cifra de control greșită', async () => {
    const { app } = buildApp(seed());
    const cookie = await sessionCookieFor(VENDOR);

    const response = await request(app)
      .post('/api/vendor/profile')
      .set('Cookie', cookie)
      .set(browserHeaders)
      .field('farmName', baseProfile.farmName)
      .field('iban', 'RO49AAAA1B31007593840001');

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/IBAN/i);
  });
});
