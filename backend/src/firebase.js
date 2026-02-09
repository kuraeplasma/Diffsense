const admin = require('firebase-admin');
const logger = require('./utils/logger');

// Initialize Firebase Admin
if (!admin.apps.length) {
    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
        try {
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: process.env.FIREBASE_PROJECT_ID,
                    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
                }),
                storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${process.env.FIREBASE_PROJECT_ID}.appspot.com`
            });
            logger.info('Firebase Admin initialized successfully');
        } catch (error) {
            logger.error('Failed to initialize Firebase Admin:', error);
        }
    } else {
        // Fallback for Cloud Functions environment (where default credentials might be used)
        try {
            admin.initializeApp();
            logger.info('Firebase Admin initialized with default credentials');
        } catch (error) {
            logger.warn('Firebase Admin credentials not fully set.');
        }
    }
}

const db = admin.firestore();
const storage = admin.storage();
const bucket = storage.bucket(); // Default bucket

module.exports = { admin, db, bucket };
