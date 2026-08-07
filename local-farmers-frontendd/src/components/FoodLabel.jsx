// LEG-04 — the food information, where the customer can actually see it.
//
// Regulation (EU) 1169/2011 art. 14 is specific: for distance selling, the
// mandatory particulars must be available **before the purchase is
// concluded**, and free of charge. Behind a link on a page nobody opens is
// arguably compliant and definitely not the point — so this renders inline on
// the product, collapsed, one click from the price.
//
// The infant warning for honey is the exception: it is never collapsed. It is
// the one string here that has a body count if it is missed.

import { useState } from 'react';

const FIELD_LABELS = {
  netQuantity: 'Net quantity',
  originCountry: 'Country of origin',
  storageConditions: 'Storage',
  durability: 'Best before',
  variety: 'Variety',
  eggQualityClass: 'Quality class',
  eggWeightGrade: 'Weight grade',
  eggFarmingMethod: 'Farming method',
  producerCode: 'Producer code',
  packingDate: 'Packed on',
  botanicalOrigin: 'Floral source',
  harvestYear: 'Harvest year',
};

const ALLERGEN_LABELS = {
  cereals_gluten: 'Cereals containing gluten',
  crustaceans: 'Crustaceans',
  eggs: 'Eggs',
  fish: 'Fish',
  peanuts: 'Peanuts',
  soybeans: 'Soybeans',
  milk: 'Milk',
  nuts: 'Nuts',
  celery: 'Celery',
  mustard: 'Mustard',
  sesame: 'Sesame',
  sulphites: 'Sulphur dioxide and sulphites',
  lupin: 'Lupin',
  molluscs: 'Molluscs',
};

const FARMING_METHOD_LABELS = {
  organic: 'Organic',
  free_range: 'Free range',
  barn: 'Barn',
  cage: 'Cage',
};

const displayValue = (key, value) => {
  if (key === 'eggFarmingMethod') {
    return FARMING_METHOD_LABELS[value] || value;
  }
  return value;
};

export default function FoodLabel({ product, batchCode }) {
  const [open, setOpen] = useState(false);
  const labelling = product?.labelling || {};

  // Listed before the rule existed. Saying so is more honest than showing an
  // empty panel that looks like a bug.
  if (labelling.needsAttention) {
    return (
      <p className="food-label-pending">
        Full product information is being added by the farm. Ask them in the chat before ordering if
        you need it now.
      </p>
    );
  }

  const entries = Object.entries(FIELD_LABELS)
    .filter(([key]) => labelling[key])
    .map(([key, label]) => [label, displayValue(key, labelling[key])]);

  if (entries.length === 0 && !labelling.mandatoryWarning) {
    return null;
  }

  const allergens = Array.isArray(labelling.allergens) ? labelling.allergens : [];

  return (
    <div className="food-label">
      {/* Never collapsed. This is the one string here with a body count. */}
      {labelling.mandatoryWarning && (
        <p className="food-label-warning" role="alert">
          {labelling.mandatoryWarning}
        </p>
      )}

      <button
        className="food-label-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        {open ? 'Hide product information' : 'Product information'}
      </button>

      {open && (
        <dl className="food-label-list">
          {entries.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}

          <div>
            <dt>Allergens</dt>
            <dd>
              {allergens.length > 0
                ? allergens.map((entry) => ALLERGEN_LABELS[entry] || entry).join(', ')
                : 'None declared'}
            </dd>
          </div>

          {batchCode && (
            <div>
              <dt>Batch</dt>
              <dd>{batchCode}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}
