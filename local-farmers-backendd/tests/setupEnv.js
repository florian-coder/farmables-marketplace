// Valori de test pentru secretele obligatorii, ca suita să ruleze pe o mașină
// fără .env (CI, clonă proaspătă). Se aplică doar dacă variabila lipsește,
// deci nu ascunde niciodată o configurare reală, și nu ajunge în server:
// fișierul e încărcat exclusiv de jest, prin setupFiles.
const testDefaults = {
  SESSION_SECRET: 'test-only-session-secret-not-used-outside-jest-0123456789',
  ADMIN_SESSION_SECRET: 'test-only-admin-secret-not-used-outside-jest-0123456789',
  ADMIN_USERNAME: 'test-admin',
  ADMIN_PASSWORD: 'test-admin-password',
};

for (const [key, value] of Object.entries(testDefaults)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}
