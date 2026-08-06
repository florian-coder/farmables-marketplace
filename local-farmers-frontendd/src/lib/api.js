export const getApiBase = () => {
  const raw = import.meta.env.VITE_API_URL || 'http://localhost:3000';
  return raw.replace(/\/$/, '');
};

export const apiFetch = (path, options = {}) => {
  const { timeoutMs = 12000, signal: externalSignal, ...restOptions } = options;
  const base = getApiBase();
  const url = path.startsWith('http')
    ? path
    : `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  const controller = new AbortController();
  let timeoutId;
  let abortHandler;

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      abortHandler = () => controller.abort();
      externalSignal.addEventListener('abort', abortHandler);
    }
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }

  const fetchOptions = {
    credentials: 'include',
    ...restOptions,
    headers: {
      'Content-Type': 'application/json',
      // Antetul obligă browserul să ceară preflight, iar preflight-ul e respins
      // pentru originile străine. Fără el, un formular ascuns de pe alt site ar
      // putea trimite cereri cu cookie-ul utilizatorului atașat.
      'X-Requested-With': 'XMLHttpRequest',
      ...(restOptions.headers || {}),
    },
    signal: controller.signal,
  };

  if (restOptions.body instanceof FormData) {
    delete fetchOptions.headers['Content-Type'];
  }

  const method = (fetchOptions.method || 'GET').toUpperCase();
  if (restOptions.body === undefined && method === 'GET') {
    delete fetchOptions.body;
  }

  const fetchPromise = fetch(url, fetchOptions);
  fetchPromise.finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (externalSignal && abortHandler) {
      externalSignal.removeEventListener('abort', abortHandler);
    }
  });

  return fetchPromise;
};

export const resolveImageUrl = (url) => {
  if (!url) return null;
  if (/^(data:|blob:)/i.test(url)) {
    return url;
  }
  if (url.includes('/uploads/') || url.startsWith('uploads/')) {
    const base = getApiBase();
    const uploadsIndex = url.indexOf('/uploads/');
    const relative =
      uploadsIndex !== -1 ? url.slice(uploadsIndex) : `/${url}`;
    try {
      return new URL(relative, base).toString();
    } catch (error) {
      return relative;
    }
  }
  if (/^https?:/i.test(url)) {
    return url;
  }
  const base = getApiBase();
  const normalized = url.startsWith('/') ? url : `/${url}`;
  try {
    return new URL(normalized, base).toString();
  } catch (error) {
    return url;
  }
};

export const resolveUploadUrl = (url) => {
  if (!url) return null;
  const base = getApiBase();
  const uploadsIndex = url.indexOf('/uploads/');
  let relative = null;

  if (uploadsIndex !== -1) {
    relative = url.slice(uploadsIndex);
  } else if (url.startsWith('uploads/')) {
    relative = `/${url}`;
  } else if (url.startsWith('/uploads/')) {
    relative = url;
  }

  if (!relative) {
    return url;
  }

  try {
    return new URL(relative, base).toString();
  } catch (error) {
    return relative;
  }
};

export const isUploadImage = (image) => {
  const url = image?.url;
  if (!url || typeof url !== 'string') {
    return false;
  }
  return (
    image?.source === 'upload' ||
    url.startsWith('/uploads') ||
    url.startsWith('uploads/') ||
    url.includes('/uploads/')
  );
};
