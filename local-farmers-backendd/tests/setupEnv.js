// Valori de test pentru secretele obligatorii, ca suita să ruleze pe o mașină
// fără .env (CI, clonă proaspătă). Se aplică doar dacă variabila lipsește,
// deci nu ascunde niciodată o configurare reală, și nu ajunge în server:
// fișierul e încărcat exclusiv de jest, prin setupFiles.
// Se rulează înaintea oricărui modul, deci înaintea lui dotenv din config.js.
// dotenv nu suprascrie variabile deja setate, așa că valorile de aici câștigă
// în fața .env-ului real — testele nu trebuie să depindă de configurarea
// mașinii pe care rulează (originea CORS de producție, chei reale de Stripe).
const testDefaults = {
  SESSION_SECRET: 'test-only-session-secret-not-used-outside-jest-0123456789',
  ADMIN_SESSION_SECRET: 'test-only-admin-secret-not-used-outside-jest-0123456789',
  ADMIN_USERNAME: 'test-admin',
  ADMIN_PASSWORD: 'test-admin-password',
  CORS_ORIGINS: 'http://localhost:5173',
  FRONTEND_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_dummy_key_for_jest',
  DISABLE_RATE_LIMIT: '1',
};

for (const [key, value] of Object.entries(testDefaults)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}
