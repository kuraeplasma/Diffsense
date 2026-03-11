const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: true });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const fs = require('fs');
const contractRoutes = require('./routes/contracts');
const dbRoutes = require('./routes/db');
const inviteRoutes = require('./routes/invite'); // Added
const userRoutes = require('./routes/user'); // Added
const paymentRoutes = require('./routes/payment'); // Added
const stripeWebhookRoutes = require('./routes/stripeWebhook');
const authMiddleware = require('./middleware/authMiddleware');
const errorHandler = require('./middleware/errorHandler');
const logger = require('./utils/logger');
const crawlRoutes = require('./routes/crawl');
const webhookRoutes = require('./routes/webhook');
const cronService = require('./services/cronService');

const DEFAULT_STRIPE_PRICE_IDS = {
    monthly: {
        starter: 'price_1T9iXH2NMkk9rteNzfHmJ6IH',
        business: 'price_1T9iXI2NMkk9rteNKImWXoud',
        pro: 'price_1T9iXI2NMkk9rteN3MXhXIZE'
    },
    annual: {
        starter: 'price_1T9iXI2NMkk9rteNNDv4X0lP',
        business: 'price_1T9iXJ2NMkk9rteNReZKwrBq',
        pro: 'price_1T9iXJ2NMkk9rteNMtxh3vIU'
    }
};


// Initialize Firebase Admin (Using shared module)
const { admin, db, bucket } = require('./firebase');

const app = express();

// Create logs directory if it doesn't exist (skip in Cloud Functions)
const isCloudFunction = !!process.env.FUNCTION_TARGET || !!process.env.K_SERVICE;
if (!isCloudFunction) {
    const logsDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }
}

// Security headers with custom CSP to allow framing from frontend
// Enable trust proxy for correct protocol detection behind Load Balancers (Cloud Run)
app.set('trust proxy', 1);

// Security headers with custom CSP to allow framing from frontend
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "frame-ancestors": ["'self'", "http://localhost:3000", "http://localhost:8000", "https://diffsense.netlify.app", "https://diffsense.spacegleam.co.jp"],
        },
    },
    crossOriginResourcePolicy: { policy: "cross-origin" },
    xFrameOptions: false // Disable X-Frame-Options in favor of CSP frame-ancestors
}));

// CORS configuration
const envOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3000', 'http://localhost:8000'];
// 本番ドメインを常に許可（環境変数の設定漏れ対策）
const requiredOrigins = ['https://diffsense.spacegleam.co.jp', 'https://diffsense.netlify.app'];
const allowedOrigins = [...new Set([...envOrigins, ...requiredOrigins])];

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

// Stripe webhook must receive the raw body for signature verification.
app.use('/api/stripe', express.raw({ type: 'application/json' }), stripeWebhookRoutes);
app.use('/stripe', express.raw({ type: 'application/json' }), stripeWebhookRoutes);

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

// Webhook routes (NO auth - called directly by PayPal)
app.use('/webhook', webhookRoutes);

// Public payment config (no auth - needed for PayPal JS SDK on frontend)
app.get('/payment/config', (req, res) => {
    const mode = process.env.PAYPAL_MODE || 'sandbox';
    const stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
    res.json({
        success: true,
        data: {
            clientId: process.env.PAYPAL_CLIENT_ID,
            mode: mode,
            planIds: {
                monthly: {
                    starter: process.env.PAYPAL_PLAN_STARTER,
                    business: process.env.PAYPAL_PLAN_BUSINESS,
                    pro: process.env.PAYPAL_PLAN_PRO
                },
                annual: {
                    starter: process.env.PAYPAL_PLAN_STARTER_ANNUAL,
                    business: process.env.PAYPAL_PLAN_BUSINESS_ANNUAL,
                    pro: process.env.PAYPAL_PLAN_PRO_ANNUAL
                }
            },
            stripe: {
                publishableKey: stripePublishableKey,
                enabled: Boolean(stripePublishableKey && process.env.STRIPE_SECRET_KEY),
                priceIds: {
                    monthly: {
                        starter: process.env.STRIPE_PRICE_STARTER || DEFAULT_STRIPE_PRICE_IDS.monthly.starter,
                        business: process.env.STRIPE_PRICE_BUSINESS || DEFAULT_STRIPE_PRICE_IDS.monthly.business,
                        pro: process.env.STRIPE_PRICE_PRO || DEFAULT_STRIPE_PRICE_IDS.monthly.pro
                    },
                    annual: {
                        starter: process.env.STRIPE_PRICE_STARTER_ANNUAL || DEFAULT_STRIPE_PRICE_IDS.annual.starter,
                        business: process.env.STRIPE_PRICE_BUSINESS_ANNUAL || DEFAULT_STRIPE_PRICE_IDS.annual.business,
                        pro: process.env.STRIPE_PRICE_PRO_ANNUAL || DEFAULT_STRIPE_PRICE_IDS.annual.pro
                    }
                }
            },
            defaultBillingCycle: 'monthly'
        }
    });
});

// API routes (Protected by Auth Middleware)
app.use('/contracts', authMiddleware, contractRoutes);
app.use('/db', authMiddleware, dbRoutes);
app.use('/invite', authMiddleware, inviteRoutes);
app.use('/user', authMiddleware, userRoutes);
app.use('/payment', authMiddleware, paymentRoutes);
app.use('/api', authMiddleware, paymentRoutes);
app.use('/crawl', authMiddleware, crawlRoutes);


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

// Graceful shutdown
if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        logger.info(`DIFFsense Backend API started on port ${PORT}`);
        logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
        logger.info(`Allowed origins: ${allowedOrigins.join(', ')}`);

        // Initialize Periodic Tasks
        cronService.init();
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

// Export for Cloud Functions
module.exports = { app };
