import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App.jsx';
import './styles/global.css';

const LEGACY_CLEANUP_MARKER = '__lf_supabase_cleanup_v1__';

const purgeLegacyLocalState = () => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (window.localStorage.getItem(LEGACY_CLEANUP_MARKER) === 'done') {
      return;
    }

    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem(LEGACY_CLEANUP_MARKER, 'done');
  } catch {
    // Ignore browser storage failures and continue boot.
  }
};

purgeLegacyLocalState();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
