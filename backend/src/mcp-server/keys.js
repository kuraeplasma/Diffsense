const crypto = require('crypto');

function sha256Hex(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function generateOpaqueSecret(prefix = 'mcp') {
    return `${prefix}_${crypto.randomBytes(24).toString('hex')}`;
}

function buildMcpApiKeyRecord(rawKey) {
    const normalized = String(rawKey || '').trim();
    const last4 = normalized.slice(-4);
    return {
        mcpApiKeyLookup: sha256Hex(normalized),
        mcpApiKeyLast4: last4,
        mcp_updated_at: new Date().toISOString(),
        mcpApiKey: null
    };
}

function buildOpaqueTokenRecord(rawToken, extra = {}) {
    const normalized = String(rawToken || '').trim();
    return {
        lookup: sha256Hex(normalized),
        last4: normalized.slice(-4),
        ...extra
    };
}

function maskSecretForLogs(secret) {
    const value = String(secret || '').trim();
    if (!value) return '(empty)';
    if (value.length <= 8) return `${value.slice(0, 2)}***${value.slice(-1)}`;
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function maskMcpKeyForDisplay(last4) {
    const suffix = String(last4 || '').trim();
    if (!suffix) return '未発行';
    return `mcp_••••••••••••${suffix}`;
}

function sanitizeUrlForLogs(rawUrl) {
    const source = String(rawUrl || '').trim();
    if (!source) return '/';

    try {
        const parsed = new URL(source, 'http://localhost');
        const sensitiveParams = ['apiKey', 'token', 'access_token', 'refresh_token', 'client_secret', 'code'];
        sensitiveParams.forEach((key) => {
            if (parsed.searchParams.has(key)) {
                parsed.searchParams.set(key, '[redacted]');
            }
        });

        const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
        return path || '/';
    } catch {
        return source
            .replace(/([?&](?:apiKey|token|access_token|refresh_token|client_secret|code)=)[^&]+/gi, '$1[redacted]');
    }
}

module.exports = {
    sha256Hex,
    generateOpaqueSecret,
    buildMcpApiKeyRecord,
    buildOpaqueTokenRecord,
    maskSecretForLogs,
    maskMcpKeyForDisplay,
    sanitizeUrlForLogs
};
