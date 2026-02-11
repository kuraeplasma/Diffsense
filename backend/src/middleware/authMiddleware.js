const { admin, firebaseInitialized } = require('../firebase');
const logger = require('../utils/logger');

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
            if (!authHeader || !authHeader.startsWith('Bearer ') || !firebaseInitialized) {
                logger.warn('DEV AUTH BYPASS: Assigning temporary user.');
                req.user = { uid: 'dev-user-001', email: 'dev@localhost' };
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
