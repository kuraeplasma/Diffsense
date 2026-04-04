import * as apiBase from './api-base.js?v=20260329_api_base_fix1';

const PROD_API_BASE_URL = 'https://api-qf37m5ba2q-an.a.run.app';
const LOCAL_API_BASE_URL = 'http://localhost:3001';

function normalizeBaseUrl(value) {
    const raw = String(value || '').trim().replace(/\/$/, '');
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        if (parsed.pathname === '/api') {
            parsed.pathname = '';
        }
        return parsed.toString().replace(/\/$/, '');
    } catch {
        return raw;
    }
}

function isLocalHostEnvironment() {
    return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
}

export function getApiBaseUrl() {
    if (typeof apiBase.getApiBaseUrl === 'function') {
        return apiBase.getApiBaseUrl();
    }
    return isLocalHostEnvironment() ? LOCAL_API_BASE_URL : PROD_API_BASE_URL;
}

export function shouldUseLocalDevAuthBypass() {
    if (typeof apiBase.shouldUseLocalDevAuthBypass === 'function') {
        return apiBase.shouldUseLocalDevAuthBypass();
    }

    if (!isLocalHostEnvironment()) return false;
    const apiBaseUrl = normalizeBaseUrl(getApiBaseUrl());

    try {
        const parsed = new URL(apiBaseUrl);
        return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    } catch {
        return apiBaseUrl === LOCAL_API_BASE_URL;
    }
}

export function toApiUrl(endpoint = '') {
    if (typeof apiBase.toApiUrl === 'function') {
        return apiBase.toApiUrl(endpoint);
    }

    const path = String(endpoint || '').trim();
    if (!path) return getApiBaseUrl();
    if (/^https?:\/\//i.test(path)) return path;
    return `${getApiBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}

export function resolveBackendAssetUrl(value) {
    if (typeof apiBase.resolveBackendAssetUrl === 'function') {
        return apiBase.resolveBackendAssetUrl(value);
    }

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
