'use strict';

function isTruthy(value) {
    return String(value || '').trim().toLowerCase() === 'true';
}

function collectEnvValidation() {
    const isProduction = String(process.env.NODE_ENV || '').trim() === 'production';
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
        'FIREBASE_CLIENT_EMAIL',
        'FIREBASE_PRIVATE_KEY',
        'FIREBASE_STORAGE_BUCKET'
    ];

    for (const key of requiredEnvKeys) {
        if (!String(process.env[key] || '').trim()) {
            errors.push(`${key} is required in production`);
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
    if (allowedOrigins && !allowedOrigins.split(',').every((origin) => /^https:\/\//i.test(String(origin || '').trim()))) {
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
    collectEnvValidation,
    assertProductionEnv
};
