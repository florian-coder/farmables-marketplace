// LEG-02 — the footer is a legal requirement, so its contents are worth
// asserting rather than eyeballing.
//
// OUG 34/2014 art. 6 and Law 365/2002 art. 5 require the trader to be
// identifiable from every page, and the ANPC / SAL / ODR routes have to be
// findable without asking us for them. Grouping the links changed the markup;
// these tests are what stop the grouping from quietly losing one.

import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from '../App.jsx';
import { OPERATOR } from '../lib/operator.js';

describe('footer', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const footer = () => screen.getByRole('contentinfo');

  it('keeps every legal document reachable from any page', () => {
    render(<App />);
    const legal = within(footer()).getByRole('navigation', { name: /legal documents/i });

    for (const [name, href] of [
      [/terms & conditions/i, '/legal/terms-customers'],
      [/producer terms/i, '/legal/terms-producers'],
      [/privacy/i, '/legal/privacy'],
      [/returns & refunds/i, '/legal/returns'],
      [/cookies/i, '/legal/cookies'],
    ]) {
      expect(within(legal).getByRole('link', { name })).toHaveAttribute('href', href);
    }
  });

  it('publishes the ranking parameters and a way to reach us', () => {
    render(<App />);
    const transparency = within(footer()).getByRole('navigation', { name: /transparency/i });

    // LEG-05 — P2B art. 5 requires the ranking parameters to be published and
    // permanently accessible, which means linked, not merely written.
    expect(within(transparency).getByRole('link', { name: /how ranking works/i })).toHaveAttribute(
      'href',
      '/legal/ranking',
    );
    expect(within(transparency).getByRole('link', { name: /contact us/i })).toHaveAttribute(
      'href',
      '/legal/contact',
    );
  });

  it('sends the consumer-protection routes off-site, in a new tab', () => {
    render(<App />);
    const protection = within(footer()).getByRole('navigation', {
      name: /consumer protection/i,
    });

    for (const [name, href] of [
      [/^anpc$/i, OPERATOR.anpcUrl],
      [/anpc — sal/i, OPERATOR.anpcSalUrl],
      [/eu odr/i, OPERATOR.anpcSolUrl],
    ]) {
      const link = within(protection).getByRole('link', { name });
      expect(link).toHaveAttribute('href', href);
      expect(link).toHaveAttribute('target', '_blank');
      // Without `noopener` the opened page can navigate ours.
      expect(link.getAttribute('rel')).toContain('noopener');
    }
  });

  it('identifies the trader on the page, without an accordion to open', () => {
    render(<App />);
    const identification = footer().querySelector('address');

    expect(identification).toBeInTheDocument();
    expect(identification).toHaveTextContent(OPERATOR.legalName);
    expect(identification).toHaveTextContent(OPERATOR.cui);
    expect(identification).toHaveTextContent(OPERATOR.tradeRegister);
    expect(identification).toHaveTextContent(OPERATOR.address);
    expect(within(identification).getByRole('link', { name: OPERATOR.email })).toHaveAttribute(
      'href',
      `mailto:${OPERATOR.email}`,
    );
  });

  it('says plainly that the platform is not the seller', () => {
    render(<App />);

    // DSA / distance-selling: the customer must know who they are contracting
    // with, and it is not us.
    expect(footer()).toHaveTextContent(/each farm sells to you directly and is the seller/i);
  });
});
