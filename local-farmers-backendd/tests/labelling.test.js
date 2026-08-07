// LEG-04 — food information.
//
// Regulation (EU) 1169/2011 requires the same particulars for food sold at
// distance as for food on a shelf, available before the purchase is concluded.
// Eggs add Reg. 589/2008, honey adds HG 1050/2003, and "bio" adds Reg. (EU)
// 2018/848 — a claim that needs a certificate, not an adjective a seller picks.

const {
  ALLERGENS,
  MANDATORY_WARNINGS,
  requiredFieldsFor,
  validateLabelling,
  organicClaimAllowed,
} = require('../src/lib/labelling');

const commonFields = {
  netQuantity: '1 kg',
  originCountry: 'Romania',
  storageConditions: 'Keep refrigerated at 2–6 °C',
  durability: '2026-08-20',
};

describe('LEG-04 — the particulars every food must carry', () => {
  it('refuses to publish without them', () => {
    const result = validateLabelling({ category: 'fruits_and_vegetables', labelling: {} });

    expect(result.ok).toBe(false);
    // Named, so the farmer knows what to fill in rather than guessing.
    expect(result.missing.map((entry) => entry.key)).toEqual(
      expect.arrayContaining(['netQuantity', 'originCountry', 'storageConditions', 'durability']),
    );
  });

  it('accepts a complete listing', () => {
    const result = validateLabelling({
      category: 'fruits_and_vegetables',
      labelling: { ...commonFields, variety: 'Roma' },
    });

    expect(result.ok).toBe(true);
  });

  it('requires the variety for fresh produce, and not for honey', () => {
    expect(requiredFieldsFor('fruits_and_vegetables').map((f) => f.key)).toContain('variety');
    expect(requiredFieldsFor('honey').map((f) => f.key)).not.toContain('variety');
  });

  it('accepts only the 14 allergens the regulation lists', () => {
    const ok = validateLabelling({
      category: 'fruits_and_vegetables',
      labelling: { ...commonFields, variety: 'Roma', allergens: ['celery', 'mustard'] },
    });
    expect(ok.ok).toBe(true);

    const bad = validateLabelling({
      category: 'fruits_and_vegetables',
      labelling: { ...commonFields, variety: 'Roma', allergens: ['gluten-ish'] },
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toMatch(/1169\/2011/);
  });

  it('knows all fourteen', () => {
    expect(ALLERGENS).toHaveLength(14);
  });
});

describe('LEG-04 — eggs, Regulation 589/2008', () => {
  const eggFields = {
    ...commonFields,
    eggQualityClass: 'A',
    eggWeightGrade: 'L',
    eggFarmingMethod: 'free_range',
    producerCode: '1RO12345',
    packingDate: '2026-08-01',
    durability: '2026-08-25',
  };

  it('requires the fields that are on the box, because the box is the law', () => {
    const result = validateLabelling({ category: 'eggs', labelling: commonFields });

    expect(result.ok).toBe(false);
    expect(result.missing.map((entry) => entry.key)).toEqual(
      expect.arrayContaining([
        'eggQualityClass',
        'eggWeightGrade',
        'eggFarmingMethod',
        'producerCode',
        'packingDate',
      ]),
    );
  });

  it('accepts a properly labelled box', () => {
    expect(validateLabelling({ category: 'eggs', labelling: eggFields }).ok).toBe(true);
  });

  it('refuses a class, grade or method that is not in the regulation', () => {
    for (const patch of [
      { eggQualityClass: 'C' },
      { eggWeightGrade: 'XXL' },
      { eggFarmingMethod: 'happy' },
    ]) {
      const result = validateLabelling({ category: 'eggs', labelling: { ...eggFields, ...patch } });
      expect(result.ok).toBe(false);
    }
  });

  it('refuses a best-before more than 28 days after packing', () => {
    // Art. 12. A longer date is not a typo worth quietly accepting.
    const result = validateLabelling({
      category: 'eggs',
      labelling: { ...eggFields, packingDate: '2026-08-01', durability: '2026-10-01' },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/28 days/);
  });

  it('refuses a best-before earlier than the packing date', () => {
    const result = validateLabelling({
      category: 'eggs',
      labelling: { ...eggFields, packingDate: '2026-08-20', durability: '2026-08-01' },
    });
    expect(result.ok).toBe(false);
  });
});

describe('LEG-04 — honey', () => {
  const honeyFields = {
    ...commonFields,
    netQuantity: '500 g',
    botanicalOrigin: 'Acacia',
    harvestYear: '2026',
  };

  it('requires the floral source and the harvest year', () => {
    const result = validateLabelling({ category: 'honey', labelling: commonFields });
    expect(result.ok).toBe(false);
    expect(result.missing.map((e) => e.key)).toEqual(
      expect.arrayContaining(['botanicalOrigin', 'harvestYear']),
    );
  });

  it('adds the infant warning itself — a seller cannot forget it', () => {
    // The single most consequential string in the file: honey can carry
    // C. botulinum spores, which an infant gut cannot handle.
    const result = validateLabelling({ category: 'honey', labelling: honeyFields });

    expect(result.ok).toBe(true);
    expect(result.labelling.mandatoryWarning).toBe(MANDATORY_WARNINGS.honey);
    expect(result.labelling.mandatoryWarning).toMatch(/12 months/);
  });

  it('does not put the infant warning on things that are not honey', () => {
    const result = validateLabelling({
      category: 'fruits_and_vegetables',
      labelling: { ...commonFields, variety: 'Roma' },
    });
    expect(result.labelling.mandatoryWarning).toBe('');
  });
});

describe('LEG-04 — "bio" is a claim, not an adjective', () => {
  const future = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const past = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  it('allows the claim with an approved, unexpired certificate', () => {
    expect(organicClaimAllowed({ state: 'approved', valid_until: future }).allowed).toBe(true);
  });

  it('refuses it with no certificate at all', () => {
    expect(organicClaimAllowed(null).allowed).toBe(false);
    expect(organicClaimAllowed(null).reason).toBe('no_certificate');
  });

  it('refuses it while the certificate is still being checked', () => {
    // Otherwise "upload something, claim organic immediately" is the flow.
    const verdict = organicClaimAllowed({ state: 'pending', valid_until: future });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('pending_review');
  });

  it('refuses it on a rejected certificate', () => {
    expect(organicClaimAllowed({ state: 'rejected', valid_until: future }).allowed).toBe(false);
  });

  it('turns itself off the day the certificate lapses', () => {
    // The whole reason this is a record with a date rather than a boolean.
    const verdict = organicClaimAllowed({ state: 'approved', valid_until: past });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('expired');
  });

  it('refuses a certificate with no expiry recorded', () => {
    // An organic claim that never ends is an organic claim nobody rechecks.
    expect(organicClaimAllowed({ state: 'approved', valid_until: null }).reason).toBe('no_expiry');
  });
});
