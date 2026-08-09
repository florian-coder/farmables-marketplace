import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
  Navigate,
} from 'react-router-dom';

import LandingPage from './pages/LandingPage.jsx';
import FarmersPage from './pages/FarmersPage.jsx';
import MarketsPage from './pages/MarketsPage.jsx';
import SignupPage from './pages/SignupPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import ForgotPasswordPage from './pages/ForgotPasswordPage.jsx';
import ResetPasswordPage from './pages/ResetPasswordPage.jsx';
import ChatPage from './pages/ChatPage.jsx';
import ProfilePage from './pages/ProfilePage.jsx';
import VendorPublicProfilePage from './pages/VendorPublicProfilePage.jsx';
import VendorProductsPage from './pages/VendorProductsPage.jsx';
import VendorAddProductPage from './pages/VendorAddProductPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import OrdersPage from './pages/OrdersPage.jsx';
import EarningsPage from './pages/EarningsPage.jsx';

// Split out: the legal pages pull in the Markdown renderer, which is ~65 kB
// gzipped. Almost nobody opens them, and nobody should pay for them on the
// landing page.
const LegalPage = lazy(() => import('./pages/LegalPage.jsx'));
import { apiFetch } from './lib/api.js';
import { AuthProvider, useAuth } from './lib/auth.jsx';
import { OPERATOR } from './lib/operator.js';
import { useLiveUpdates, LIVE_TOPICS } from './lib/liveUpdates.js';
import EmailStatusBanner from './components/EmailStatusBanner.jsx';

function FruitsVegIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 8c-3 0-5 2.4-5 5.3S9.1 19 12 19s5-2.4 5-5.7S15 8 12 8Z" />
      <path d="M12 8c0-1.7.8-3.1 2.3-3.8" />
      <path d="M11.2 6.4c-1.5-.8-3.2-.7-4.2.4" />
      <path
        d="M14.7 4.3c1.3-.1 2.5.6 3 1.8-1.4.4-2.5-.2-3-1.8Z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

function EggsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22c4.418 0 8-4.477 8-10 0-5.523-3.582-10-8-10S4 6.477 4 12c0 5.523 3.582 10 8 10z" />
    </svg>
  );
}

function HoneyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8h16l-1 14H5L4 8z" />
      <path d="M8 8V6a4 4 0 018 0v2" />
      <path d="M8 14h8" />
      <path d="M9 18h6" />
    </svg>
  );
}

const MARKET_MENU_ITEMS = [
  {
    to: '/markets/fruits_and_vegetables',
    label: 'Fruits & Vegetables',
    Icon: FruitsVegIcon,
  },
  {
    to: '/markets/eggs',
    label: 'Eggs',
    Icon: EggsIcon,
  },
  {
    to: '/markets/honey',
    label: 'Honey',
    Icon: HoneyIcon,
  },
];

function Navigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const { status, user, logout } = useAuth();
  const isAuthRoute = location.pathname.startsWith('/auth/');
  const showLogin = status !== 'authenticated' && !isAuthRoute;
  const isMarketsRoute = location.pathname.startsWith('/markets');
  const initial = user?.username?.charAt(0)?.toUpperCase() || '?';
  const isChatEnabled =
    status === 'authenticated' &&
    (user?.role === 'customer' || user?.role === 'vendor');
  const [chatUnreadCount, setChatUnreadCount] = useState(0);
  const [isMarketsMenuOpen, setIsMarketsMenuOpen] = useState(false);
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const isProfileRoute = location.pathname.startsWith('/profile') || location.pathname.startsWith('/vendor');

  const handleLogout = async () => {
    await logout();
    navigate('/');
  };

  const loadUnread = useCallback(async () => {
    if (!isChatEnabled) {
      setChatUnreadCount(0);
      return;
    }
    try {
      const response = await apiFetch('/api/chat/conversations', { method: 'GET' });
      const data = await response.json();
      if (!response.ok) {
        return;
      }
      const totalUnread = Number(data.totalUnread);
      if (Number.isFinite(totalUnread) && totalUnread > 0) {
        setChatUnreadCount(Math.floor(totalUnread));
        return;
      }
      const fallbackUnread = Array.isArray(data.conversations)
        ? data.conversations.reduce((sum, entry) => {
            const count = Number(entry.unreadCount);
            return Number.isFinite(count) ? sum + count : sum;
          }, 0)
        : 0;
      setChatUnreadCount(fallbackUnread > 0 ? Math.floor(fallbackUnread) : 0);
    } catch (error) {
      setChatUnreadCount(0);
    }
  }, [isChatEnabled]);

  useEffect(() => {
    loadUnread().catch(() => {});
  }, [loadUnread]);

  // SEC-01 — the badge used to come from a Supabase subscription in the
  // browser, which meant the publishable key could read every conversation on
  // the platform. The server now decides which changes reach whom, so this no
  // longer needs to know its own vendor id either.
  useLiveUpdates(
    [LIVE_TOPICS.CONVERSATIONS, LIVE_TOPICS.MESSAGES],
    () => {
      loadUnread().catch(() => {});
    },
    isChatEnabled,
  );

  useEffect(() => {
    setIsMarketsMenuOpen(false);
    setIsProfileMenuOpen(false);
  }, [location.pathname]);

  return (
    <nav className="nav">
      <Link className="brand" to="/">
        Farmables
      </Link>
      <div className="nav-links">
        <div className="nav-market-menu">
          <button
            className={`nav-market-toggle ${isMarketsRoute ? 'active' : ''}`}
            type="button"
            onClick={() => setIsMarketsMenuOpen((prev) => !prev)}
          >
            Markets
          </button>
          {isMarketsMenuOpen && (
            <div className="nav-market-dropdown">
              {MARKET_MENU_ITEMS.map(({ to, label, Icon }) => (
                <Link className="nav-market-pill" key={to} to={to}>
                  <span className="nav-market-pill-icon">
                    <Icon />
                  </span>
                  <span className="nav-market-pill-label">{label}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
        <Link to="/farmers">Farmers</Link>
        {status === 'authenticated' && (
          <Link className="nav-chat-link" to="/chat">
            Chat
            {chatUnreadCount > 0 && (
              <span className="chat-nav-badge">{chatUnreadCount}</span>
            )}
          </Link>
        )}
        {status === 'authenticated' && <Link to="/orders">Orders</Link>}
        {status === 'authenticated' && user?.role === 'vendor' && (
          <Link to="/earnings">Earnings</Link>
        )}

        {status === 'authenticated' && user?.role === 'vendor' ? (
          <div className="nav-market-menu">
            <button
              className={`nav-market-toggle ${isProfileRoute ? 'active' : ''}`}
              type="button"
              onClick={() => setIsProfileMenuOpen((prev) => !prev)}
            >
              Profile
            </button>
            {isProfileMenuOpen && (
              <div className="nav-market-dropdown">
                <Link className="nav-market-pill" to="/profile">
                  <span className="nav-market-pill-label">Farm Profile</span>
                </Link>
                <Link className="nav-market-pill" to="/vendor/products_uploaded">
                  <span className="nav-market-pill-label">My Products</span>
                </Link>
                <Link className="nav-market-pill" to="/vendor/upload_product">
                  <span className="nav-market-pill-label">Upload Products</span>
                </Link>
              </div>
            )}
          </div>
        ) : (
          <Link to="/profile">Profile</Link>
        )}
        
        {showLogin && (
          <Link className="button ghost" to="/auth/login">
            Log in
          </Link>
        )}
        {status === 'authenticated' && (
          <>
            <span className="avatar" title={user.username}>
              {initial}
            </span>
            <button className="button ghost" type="button" onClick={handleLogout}>
              Log out
            </button>
          </>
        )}
      </div>
    </nav>
  );
}

function AppShell() {
  return (
    <div className="page">
      <Navigation />
      {/* SEC-09b — an account with no reachable address finds out here, not at
          the payment step. Discovering you cannot pay while trying to pay is
          the worst possible moment for it. */}
      <EmailStatusBanner />
      <main className="main">
        <Suspense fallback={<div className="notice">Loading...</div>}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route
            path="/markets"
            element={<Navigate to="/markets/fruits_and_vegetables" />}
          />
          <Route path="/farmers" element={<FarmersPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/orders" element={<OrdersPage />} />
          <Route path="/earnings" element={<EarningsPage />} />
          <Route path="/markets/:category" element={<MarketsPage />} />
          <Route path="/auth/signup" element={<SignupPage />} />
          <Route path="/auth/login" element={<LoginPage />} />
          <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/auth/reset-password" element={<ResetPasswordPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/manage-portal/*" element={<AdminPage />} />
          <Route path="/farms/:vendorId" element={<VendorPublicProfilePage />} />
          <Route path="/vendor" element={<Navigate to="/profile" replace />} />
          <Route path="/vendor/products_uploaded" element={<VendorProductsPage />} />
          <Route path="/vendor/upload_product" element={<VendorAddProductPage />} />
          {/* One page component per document key. Adding a legal document is a
              Markdown file, a registry entry in the backend, and a line here. */}
          <Route
            path="/legal/terms-customers"
            element={<LegalPage documentKey="terms-customers" />}
          />
          <Route
            path="/legal/terms-producers"
            element={<LegalPage documentKey="terms-producers" />}
          />
          <Route path="/legal/privacy" element={<LegalPage documentKey="privacy" />} />
          <Route path="/legal/returns" element={<LegalPage documentKey="returns" />} />
          <Route path="/legal/cookies" element={<LegalPage documentKey="cookies" />} />
          <Route path="/legal/contact" element={<LegalPage documentKey="contact" />} />
          <Route path="/legal/ranking" element={<LegalPage documentKey="ranking" />} />
          <Route
            path="/termeni-si-conditii"
            element={<Navigate to="/legal/terms-customers" replace />}
          />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
        </Suspense>
      </main>
      {/* LEG-02 — the legal links and the operator identification have to be
          reachable from every page, not only from signup. OUG 34/2014 art. 6
          and Law 365/2002 art. 5 both require the trader to be identifiable
          before the customer commits to anything, and the ANPC/SAL/SOL links
          have to be findable without asking us for them. */}
      <footer className="footer">
        <div className="footer-top">
          <div className="footer-brand">
            <span className="footer-brand-name">{OPERATOR.brand}</span>
            <p className="footer-role">
              An intermediary marketplace. Each farm sells to you directly and is the seller of
              the goods — we handle the payment and hold it until you confirm your order arrived.
            </p>
          </div>

          {/* Grouped by what someone is actually looking for. Seven links in
              one undifferentiated row is a list you scan and give up on. */}
          <nav className="footer-group" aria-label="Legal documents">
            <h2 className="footer-group-title">Legal</h2>
            <ul>
              <li>
                <Link to="/legal/terms-customers">Terms &amp; Conditions</Link>
              </li>
              <li>
                <Link to="/legal/terms-producers">Producer Terms</Link>
              </li>
              <li>
                <Link to="/legal/privacy">Privacy</Link>
              </li>
              <li>
                <Link to="/legal/returns">Returns &amp; Refunds</Link>
              </li>
              <li>
                <Link to="/legal/cookies">Cookies</Link>
              </li>
            </ul>
          </nav>

          <nav className="footer-group" aria-label="Transparency">
            <h2 className="footer-group-title">Transparency</h2>
            <ul>
              <li>
                <Link to="/legal/ranking">How ranking works</Link>
              </li>
              <li>
                <Link to="/legal/contact">Contact us</Link>
              </li>
            </ul>
          </nav>

          {/* LEG-02 — these three have to be findable without asking us for
              them, which is the whole point of publishing them. */}
          <nav className="footer-group" aria-label="Consumer protection">
            <h2 className="footer-group-title">Consumer protection</h2>
            <ul>
              <li>
                <a href={OPERATOR.anpcUrl} target="_blank" rel="noreferrer noopener">
                  ANPC
                  <ExternalMark />
                </a>
              </li>
              <li>
                <a href={OPERATOR.anpcSalUrl} target="_blank" rel="noreferrer noopener">
                  ANPC — SAL
                  <ExternalMark />
                </a>
              </li>
              <li>
                <a href={OPERATOR.anpcSolUrl} target="_blank" rel="noreferrer noopener">
                  EU ODR
                  <ExternalMark />
                </a>
              </li>
            </ul>
          </nav>
        </div>

        {/* The identification block. Discreet, never hidden — no accordion,
            no "show more": it has to be readable on every page. */}
        <address className="footer-operator">
          <span className="footer-operator-name">{OPERATOR.legalName}</span>
          <span className="footer-operator-facts">
            <span>CUI {OPERATOR.cui}</span>
            <span>{OPERATOR.tradeRegister}</span>
            <span>{OPERATOR.address}</span>
          </span>
          <span className="footer-operator-contact">
            <a href={`mailto:${OPERATOR.email}`}>{OPERATOR.email}</a>
            <a href={`tel:${OPERATOR.phone.replace(/\s+/g, '')}`}>{OPERATOR.phone}</a>
          </span>
        </address>
      </footer>
    </div>
  );
}

/** Marks a link that leaves the site, so a new tab is never a surprise. */
const ExternalMark = () => (
  <svg
    className="footer-external"
    viewBox="0 0 12 12"
    width="10"
    height="10"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    aria-hidden="true"
  >
    <path d="M4.5 2.5h5v5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9.5 2.5 5 7" strokeLinecap="round" />
    <path d="M8 8.6v1.4a.9.9 0 0 1-.9.9H2.4a.9.9 0 0 1-.9-.9V5.2a.9.9 0 0 1 .9-.9h1.4" strokeLinecap="round" />
  </svg>
);

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppShell />
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
