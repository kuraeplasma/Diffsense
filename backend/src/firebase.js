const admin = require('firebase-admin');
const logger = require('./utils/logger');

let firebaseInitialized = false;

// Initialize Firebase Admin
if (!admin.apps.length) {
    const projectId = process.env.FIREBASE_PROJECT_ID || 'diffsense-9a718';
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET || `${projectId}.firebasestorage.app`;

    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
        try {
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: process.env.FIREBASE_PROJECT_ID,
                    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
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
        logger.warn('Firebase credentials not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY in .env');
        logger.warn('Server will start without Firebase. Set AUTH_BYPASS=true in .env for local development.');
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
