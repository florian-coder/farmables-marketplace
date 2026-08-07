// LEG-04 — the form the farmer fills in.
//
// These fields are not paperwork we invented: Regulation (EU) 1169/2011
// requires them for food sold at distance, eggs add Regulation 589/2008, honey
// adds HG 1050/2003. The server refuses to publish without them, so the form
// says which are required and why rather than letting the farmer discover it
// from a 400.
//
// The fields change with the category, because the law does.

const ALLERGENS = [
  ['cereals_gluten', 'Cereals containing gluten'],
  ['crustaceans', 'Crustaceans'],
  ['eggs', 'Eggs'],
  ['fish', 'Fish'],
  ['peanuts', 'Peanuts'],
  ['soybeans', 'Soybeans'],
  ['milk', 'Milk'],
  ['nuts', 'Nuts'],
  ['celery', 'Celery'],
  ['mustard', 'Mustard'],
  ['sesame', 'Sesame'],
  ['sulphites', 'Sulphites'],
  ['lupin', 'Lupin'],
  ['molluscs', 'Molluscs'],
];

export default function LabellingFields({ category, labelling, onChange }) {
  const set = (key, value) => onChange({ ...labelling, [key]: value });

  const toggleAllergen = (key) => {
    const current = Array.isArray(labelling.allergens) ? labelling.allergens : [];
    const next = current.includes(key)
      ? current.filter((entry) => entry !== key)
      : [...current, key];
    set('allergens', next);
  };

  const allergens = Array.isArray(labelling.allergens) ? labelling.allergens : [];

  return (
    <fieldset className="labelling-fields">
      <legend>Product information (required by law)</legend>
      <p className="muted labelling-intro">
        Food sold online has to carry the same information as food on a shelf, and the customer has
        to see it before they buy (Regulation (EU) 1169/2011). We cannot publish a product without
        these.
      </p>

      <label className="field">
        Net quantity
        <input
          type="text"
          placeholder="500 g, 1 kg, 750 ml"
          value={labelling.netQuantity || ''}
          onChange={(event) => set('netQuantity', event.target.value)}
          required
        />
      </label>

      <label className="field">
        Country of origin
        <input
          type="text"
          placeholder="Romania"
          value={labelling.originCountry || ''}
          onChange={(event) => set('originCountry', event.target.value)}
          required
        />
      </label>

      <label className="field">
        Storage conditions
        <input
          type="text"
          placeholder="Keep refrigerated at 2–6 °C"
          value={labelling.storageConditions || ''}
          onChange={(event) => set('storageConditions', event.target.value)}
          required
        />
      </label>

      <label className="field">
        Best before
        <input
          type="date"
          value={labelling.durability || ''}
          onChange={(event) => set('durability', event.target.value)}
          required
        />
      </label>

      {category === 'fruits_and_vegetables' && (
        <label className="field">
          Variety
          <input
            type="text"
            placeholder="Roma, Gala, Bintje..."
            value={labelling.variety || ''}
            onChange={(event) => set('variety', event.target.value)}
            required
          />
        </label>
      )}

      {category === 'eggs' && (
        <>
          <label className="field">
            Quality class
            <select
              value={labelling.eggQualityClass || 'A'}
              onChange={(event) => set('eggQualityClass', event.target.value)}
            >
              <option value="A">A — fresh, for direct sale</option>
              <option value="B">B — for processing</option>
            </select>
          </label>

          <label className="field">
            Weight grade
            <select
              value={labelling.eggWeightGrade || 'M'}
              onChange={(event) => set('eggWeightGrade', event.target.value)}
            >
              <option value="S">S — under 53 g</option>
              <option value="M">M — 53 to 63 g</option>
              <option value="L">L — 63 to 73 g</option>
              <option value="XL">XL — 73 g and over</option>
            </select>
          </label>

          <label className="field">
            Farming method
            <select
              value={labelling.eggFarmingMethod || 'free_range'}
              onChange={(event) => set('eggFarmingMethod', event.target.value)}
            >
              <option value="organic">Organic</option>
              <option value="free_range">Free range</option>
              <option value="barn">Barn</option>
              <option value="cage">Cage</option>
            </select>
          </label>

          <label className="field">
            Producer code (stamped on each egg)
            <input
              type="text"
              placeholder="1RO12345"
              value={labelling.producerCode || ''}
              onChange={(event) => set('producerCode', event.target.value)}
              required
            />
          </label>

          <label className="field">
            Packing date
            <input
              type="date"
              value={labelling.packingDate || ''}
              onChange={(event) => set('packingDate', event.target.value)}
              required
            />
            {/* Reg. 589/2008 art. 12. The server enforces it, so better to say
                it here than to be refused after filling in the whole form. */}
            <span className="muted field-hint">
              The best-before date must be no more than 28 days after packing.
            </span>
          </label>
        </>
      )}

      {category === 'honey' && (
        <>
          <label className="field">
            Floral or botanical source
            <input
              type="text"
              placeholder="Acacia, linden, polyfloral..."
              value={labelling.botanicalOrigin || ''}
              onChange={(event) => set('botanicalOrigin', event.target.value)}
              required
            />
          </label>

          <label className="field">
            Year of harvest
            <input
              type="text"
              inputMode="numeric"
              placeholder="2026"
              value={labelling.harvestYear || ''}
              onChange={(event) => set('harvestYear', event.target.value)}
              required
            />
          </label>

          <p className="notice warn labelling-warning">
            We add the mandatory warning automatically: honey must not be given to infants under 12
            months.
          </p>
        </>
      )}

      <fieldset className="labelling-allergens">
        <legend>Allergens present</legend>
        <p className="muted">
          Tick anything from the 14 in Annex II of Regulation 1169/2011 that this product contains
          or may contain. Leave all unticked if none apply.
        </p>
        <div className="labelling-allergen-grid">
          {ALLERGENS.map(([key, label]) => (
            <label className="field checkbox" key={key}>
              <input
                type="checkbox"
                checked={allergens.includes(key)}
                onChange={() => toggleAllergen(key)}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
    </fieldset>
  );
}
