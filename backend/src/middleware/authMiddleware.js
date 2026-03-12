const { admin, firebaseInitialized } = require('../firebase');
const logger = require('../utils/logger');
const dbService = require('../services/db');

function decodeJwtPayload(token) {
    try {
        if (!token || typeof token !== 'string') return null;
        const parts = token.split('.');
        if (parts.length < 2) return null;
        const payloadBase64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = payloadBase64.padEnd(Math.ceil(payloadBase64.length / 4) * 4, '=');
        const decoded = Buffer.from(padded, 'base64').toString('utf8');
        return JSON.parse(decoded);
    } catch (error) {
        logger.warn(`Failed to decode JWT payload in dev bypass: ${error.message}`);
        return null;
    }
}

/**
 * Firebase Auth Middleware
 * Verifies the ID token sent in the Authorization header.
 * Attaches the decoded token (including uid) to req.user.
 */
const authMiddleware = async (req, res, next) => {
    try {
        // Development bypass: skip auth when Firebase is not configured
        if (process.env.NODE_ENV === 'development' && process.env.AUTH_BYPASS === 'true') {
            const authHeader = req.headers.authorization;
            const bearerToken = (authHeader && authHeader.startsWith('Bearer '))
                ? authHeader.split('Bearer ')[1]
                : null;
            if (!firebaseInitialized) {
                const decoded = decodeJwtPayload(bearerToken);
                req.user = {
                    uid: decoded?.user_id || decoded?.sub || 'dev-user-001',
                    email: decoded?.email || 'dev@localhost'
                };
                logger.warn(`DEV AUTH BYPASS: Using ${decoded ? 'decoded token user' : 'temporary user'} (${req.user.uid}).`);
                try {
                    await dbService.upsertUserEmail(req.user.uid, req.user.email);
                } catch (e) {
                    logger.warn(`Failed to sync dev user email: ${e.message}`);
                }
                return next();
            }
        }

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            logger.warn('Auth blocked: Missing or invalid Authorization header');
            return res.status(401).json({
                success: false,
                error: 'Authentication required'
            });
        }

        if (!firebaseInitialized) {
            logger.error('Auth blocked: Firebase not initialized');
            return res.status(503).json({
                success: false,
                error: 'Authentication service unavailable'
            });
        }

        const token = authHeader.split('Bearer ')[1];
        try {
            const decodedToken = await admin.auth().verifyIdToken(token);
            req.user = decodedToken;
            if (decodedToken?.uid && decodedToken?.email) {
                try {
                    await dbService.upsertUserEmail(decodedToken.uid, decodedToken.email);
                } catch (e) {
                    logger.warn(`Failed to sync user email: ${e.message}`);
                }
            }
            next();
        } catch (error) {
            logger.warn('Auth blocked: Token verification failed', error.message);
            return res.status(401).json({
                success: false,
                error: 'Invalid or expired token'
            });
        }
    } catch (error) {
        logger.error('Auth system error:', error.message);
        next(error);
    }
};

module.exports = authMiddleware;
