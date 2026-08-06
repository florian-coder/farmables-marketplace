// Configurarea sensibilă a aplicației, citită o singură dată, la pornire.
//
// Nicio valoare de aici nu are implicit. Un secret lipsă oprește procesul,
// pentru că alternativa — pornirea cu un secret cunoscut public — înseamnă
// că oricine poate semna singur un cookie de sesiune pentru orice cont.
//
// dotenv se încarcă aici, nu doar în server.js, ca orice punct de intrare
// (server, teste, scripturi) să vadă aceleași variabile. Calea e legată de
// rădăcina pachetului, nu de directorul din care s-a pornit procesul.
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

/** Minimul sub care un secret HMAC nu mai merită numit secret. */
const MIN_SECRET_LENGTH = 32;
const MIN_PASSWORD_LENGTH = 12;

const readRequired = (name, { minLength = 1 } = {}) => {
  const raw = process.env[name];
  if (typeof raw !== 'string' || !raw.trim()) {
    return { name, value: '', problem: 'lipsește' };
  }
  const value = raw.trim();
  if (value.length < minLength) {
    return {
      name,
      value: '',
      problem: `are ${value.length} caractere, minimul e ${minLength}`,
    };
  }
  return { name, value, problem: null };
};

const entries = [
  readRequired('SESSION_SECRET', { minLength: MIN_SECRET_LENGTH }),
  readRequired('ADMIN_SESSION_SECRET', { minLength: MIN_SECRET_LENGTH }),
  readRequired('ADMIN_USERNAME'),
  readRequired('ADMIN_PASSWORD', { minLength: MIN_PASSWORD_LENGTH }),
];

const problems = entries.filter((entry) => entry.problem);

if (problems.length > 0) {
  const lines = problems.map((entry) => `  - ${entry.name}: ${entry.problem}`);
  throw new Error(
    [
      'Configurare incompletă. Procesul nu pornește fără aceste variabile de mediu:',
      ...lines,
      '',
      'Generează secretele cu:  openssl rand -base64 48',
      'Pune-le în .env local și în variabilele de mediu ale serverului deployat.',
      'Nu există valori implicite: un secret cunoscut public permite oricui să',
      'semneze un cookie de sesiune pentru orice cont.',
    ].join('\n'),
  );
}

const byName = new Map(entries.map((entry) => [entry.name, entry.value]));

module.exports = {
  SESSION_SECRET: byName.get('SESSION_SECRET'),
  ADMIN_SESSION_SECRET: byName.get('ADMIN_SESSION_SECRET'),
  ADMIN_USERNAME: byName.get('ADMIN_USERNAME'),
  ADMIN_PASSWORD: byName.get('ADMIN_PASSWORD'),
};
