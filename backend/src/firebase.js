const admin = require('firebase-admin');
const logger = require('./utils/logger');

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
            logger.info('Firebase Admin initialized with service account');
        } catch (error) {
            logger.error('Failed to initialize Firebase Admin:', error);
        }
    } else {
        // Fallback for Cloud Functions environment
        try {
            admin.initializeApp({
                projectId: projectId,
                storageBucket: bucketName
            });
            logger.info(`Firebase Admin initialized with default credentials for ${projectId}`);
        } catch (error) {
            logger.warn('Firebase Admin basic initialization failed, trying default.');
            try {
                admin.initializeApp();
            } catch (e) {
                logger.error('Total Firebase initialization failure');
            }
        }
    }
}

const db = admin.firestore();
const storage = admin.storage();
const bucket = storage.bucket(); // Default bucket

module.exports = { admin, db, bucket };
