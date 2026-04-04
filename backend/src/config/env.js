'use strict';

function isTruthy(value) {
    return String(value || '').trim().toLowerCase() === 'true';
}

function resolveGetSecret() {
    try {
        const secrets = require('../utils/secrets');
        return typeof secrets?.getSecret === 'function' ? secrets.getSecret : null;
    } catch {
        return null;
    }
}

/**
 * Asynchronously load missing required secrets from Secret Manager (in production).
 * This populates process.env so that subsequent synchronous validation works.
 */
async function loadSecrets() {
    const isProduction = String(process.env.NODE_ENV || '').trim() === 'production';
    if (!isProduction) return;
    const getSecret = resolveGetSecret();
    if (typeof getSecret !== 'function') return;

    const secretKeys = [
        'JWT_SECRET',
        'RESEND_API_KEY',
        'FB_PRIVATE_KEY',
        'ZOHO_WEBHOOK_SECRET',
        'PAYPAL_WEBHOOK_ID',
        'STRIPE_WEBHOOK_SECRET',
        'GEMINI_API_KEY',
        'STRIPE_SECRET_KEY',
        'PAYPAL_CLIENT_ID',
        'PAYPAL_CLIENT_SECRET'
    ];

    for (const key of secretKeys) {
        // Only fetch if not already set (allows .env or container env to override)
        if (!process.env[key]) {
            await getSecret(key);
        }
    }
}

function collectEnvValidation() {
    const isProduction = String(process.env.NODE_ENV || '').trim() === 'production';
    const isCloudRuntime = Boolean(process.env.FUNCTION_TARGET || process.env.K_SERVICE);
    const errors = [];
    const warnings = [];

    if (!isProduction) {
        return { isProduction, errors, warnings };
    }

    const requiredEnvKeys = [
        'JWT_SECRET',
        'RESEND_API_KEY',
        'MAIL_FROM',
        'APP_URL',
        'FRONTEND_URL',
        'ALLOWED_ORIGINS',
        'FB_PROJECT_ID',
        'FB_CLIENT_EMAIL',
        'FB_PRIVATE_KEY',
        'FB_STORAGE_BUCKET',
        'ZOHO_WEBHOOK_SECRET',
        'PAYPAL_WEBHOOK_ID',
        'STRIPE_WEBHOOK_SECRET'
    ];

    for (const key of requiredEnvKeys) {
        if (!String(process.env[key] || '').trim()) {
            errors.push(`${key} is required in production (check Secret Manager or .env)`);
        }
    }

    if (isTruthy(process.env.AUTH_BYPASS)) {
        errors.push('AUTH_BYPASS must be false in production');
    }

    const appUrl = String(process.env.APP_URL || '').trim();
    const frontendUrl = String(process.env.FRONTEND_URL || '').trim();
    const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '').trim();

    if (appUrl && !/^https:\/\//i.test(appUrl)) {
        errors.push('APP_URL must use https in production');
    }
    if (frontendUrl && !/^https:\/\//i.test(frontendUrl)) {
        errors.push('FRONTEND_URL must use https in production');
    }
    if (allowedOrigins && !allowedOrigins.split(',').every((origin) => {
        const normalized = String(origin || '').trim();
        if (!normalized) return false;
        if (/^https:\/\//i.test(normalized)) return true;
        if (!isCloudRuntime && /^http:\/\/localhost(?::\d+)?$/i.test(normalized)) return true;
        return false;
    })) {
        errors.push('ALLOWED_ORIGINS must contain only https origins in production');
    }

    const paymentEnabled = Boolean(
        String(process.env.PAYPAL_CLIENT_ID || '').trim()
        || String(process.env.STRIPE_SECRET_KEY || '').trim()
    );
    if (paymentEnabled) {
        if (!String(process.env.PAYPAL_MODE || '').trim()) {
            warnings.push('PAYPAL_MODE is not set');
        }
        if (!String(process.env.DASHBOARD_URL || '').trim()) {
            warnings.push('DASHBOARD_URL is recommended when payment is enabled');
        }
    }

    if (!String(process.env.GEMINI_API_KEY || '').trim()) {
        warnings.push('GEMINI_API_KEY is not set; AI analysis may not work');
    }

    return { isProduction, errors, warnings };
}

function assertProductionEnv() {
    const result = collectEnvValidation();
    if (result.isProduction && result.errors.length > 0) {
        const error = new Error(`Production environment validation failed:\n- ${result.errors.join('\n- ')}`);
        error.validation = result;
        throw error;
    }
    return result;
}

module.exports = {
    loadSecrets,
    collectEnvValidation,
    assertProductionEnv
};
