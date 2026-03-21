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

const PROD_API_BASE_URL = 'https://api-qf37m5ba2q-an.a.run.app';

export function getApiBaseUrl() {
    const params = new URLSearchParams(window.location.search);
    const explicit = normalizeBaseUrl(
        window.__DIFFSENSE_API_BASE__
        || params.get('apiBase')
        || localStorage.getItem('diffsense_api_base')
    );
    if (explicit && !shouldIgnoreExplicitBase(explicit)) return explicit;

    const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    return isLocalHost ? 'http://localhost:3001' : PROD_API_BASE_URL;
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

    if (/\.pdf($|[?#])/i.test(normalized)) {
        const filename = normalized.split('/').pop();
        if (filename) {
            return toApiUrl(`/uploads/${filename}`);
        }
    }

    return '';
}
