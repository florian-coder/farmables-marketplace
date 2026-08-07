// LEG-04 — food information, which is not optional.
//
// Regulation (EU) 1169/2011 requires the same particulars for food sold at
// distance as for food on a shelf, and requires them to be available **before
// the purchase is concluded** and again on delivery. Selling a jar of honey
// online with a name and a price is not compliant, however good the honey is.
//
// Two category-specific regimes on top of that:
//
//   * **Eggs** — Regulation (EC) 589/2008: quality class, weight grade,
//     farming method, the producer code, and a best-before of at most 28 days
//     from laying. These are the fields on the box; the box is the law.
//   * **Honey** — HG 1050/2003 and Directive 2001/110/EC: country of origin,
//     botanical/floral source if claimed, and the infant warning. Honey can
//     carry *C. botulinum* spores, which an infant gut cannot handle, and that
//     warning is the single most consequential string in this file.
//
// **"Bio" is a claim, not an adjective.** Under Regulation (EU) 2018/848,
// calling something organic without a valid certificate from an approved body
// is a misleading commercial practice (Law 363/2007). So the flag is not the
// farmer's to set: it requires a certificate an admin has checked, with an
// expiry date, and it turns itself off when that date passes.

/** Allergens as Annex II of Reg. 1169/2011 lists them. */
const ALLERGENS = Object.freeze([
  'cereals_gluten',
  'crustaceans',
  'eggs',
  'fish',
  'peanuts',
  'soybeans',
  'milk',
  'nuts',
  'celery',
  'mustard',
  'sesame',
  'sulphites',
  'lupin',
  'molluscs',
]);

const EGG_QUALITY_CLASSES = ['A', 'B'];
/** S / M / L / XL, as Reg. 589/2008 art. 4 defines them. */
const EGG_WEIGHT_GRADES = ['S', 'M', 'L', 'XL'];
const EGG_FARMING_METHODS = ['organic', 'free_range', 'barn', 'cage'];

/**
 * What every food must carry, whatever it is.
 *
 * `origin` is required for all of it: Regulation 1169/2011 art. 26 makes it
 * mandatory for unprocessed products, and it is the whole proposition of a
 * local-food marketplace anyway.
 */
const COMMON_FIELDS = [
  { key: 'netQuantity', label: 'Net quantity (e.g. 500 g, 1 kg, 750 ml)' },
  { key: 'originCountry', label: 'Country of origin' },
  { key: 'storageConditions', label: 'Storage conditions' },
  { key: 'durability', label: 'Best before / use by' },
];

/** Per category, on top of the common set. */
const CATEGORY_FIELDS = Object.freeze({
  fruits_and_vegetables: [
    // Fresh produce is exempt from the ingredient list (it is the ingredient),
    // but the variety is a quality class under the marketing standards.
    { key: 'variety', label: 'Variety' },
  ],
  eggs: [
    { key: 'eggQualityClass', label: 'Quality class (A or B)' },
    { key: 'eggWeightGrade', label: 'Weight grade (S, M, L, XL)' },
    { key: 'eggFarmingMethod', label: 'Farming method' },
    // The stamp on each egg. It is how a food-safety recall finds the flock.
    { key: 'producerCode', label: 'Producer code (stamped on the egg)' },
    { key: 'packingDate', label: 'Packing date' },
  ],
  honey: [
    { key: 'botanicalOrigin', label: 'Floral or botanical source (e.g. acacia, polyfloral)' },
    { key: 'harvestYear', label: 'Year of harvest' },
    // Also required: honey must not be given to infants under 12 months.
    // Enforced below rather than as a field, because it is not the farm's
    // choice to make.
  ],
});

/** Warnings the platform adds itself, because they are not optional. */
const MANDATORY_WARNINGS = Object.freeze({
  honey:
    'Do not give honey to infants under 12 months of age. Honey may contain Clostridium botulinum spores.',
});

const isBlank = (value) =>
  value === null || value === undefined || String(value).trim().length === 0;

const requiredFieldsFor = (category) => [
  ...COMMON_FIELDS,
  ...(CATEGORY_FIELDS[category] || []),
];

/**
 * Check a product's food information before it goes on sale.
 *
 * Returns `{ ok: true, labelling }` or `{ ok: false, missing, errors }`. The
 * caller refuses the publish — LEG-04 asks for exactly that, because a product
 * that is listed without its mandatory particulars is already non-compliant by
 * the time anyone notices.
 */
const validateLabelling = ({ category, labelling = {} }) => {
  const required = requiredFieldsFor(category);
  const missing = required
    .filter((field) => isBlank(labelling[field.key]))
    .map((field) => ({ key: field.key, label: field.label }));

  const errors = [];

  const allergens = Array.isArray(labelling.allergens) ? labelling.allergens : [];
  for (const allergen of allergens) {
    if (!ALLERGENS.includes(allergen)) {
      errors.push(`"${allergen}" is not one of the 14 allergens listed in Regulation 1169/2011.`);
    }
  }

  if (category === 'eggs') {
    if (
      !isBlank(labelling.eggQualityClass) &&
      !EGG_QUALITY_CLASSES.includes(String(labelling.eggQualityClass).toUpperCase())
    ) {
      errors.push('Egg quality class must be A or B (Regulation 589/2008).');
    }
    if (
      !isBlank(labelling.eggWeightGrade) &&
      !EGG_WEIGHT_GRADES.includes(String(labelling.eggWeightGrade).toUpperCase())
    ) {
      errors.push('Egg weight grade must be S, M, L or XL (Regulation 589/2008).');
    }
    if (
      !isBlank(labelling.eggFarmingMethod) &&
      !EGG_FARMING_METHODS.includes(String(labelling.eggFarmingMethod))
    ) {
      errors.push(
        `Farming method must be one of: ${EGG_FARMING_METHODS.join(', ')} (Regulation 589/2008).`,
      );
    }

    // Reg. 589/2008 art. 12: 28 days from laying, and the pack must not be
    // sold within 7 days of that date. A longer date is not a typo we should
    // quietly accept.
    if (!isBlank(labelling.packingDate) && !isBlank(labelling.durability)) {
      const packed = Date.parse(labelling.packingDate);
      const best = Date.parse(labelling.durability);
      if (Number.isFinite(packed) && Number.isFinite(best)) {
        const days = (best - packed) / (24 * 60 * 60 * 1000);
        if (days > 28) {
          errors.push(
            'Eggs must carry a best-before date no more than 28 days after packing (Regulation 589/2008).',
          );
        }
        if (days < 0) {
          errors.push('The best-before date cannot be before the packing date.');
        }
      }
    }
  }

  if (missing.length > 0 || errors.length > 0) {
    return { ok: false, missing, errors };
  }

  return {
    ok: true,
    labelling: {
      ...labelling,
      allergens,
      // Added by us, not by the farm. A warning that a seller can forget is
      // not a warning.
      mandatoryWarning: MANDATORY_WARNINGS[category] || '',
    },
  };
};

/**
 * May this product be sold as organic?
 *
 * Never the farmer's own say-so. Under Regulation (EU) 2018/848 the claim
 * needs a certificate from an approved control body, and the certificate has
 * an expiry — so this returns false the day it lapses, without anyone having
 * to remember.
 */
const organicClaimAllowed = (certificate, now = new Date()) => {
  if (!certificate) {
    return { allowed: false, reason: 'no_certificate' };
  }
  if (certificate.state !== 'approved') {
    return { allowed: false, reason: certificate.state === 'pending' ? 'pending_review' : 'rejected' };
  }
  if (!certificate.valid_until) {
    return { allowed: false, reason: 'no_expiry' };
  }
  if (Date.parse(certificate.valid_until) <= now.getTime()) {
    return { allowed: false, reason: 'expired' };
  }
  return { allowed: true };
};

const ORGANIC_REFUSALS = Object.freeze({
  no_certificate:
    'To list a product as organic you need a valid certificate from an approved control body. Upload one from your profile.',
  pending_review: 'Your organic certificate is still being checked. We will email you when it is done.',
  rejected: 'Your organic certificate was not accepted. Check your profile for the reason.',
  no_expiry: 'Your organic certificate has no expiry date recorded. Contact us so we can correct it.',
  expired:
    'Your organic certificate has expired, so products can no longer be listed as organic. Upload the renewal from your profile.',
});

module.exports = {
  ALLERGENS,
  EGG_QUALITY_CLASSES,
  EGG_WEIGHT_GRADES,
  EGG_FARMING_METHODS,
  COMMON_FIELDS,
  CATEGORY_FIELDS,
  MANDATORY_WARNINGS,
  ORGANIC_REFUSALS,
  requiredFieldsFor,
  validateLabelling,
  organicClaimAllowed,
};
