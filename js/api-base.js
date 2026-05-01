function normalizeBaseUrl(value) {
    const raw = String(value || '').trim().replace(/\/$/, '');
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        if (parsed.pathname === '/api') {
            parsed.pathname = '';
            return parsed.toString().replace(/\/$/, '');
        }
    } catch {
        // keep raw value for non-URL inputs
    }
    return raw;
}

const PROD_API_BASE_URL = 'https://api-qf37m5ba2q-an.a.run.app';
const LOCAL_API_BASE_URL = 'http://localhost:3001';
const API_BASE_STORAGE_KEY = 'diffsense_api_base';

export function isLocalHostEnvironment() {
    return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
}

function syncApiBaseOverrideFromUrl() {
    if (typeof window === 'undefined') return;

    const params = new URLSearchParams(window.location.search);
    const prodApiFlag = params.get('prodApi');

    try {
        if (prodApiFlag === '1') {
            localStorage.setItem(API_BASE_STORAGE_KEY, PROD_API_BASE_URL);
            return;
        }

        if (prodApiFlag === '0') {
            localStorage.removeItem(API_BASE_STORAGE_KEY);
        }
    } catch {
        // Ignore storage access issues in restricted/private contexts.
    }
}

function readExplicitApiBase() {
    const params = new URLSearchParams(window.location.search);
    return normalizeBaseUrl(
        window.__DIFFSENSE_API_BASE__
        || params.get('apiBase')
        || localStorage.getItem(API_BASE_STORAGE_KEY)
    );
}

function shouldIgnoreExplicitBase(explicitBase) {
    if (!explicitBase) return false;
    try {
        const explicitUrl = new URL(explicitBase);
        const currentUrl = new URL(window.location.origin);
        const isLocalHost = currentUrl.hostname === 'localhost' || currentUrl.hostname === '127.0.0.1';
        if (isLocalHost) return false;

        // If override points to the same frontend origin, API calls become /contracts 404.
        return explicitUrl.host === currentUrl.host;
    } catch {
        return false;
    }
}

export function getApiBaseUrl() {
    syncApiBaseOverrideFromUrl();
    const params = new URLSearchParams(window.location.search);
    const hasRuntimeApiOverride = Boolean(window.__DIFFSENSE_API_BASE__ || params.get('apiBase'));

    // 1. Check window.API_BASE (from env.js)
    if (window.API_BASE) return normalizeBaseUrl(window.API_BASE);

    // 2. Check explicit overrides
    const explicit = readExplicitApiBase();
    if (explicit && !shouldIgnoreExplicitBase(explicit)) {
        try {
            const host = new URL(explicit).hostname;
            const isExplicitLocal = host === 'localhost' || host === '127.0.0.1';
            // Ignore stale localStorage override on localhost unless explicitly requested at runtime.
            if (!(isLocalHostEnvironment() && isExplicitLocal && !hasRuntimeApiOverride)) {
                return explicit;
            }
        } catch {
            return explicit;
        }
    }

    // On localhost, default to local backend. On production, use Cloud Run.
    if (isLocalHostEnvironment()) return LOCAL_API_BASE_URL;
    return PROD_API_BASE_URL;
}

export function shouldUseLocalDevAuthBypass() {
    if (!isLocalHostEnvironment()) return false;

    const apiBase = normalizeBaseUrl(getApiBaseUrl());
    if (!apiBase) return true;

    try {
        const parsed = new URL(apiBase);
        return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    } catch {
        return apiBase === LOCAL_API_BASE_URL;
    }
}

export function toApiUrl(endpoint = '') {
    const path = String(endpoint || '').trim();
    if (!path) return getApiBaseUrl();
    if (/^https?:\/\//i.test(path)) return path;
    return `${getApiBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}

export function resolveBackendAssetUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.startsWith('blob:') || /^https?:\/\//i.test(raw)) return raw;

    if (raw.startsWith('/uploads/')) {
        return toApiUrl(raw);
    }

    const normalized = raw.replace(/\\/g, '/');
    const uploadsIndex = normalized.toLowerCase().indexOf('/uploads/');
    if (uploadsIndex >= 0) {
        return toApiUrl(normalized.slice(uploadsIndex));
    }

    // Only convert bare filenames (no directory separators) to /uploads/ paths.
    // GCS paths like "contracts/123/file.pdf" must NOT be converted.
    if (/\.pdf($|[?#])/i.test(normalized) && !normalized.includes('/')) {
        const filename = normalized.split('/').pop();
        if (filename) {
            return toApiUrl(`/uploads/${filename}`);
        }
    }

    return '';
}

syncApiBaseOverrideFromUrl();
