const { admin, firebaseInitialized } = require('../firebase');
const logger = require('../utils/logger');
const dbService = require('../services/db');

const authMiddleware = async (req, res, next) => {
    try {

        const authHeader = req.headers.authorization;
        
        // --- Local Development Bypass ---
        const h = req.headers.host || '';
        const isLocalHost = h.includes('localhost') || h.includes('127.0.0.1') || h.includes('192.168.') || h.includes('10.') || h.includes('172.');
        if (process.env.NODE_ENV === 'development' && process.env.AUTH_BYPASS === 'true' && isLocalHost) {
            req.user = {
                uid: 'QIExRrJJFxT17j3oMwD93O6Bw933',
                email: 'kuraeplasma@gmail.com',
                name: 'Owner User',
                is_mock: true
            };
            return next();
        }

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
