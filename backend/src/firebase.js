const admin = require('firebase-admin');
const logger = require('./utils/logger');

let firebaseInitialized = false;
const isCloudFunction = !!process.env.FUNCTION_TARGET || !!process.env.K_SERVICE;

// Initialize Firebase Admin
if (!admin.apps.length) {
    if (isCloudFunction) {
        // Cloud Functions: ADC auto-initializes
        try {
            admin.initializeApp({
                storageBucket: 'diffsense-9a718.firebasestorage.app'
            });
            firebaseInitialized = true;
            logger.info('Firebase Admin initialized via ADC (Cloud Functions)');
        } catch (error) {
            logger.error('Failed to initialize Firebase Admin:', error.message);
        }
    } else {
        // Local development: use env vars or fallback
        const projectId = process.env.FB_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || 'diffsense-9a718';
        const bucketName = process.env.FB_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET || `${projectId}.firebasestorage.app`;
        const clientEmail = process.env.FB_CLIENT_EMAIL || process.env.FIREBASE_CLIENT_EMAIL;
        const privateKey = process.env.FB_PRIVATE_KEY || process.env.FIREBASE_PRIVATE_KEY;

        if (projectId && clientEmail && privateKey) {
            try {
                admin.initializeApp({
                    credential: admin.credential.cert({
                        projectId,
                        clientEmail,
                        privateKey: privateKey.replace(/\\n/g, '\n'),
                    }),
                    storageBucket: bucketName
                });
                firebaseInitialized = true;
                logger.info('Firebase Admin initialized with service account');
            } catch (error) {
                logger.error('Failed to initialize Firebase Admin:', error.message);
                logger.warn('Server will start without Firebase. Auth bypass required for API access.');
            }
        } else {
            logger.warn('Firebase credentials not configured. Set FB_PROJECT_ID, FB_CLIENT_EMAIL, and FB_PRIVATE_KEY in .env');
            logger.warn('Server will start without Firebase. Set AUTH_BYPASS=true in .env for local development.');
        }
    }
} else {
    firebaseInitialized = true;
}

// Create safe proxies that don't crash if Firebase isn't initialized
let db = null;
let bucket = null;

if (firebaseInitialized) {
    try {
        db = admin.firestore();
        const storage = admin.storage();
        bucket = storage.bucket();
    } catch (error) {
        logger.error('Failed to access Firebase services:', error.message);
    }
}

module.exports = { admin, db, bucket, firebaseInitialized };
