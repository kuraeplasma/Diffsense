function normalizeBaseUrl(value) {
    return String(value || '').trim().replace(/\/$/, '');
}

const PROD_API_BASE_URL = 'https://api-qf37m5ba2q-an.a.run.app';

export function getApiBaseUrl() {
    const params = new URLSearchParams(window.location.search);
    const explicit = normalizeBaseUrl(
        window.__DIFFSENSE_API_BASE__
        || params.get('apiBase')
        || localStorage.getItem('diffsense_api_base')
    );
    if (explicit) return explicit;

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
