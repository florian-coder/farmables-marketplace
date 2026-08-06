import { Suspense, lazy, useEffect, useState } from 'react';
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
import { supabase } from './lib/supabase.js';

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

  useEffect(() => {
    if (!isChatEnabled) {
      setChatUnreadCount(0);
      return undefined;
    }

    let active = true;
    let channel = null;
    const loadUnread = async () => {
      try {
        const response = await apiFetch('/api/chat/conversations', { method: 'GET' });
        const data = await response.json();
        if (!active || !response.ok) {
          return null;
        }
        const totalUnread = Number(data.totalUnread);
        if (Number.isFinite(totalUnread) && totalUnread > 0) {
          setChatUnreadCount(Math.floor(totalUnread));
          return data;
        }
        const fallbackUnread = Array.isArray(data.conversations)
          ? data.conversations.reduce((sum, entry) => {
              const count = Number(entry.unreadCount);
              return Number.isFinite(count) ? sum + count : sum;
            }, 0)
          : 0;
        setChatUnreadCount(fallbackUnread > 0 ? Math.floor(fallbackUnread) : 0);
        return data;
      } catch (error) {
        if (active) {
          setChatUnreadCount(0);
        }
        return null;
      }
    };

    const subscribeToUnread = async () => {
      const data = await loadUnread();
      if (!active) {
        return;
      }

      const vendorIdFromApi =
        typeof data?.vendorId === 'string' && data.vendorId.trim()
          ? data.vendorId.trim()
          : '';
      const participantId =
        user?.role === 'vendor' && vendorIdFromApi ? vendorIdFromApi : user?.id;
      if (!participantId) {
        return;
      }

      const filter =
        user?.role === 'customer'
          ? `customer_id=eq.${participantId}`
          : `vendor_id=eq.${participantId}`;

      channel = supabase
        .channel(`nav-chat-unread-${user?.id}-${participantId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'conversations',
            filter,
          },
          () => {
            loadUnread().catch(() => {});
          },
        )
        .subscribe();
    };

    subscribeToUnread().catch(() => {});

    return () => {
      active = false;
      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, [isChatEnabled, user?.id, user?.role]);

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
              Markdown file plus a line here. */}
          <Route
            path="/legal/terms-customers"
            element={<LegalPage documentKey="terms-customers" />}
          />
          <Route
            path="/legal/terms-producers"
            element={<LegalPage documentKey="terms-producers" />}
          />
          <Route
            path="/termeni-si-conditii"
            element={<Navigate to="/legal/terms-customers" replace />}
          />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
        </Suspense>
      </main>
      {/* The legal links have to be reachable from every page, not only from
          signup. The operator identification block and the ANPC/SAL links come
          with the rest of the legal delivery — the placeholders below are the
          slots they drop into. */}
      <footer className="footer">
        <nav className="footer-legal" aria-label="Legal documents">
          <Link to="/legal/terms-customers">Terms &amp; Conditions</Link>
          <Link to="/legal/terms-producers">Producer Terms</Link>
        </nav>
        <p>Farmables — built for community-powered food systems.</p>
      </footer>
    </div>
  );
}

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
