const DEFAULT_MARKETS = [
  {
    id: 'm1',
    name: 'Central Market',
    lat: 44.4268,
    lng: 26.1025,
    pickupPoints: 3,
    openStands: 12,
    activeGrowers: 48,
  },
];

const normalizeText = (value, maxLength = 180) => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, maxLength);
};

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

// DEPRECATED — IBAN handling.
//
// The platform no longer collects bank details: Stripe Connect does, during
// Express onboarding, under its own KYC obligations. These three helpers stay
// only so the migration can mask what is already stored while it is being
// cleared, and so the audit log can render historical `iban.changed` entries.
// Nothing new should call them.

/** IBAN stocat fără spații și cu majuscule, ca să fie comparabil. */
const normalizeIban = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/[\s-]/g, '').toUpperCase().slice(0, 34);
};

/** Verificarea mod-97 din ISO 13616: prinde cifrele tastate greșit. */
const isValidIban = (value) => {
  const iban = normalizeIban(value);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) {
    return false;
  }

  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  const digits = rearranged.replace(/[A-Z]/g, (letter) =>
    String(letter.charCodeAt(0) - 55),
  );

  let remainder = 0;
  for (const digit of digits) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
};

/** Doar țara și ultimele patru cifre pleacă spre pagina de câștiguri. */
const maskIban = (value) => {
  const iban = normalizeIban(value);
  if (!iban) {
    return '';
  }
  if (iban.length <= 8) {
    return iban;
  }
  return `${iban.slice(0, 4)} •••• ${iban.slice(-4)}`;
};

const toApiRole = (userType) => (userType === 'farmer' ? 'vendor' : 'customer');
const toDbUserType = (role) => (role === 'vendor' ? 'farmer' : 'customer');

const toBooleanAvailability = (value) => {
  if (typeof value === 'boolean') {
    return value;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return value !== false;
  }
  return parsed === 1;
};

const toIntFlag = (value) => (value ? 1 : 0);

const mapDbUserToApi = (user) => ({
  id: String(user.id),
  username: user.username || '',
  role: toApiRole(user.user_type),
});

const mapFarmPhotoRowsToUrls = (rows) => {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows
    .filter((entry) => typeof entry?.image_url === 'string')
    .sort((a, b) => {
      if (Boolean(a.is_cover) === Boolean(b.is_cover)) {
        return Number(a.id || 0) - Number(b.id || 0);
      }
      return a.is_cover ? -1 : 1;
    })
    .map((entry) => entry.image_url);
};

const mapFarmerToVendor = (farmer, options = {}) => {
  const farmImages = mapFarmPhotoRowsToUrls(options.farmPhotos || []);
  const email =
    typeof farmer?.email === 'string' && farmer.email
      ? farmer.email
      : typeof options.email === 'string'
        ? options.email
        : '';

  return {
    id: String(farmer.id),
    farmName: farmer['farm name'] || '',
    displayName: farmer['display name'] || '',
    streetAddress: farmer['street address'] || '',
    streetNumber: farmer['street number'] || '',
    county: farmer.county || '',
    city: farmer.city || '',
    phoneNumber: farmer['phone number'] || '',
    email,
    organicCertificate: farmer['organic operator certificate'] || '',
    deliveryRadiusKm: toNumberOrNull(farmer['delivery radius']),
    bio: farmer.bio || '',
    // Delivery terms the farmer sets themselves, in integer bani.
    deliveryFeeBani: Number(farmer.delivery_fee_bani || 0),
    minOrderValueBani: Number(farmer.min_order_value_bani || 0),
    freeDeliveryThresholdBani:
      farmer.free_delivery_threshold_bani === null ||
      farmer.free_delivery_threshold_bani === undefined
        ? null
        : Number(farmer.free_delivery_threshold_bani),
    farmImages,
  };
};

const mapProductImage = (productName, photoUrl) => {
  if (!photoUrl) {
    return null;
  }
  return {
    url: photoUrl,
    alt: `${productName || 'Product'} photo`,
    source: 'upload',
    photoUrl,
    photographer: 'User',
    photographerUrl: null,
  };
};

const mapProductToApi = (product, vendor = null) => ({
  id: String(product.id),
  vendorId: String(product.farmer_id),
  name: product['product name'] || '',
  category: product.category || 'fruits_and_vegetables',
  type: product.type || '',
  unit: product.Unit || 'unit',
  quantity: toNumberOrNull(product.quantity),
  price:
    typeof product.Price === 'number' && Number.isFinite(product.Price)
      ? product.Price
      : toNumberOrNull(product.Price) || 0,
  rating: toNumberOrNull(product.rating) ?? 0,
  available: toBooleanAvailability(product.available),
  isBio: toBooleanAvailability(product['bio check']),
  instantBuy: Boolean(product.instant_buy),
  image: mapProductImage(product['product name'], product['photo url']),
  vendor,
});

module.exports = {
  DEFAULT_MARKETS,
  normalizeText,
  normalizeIban,
  isValidIban,
  maskIban,
  toNumberOrNull,
  toApiRole,
  toDbUserType,
  toBooleanAvailability,
  toIntFlag,
  mapDbUserToApi,
  mapFarmPhotoRowsToUrls,
  mapFarmerToVendor,
  mapProductToApi,
};
