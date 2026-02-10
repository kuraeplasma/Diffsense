require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const contractRoutes = require('./routes/contracts');
const dbRoutes = require('./routes/db');
const authMiddleware = require('./middleware/authMiddleware');
const errorHandler = require('./middleware/errorHandler');
const logger = require('./utils/logger');

// Initialize Firebase Admin (Using shared module)
const { admin, db, bucket } = require('./firebase');

const app = express();

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Security headers with custom CSP to allow framing from frontend
// Enable trust proxy for correct protocol detection behind Load Balancers (Cloud Run)
app.set('trust proxy', 1);

// Security headers with custom CSP to allow framing from frontend
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "frame-ancestors": ["'self'", "http://localhost:3000", "http://localhost:8000", "https://diffsense.netlify.app"],
        },
    },
    crossOriginResourcePolicy: { policy: "cross-origin" },
    xFrameOptions: false // Disable X-Frame-Options in favor of CSP frame-ancestors
}));

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3000', 'http://localhost:8000'];

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);

        // Allow any localhost origin in development
        if (process.env.NODE_ENV === 'development' && origin.startsWith('http://localhost')) {
            return callback(null, true);
        }

        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            // For now, log the blocked origin but allow it if it's localhost (double check)
            // or just block it
            logger.warn(`Blocked by CORS: ${origin}`);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
}));

// Request logging
app.use(morgan('combined', { stream: logger.stream }));

// Body parser with size limits
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// API routes (Protected by Auth Middleware)
app.use('/contracts', authMiddleware, contractRoutes);
app.use('/db', authMiddleware, dbRoutes);

// Static files (PDF Uploads)
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
    });
});

// Error handling middleware (must be last)
app.use(errorHandler);

const functions = require('firebase-functions');

// Graceful shutdown
if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        logger.info(`DIFFsense Backend API started on port ${PORT}`);
        logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
        logger.info(`Allowed origins: ${allowedOrigins.join(', ')}`);
    });

    process.on('SIGTERM', () => {
        logger.info('SIGTERM signal received: closing HTTP server');
        process.exit(0);
    });

    process.on('SIGINT', () => {
        logger.info('SIGINT signal received: closing HTTP server');
        process.exit(0);
    });
}

// Export as Cloud Function
exports.api = functions.https.onRequest(app);
