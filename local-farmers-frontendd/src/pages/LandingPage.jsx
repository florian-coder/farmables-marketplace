import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { apiFetch, resolveImageUrl } from '../lib/api.js';

const HERO_IMAGE_URL =
  'https://images.pexels.com/photos/1656663/pexels-photo-1656663.jpeg';

const CATEGORY_TABS = [
  { key: 'fruits_and_vegetables', label: 'Fruits & Vegetables' },
  { key: 'eggs', label: 'Eggs' },
  { key: 'honey', label: 'Honey' },
];

const CATEGORY_IMAGE_FALLBACKS = {
  fruits_and_vegetables: [
    {
      url: 'https://images.pexels.com/photos/533280/pexels-photo-533280.jpeg',
      alt: 'Fresh tomatoes',
    },
    {
      url: 'https://images.pexels.com/photos/143133/pexels-photo-143133.jpeg',
      alt: 'Fresh carrots',
    },
  ],
  eggs: [
    {
      url: 'https://images.pexels.com/photos/162712/egg-white-food-protein-162712.jpeg',
      alt: 'Farm eggs in basket',
    },
    {
      url: 'https://images.pexels.com/photos/4110251/pexels-photo-4110251.jpeg',
      alt: 'Fresh eggs on table',
    },
  ],
  honey: [
    {
      url: 'https://images.pexels.com/photos/1638280/pexels-photo-1638280.jpeg',
      alt: 'Honey jar',
    },
    {
      url: 'https://images.pexels.com/photos/1028599/pexels-photo-1028599.jpeg',
      alt: 'Honeycomb and honey dipper',
    },
  ],
};

const FALLBACK_RECOMMENDATIONS = {
  fruits_and_vegetables: {
    category: 'fruits_and_vegetables',
    label: 'Fruits & Vegetables',
    products: [
      {
        id: 'fallback-fv-1',
        name: 'Heritage Tomatoes',
        price: 5.4,
        unit: 'kg',
        vendorName: 'Riverside Green Farm',
        image: null,
      },
      {
        id: 'fallback-fv-2',
        name: 'Carrots',
        price: 3.2,
        unit: 'kg',
        vendorName: 'Garden Patch Co-op',
        image: null,
      },
    ],
  },
  honey: {
    category: 'honey',
    label: 'Honey',
    products: [
      {
        id: 'fallback-honey-1',
        name: 'Raw Acacia Honey',
        price: 8.5,
        unit: 'jar',
        vendorName: 'Morning Meadow Apiary',
        image: {
          url: 'https://images.pexels.com/photos/1638280/pexels-photo-1638280.jpeg',
          alt: 'Raw honey jar',
        },
      },
      {
        id: 'fallback-honey-2',
        name: 'Wildflower Honeycomb',
        price: 9.8,
        unit: 'box',
        vendorName: 'Forest Edge Honey',
        image: {
          url: 'https://images.pexels.com/photos/1028599/pexels-photo-1028599.jpeg',
          alt: 'Honeycomb and honey dipper',
        },
      },
    ],
  },
  eggs: {
    category: 'eggs',
    label: 'Eggs',
    products: [
      {
        id: 'fallback-eggs-1',
        name: 'Free-Range Brown Eggs',
        price: 6.1,
        unit: 'dozen',
        vendorName: 'Oakfield Poultry',
        image: {
          url: 'https://images.pexels.com/photos/162712/egg-white-food-protein-162712.jpeg',
          alt: 'Free-range eggs',
        },
      },
      {
        id: 'fallback-eggs-2',
        name: 'Pasture-Raised Quail Eggs',
        price: 4.9,
        unit: 'pack',
        vendorName: 'Hilltop Poultry',
        image: {
          url: 'https://images.pexels.com/photos/4110251/pexels-photo-4110251.jpeg',
          alt: 'Pasture-raised eggs',
        },
      },
    ],
  },
};

const FAQ_ITEMS = [
  {
    question: 'Who is it for?',
    answer:
      'For Customers: People who want real, healthy food and want to avoid the complexity of modern grocery stores. For Farmers: Local producers in Europe who want to increase their reach and keep a 95% share of their sales.',
  },
  {
    question: 'What is this platform?',
    answer:
      'It is a direct link between local farmers and people who want fresh food without contaminants.',
  },
  {
    question: 'Why use this instead of a supermarket?',
    answer: 'Supermarkets prioritize shelf-life; we prioritize quality.',
  },
  {
    question: 'Is it easy to use?',
    answer:
      "Yes. We made it simple and obvious so you don't have to deal with the complexity of a supermarket.",
  },
  {
    question: 'Who runs this?',
    answer:
      'A two-person team that wants only the best opportunities for their people. :)',
  },
  {
    question: 'Why buy here instead of a store?',
    answer:
      'Store products are often old and treated with chemicals to stay on shelves. Here, you get fresh eggs, vegetables, and fruit directly from the farm.',
  },
  {
    question: 'How do I know the food is clean?',
    answer:
      'Our focus is on farmers who avoid growth hormones and pesticides, giving you a healthier alternative to industrial food.',
  },
  {
    question: 'Is it expensive?',
    answer:
      'By removing middlemen, we keep prices fair for you while ensuring the farmer makes a better profit.',
  },
  {
    question: 'How much does it cost to sell?',
    answer:
      'We take a simple 5% commission on each sale. You keep 95% of your earnings.',
  },
  {
    question: 'Why is this better than selling to big retail?',
    answer:
      'Big supermarkets often squeeze your margins. On our site, you have the chance to make more money and reach more people directly.',
  },
  {
    question: 'Who handles the technology?',
    answer:
      'We do. Our team writes all the code internally, so we can fix issues or add features quickly.',
  },
  {
    question: 'How do I start?',
    answer:
      `Just create a farmer account. It's a direct process with no "storytelling" or complicated preamble.`,
  },
  {
    question: 'Is my data safe?',
    answer:
      'Yes. We use secure authentication, strict access controls, and rapid in-house updates when issues are found.',
  },
];

const DEFAULT_FARMER_OF_MONTH = CATEGORY_TABS.map((entry) => ({
  category: entry.key,
  categoryLabel: entry.label,
  winner: null,
}));

const formatPrice = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return '$0.00';
  }
  return `$${parsed.toFixed(2)}`;
};

const withRecommendationImageFallback = (categoryKey, product, index) => {
  if (!product || product.image?.url) {
    return product;
  }

  const fallbacks = CATEGORY_IMAGE_FALLBACKS[categoryKey];
  if (!Array.isArray(fallbacks) || fallbacks.length === 0) {
    return product;
  }

  const fallbackImage = fallbacks[index % fallbacks.length];
  if (!fallbackImage?.url) {
    return product;
  }

  return {
    ...product,
    image: {
      url: fallbackImage.url,
      alt: product.name ? `${product.name} photo` : fallbackImage.alt,
    },
  };
};

export default function LandingPage() {
  const [homeState, setHomeState] = useState({ status: 'loading', data: null });
  const [activeTab, setActiveTab] = useState(CATEGORY_TABS[0].key);
  const [openFaqIndex, setOpenFaqIndex] = useState(0);

  useEffect(() => {
    let active = true;

    const loadHomeInsights = async () => {
      try {
        const response = await apiFetch('/api/markets/home-insights', { method: 'GET' });
        if (!response.ok) {
          throw new Error('Failed to load homepage insights.');
        }
        const data = await response.json();
        if (!active) {
          return;
        }
        setHomeState({ status: 'success', data });
      } catch (error) {
        if (!active) {
          return;
        }
        setHomeState({ status: 'error', data: null });
      }
    };

    loadHomeInsights();

    return () => {
      active = false;
    };
  }, []);

  const recommendationsByCategory = useMemo(() => {
    const fromApi = homeState.data?.dailyRecommendations;

    return Object.fromEntries(
      CATEGORY_TABS.map((entry) => {
        const apiEntry =
          fromApi && typeof fromApi === 'object' ? fromApi[entry.key] : null;
        const safeProducts = Array.isArray(apiEntry?.products)
          ? apiEntry.products
          : FALLBACK_RECOMMENDATIONS[entry.key].products;
        const productsWithFallbackImages = safeProducts.map((product, index) =>
          withRecommendationImageFallback(entry.key, product, index),
        );

        return [
          entry.key,
          {
            category: entry.key,
            label: apiEntry?.label || entry.label,
            products: productsWithFallbackImages,
          },
        ];
      }),
    );
  }, [homeState.data]);

  const activeRecommendationProducts =
    recommendationsByCategory[activeTab]?.products || [];

  const farmerOfMonthCards = useMemo(() => {
    const apiCategories = homeState.data?.farmerOfMonth?.categories;
    const apiByCategory = new Map(
      (Array.isArray(apiCategories) ? apiCategories : []).map((entry) => [
        entry.category,
        entry,
      ]),
    );

    return DEFAULT_FARMER_OF_MONTH.map((entry) => {
      const apiEntry = apiByCategory.get(entry.category);
      return {
        category: entry.category,
        categoryLabel: apiEntry?.categoryLabel || entry.categoryLabel,
        winner: apiEntry?.winner || null,
      };
    });
  }, [homeState.data]);

  const farmerOfMonthMeta = homeState.data?.farmerOfMonth || null;
  const isLiveInsights = homeState.status === 'success';

  return (
    <>
      <header className="landing-hero">
        <div className="landing-hero-content">
          <p className="eyebrow">Local Farmers Collective</p>
          <h1>
            healthy people need appreciated farmers, we&apos;re here to look out
            for both
          </h1>
          <p className="lead">
            Our people deserve the best, and so do our farmers!
          </p>
          <div className="cta-row">
            <Link className="button primary" to="/markets">
              Discover markets
            </Link>
            <Link className="button ghost" to="/auth/signup?role=vendor">
              Start selling
            </Link>
          </div>
        </div>
        <div className="landing-hero-visual">
          <img
            src={HERO_IMAGE_URL}
            alt="Cultivated agricultural field"
            loading="eager"
          />
        </div>
      </header>

      <section className="landing-section">
        <div className="landing-section-head">
          <h2>Daily Recommendations</h2>
          <p className="muted">
            {isLiveInsights
              ? 'Fresh picks based on live marketplace activity.'
              : 'Showing curated picks while live insights are loading.'}
          </p>
        </div>
        <div className="recommendation-tabs" role="tablist" aria-label="Daily categories">
          {CATEGORY_TABS.map((entry) => (
            <button
              key={entry.key}
              id={`tab-${entry.key}`}
              className={`recommendation-tab ${activeTab === entry.key ? 'active' : ''}`}
              type="button"
              role="tab"
              aria-selected={activeTab === entry.key}
              aria-controls={`tabpanel-${entry.key}`}
              onClick={() => setActiveTab(entry.key)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div
          className="recommendation-grid"
          id={`tabpanel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`tab-${activeTab}`}
        >
          {activeRecommendationProducts.map((product, index) => {
            const resolvedImage = resolveImageUrl(product.image?.url);
            return (
              <article
                className="recommendation-card"
                key={`${activeTab}-${product.id || index}`}
                style={{ '--delay': `${index * 90}ms` }}
              >
                <div className="recommendation-media">
                  {resolvedImage ? (
                    <img
                      src={resolvedImage}
                      alt={product.image?.alt || `${product.name} photo`}
                      loading="lazy"
                    />
                  ) : (
                    <span>Farm Pick</span>
                  )}
                </div>
                <div className="recommendation-body">
                  <h3>{product.name}</h3>
                  <p className="muted">{product.vendorName || 'Local farmer'}</p>
                  <p className="recommendation-price">
                    {formatPrice(product.price)} / {product.unit || 'unit'}
                  </p>
                </div>
              </article>
            );
          })}
          {activeRecommendationProducts.length === 0 && (
            <article className="recommendation-empty">
              <h3>No recommendations yet</h3>
              <p className="muted">
                Products for this category will appear as soon as inventory is
                published.
              </p>
            </article>
          )}
        </div>
      </section>

      <section className="landing-section">
        <div className="landing-section-head">
          <h2>Farmer of the Month</h2>
          <p className="muted">
            Three farmers are randomly featured every month.
          </p>
          {farmerOfMonthMeta?.month && (
            <p className="muted">Selection month: {farmerOfMonthMeta.month}</p>
          )}
        </div>
        <div className="certificate-grid">
          {farmerOfMonthCards.map((entry, index) => {
            const winner = entry.winner;
            const winnerPhoto = resolveImageUrl(winner?.photoUrl);
            return (
              <article
                className="certificate-card"
                key={entry.category}
                style={{ '--delay': `${index * 120}ms` }}
              >
                <p className="certificate-seal">{entry.categoryLabel}</p>
                <div className="certificate-photo">
                  {winnerPhoto ? (
                    <img
                      src={winnerPhoto}
                      alt={`${winner?.farmerName || 'Farmer'} portrait`}
                      loading="lazy"
                    />
                  ) : (
                    <span>Pending</span>
                  )}
                </div>
                <p className="certificate-name">
                  {winner?.farmerName || 'No winner registered yet'}
                </p>
                <p className="certificate-farm">
                  {winner?.farmName || 'Waiting for available farmer profiles'}
                </p>
                {winner && (
                  <div className="certificate-metrics">
                    <p>Revenue: {formatPrice(winner.metrics?.revenue)}</p>
                    <p>Orders: {winner.metrics?.orders || 0}</p>
                    <p>Quantity: {winner.metrics?.quantity || 0}</p>
                    <p>Coefficient: {winner.coefficient || 0}</p>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <section className="landing-section faq-section">
        <div className="landing-section-head">
          <h2>FAQ</h2>
          <p className="muted">Click any question to open the answer.</p>
        </div>
        <div className="faq-list">
          {FAQ_ITEMS.map((item, index) => (
            <article
              className={`faq-item ${openFaqIndex === index ? 'open' : ''}`}
              key={item.question}
            >
              <button
                className="faq-trigger"
                type="button"
                aria-expanded={openFaqIndex === index}
                aria-controls={`faq-panel-${index}`}
                id={`faq-trigger-${index}`}
                onClick={() =>
                  setOpenFaqIndex((previous) => (previous === index ? -1 : index))
                }
              >
                <span>{item.question}</span>
                <span className="faq-indicator" aria-hidden="true">
                  {openFaqIndex === index ? '-' : '+'}
                </span>
              </button>
              <div
                className="faq-panel"
                id={`faq-panel-${index}`}
                role="region"
                aria-labelledby={`faq-trigger-${index}`}
                hidden={openFaqIndex !== index}
              >
                <p>{item.answer}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
