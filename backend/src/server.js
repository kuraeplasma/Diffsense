const path = require('path');
// Load .env as a local development fallback without overriding production env vars.
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const fs = require('fs');
const logger = require('./utils/logger');
const { loadSecrets, assertProductionEnv } = require('./config/env');
const { sanitizeUrlForLogs } = require('./mcp-server/keys');

const app = express();
const sharedPrimaryConnectorIconPath = path.resolve(__dirname, '..', '..', 'favicon2.png');
const sharedScaledFaviconPath = path.resolve(__dirname, '..', '..', 'images', 'scaled_favicon.png');
const connectorIconPngPath = fs.existsSync(sharedPrimaryConnectorIconPath)
    ? sharedPrimaryConnectorIconPath
    : (fs.existsSync(sharedScaledFaviconPath)
        ? sharedScaledFaviconPath
        : path.resolve(__dirname, '..', 'public', 'diffsense-icon.png'));
const connectorIconIcoPath = path.resolve(__dirname, '..', 'public', 'favicon.ico');
const connectorAppleTouchIconPath = path.resolve(__dirname, '..', 'public', 'apple-touch-icon.png');
const connectorIconPngBuffer = fs.existsSync(connectorIconPngPath)
    ? fs.readFileSync(connectorIconPngPath)
    : null;
const connectorIconIcoBuffer = fs.existsSync(connectorIconIcoPath)
    ? fs.readFileSync(connectorIconIcoPath)
    : null;
const connectorAppleTouchIconBuffer = fs.existsSync(connectorAppleTouchIconPath)
    ? fs.readFileSync(connectorAppleTouchIconPath)
    : null;
let isBootstrapped = false;
let bootstrapPromise = null;

function normalizeRequestPath(req) {
    const rawPath = String(req.path || req.originalUrl || req.url || '').trim();
    if (!rawPath) return '/';
    const questionIndex = rawPath.indexOf('?');
    return questionIndex >= 0 ? rawPath.slice(0, questionIndex) : rawPath;
}

function isOpenMcpCorsPath(req) {
    const pathName = normalizeRequestPath(req);
    return pathName === '/authorize'
        || pathName === '/token'
        || pathName === '/register'
        || pathName === '/revoke'
        || pathName === '/mcp'
        || pathName.startsWith('/mcp/')
        || pathName === '/api/mcp'
        || pathName.startsWith('/api/mcp/')
        || pathName === '/.well-known/oauth-authorization-server'
        || pathName === '/.well-known/oauth-protected-resource/mcp';
}

/**
 * Bootstrap the application: Load secrets, validate environment, and register routes.
 */
async function bootstrap() {
    if (isBootstrapped) return;
    if (bootstrapPromise) return bootstrapPromise;

    bootstrapPromise = (async () => {
        logger.info('Bootstrapping application...');
        
        // 1. Load secrets from Secret Manager (in production)
        await loadSecrets();
        
        // 2. Validate environment
        const envValidation = assertProductionEnv();
        envValidation.warnings.forEach((message) => logger.warn(`[env] ${message}`));

        // 3. Initialize Firebase Admin (Only after secrets are loaded)
        const { admin, db, bucket } = require('./firebase');
        
        // 4. Require routes and services
        const contractRoutes = require('./routes/contracts');
        const inviteRoutes = require('./routes/invite');
        const userRoutes = require('./routes/user');
        const paymentRoutes = require('./routes/payment');
        const stripeWebhookRoutes = require('./routes/stripeWebhook');
        const authMiddleware = require('./middleware/authMiddleware');
        const errorHandler = require('./middleware/errorHandler');
        const crawlRoutes = require('./routes/crawl');
        const webhookRoutes = require('./routes/webhook');
        const signRoutes = require('./routes/sign');
        const notificationRoutes = require('./routes/notifications');
        const cronRoutes = require('./routes/cron');
        const slackRoutes = require('./routes/slack');
        const docxAnalysisRoutes = require('./routes/docxAnalysis');
        const { createMcpAuthRouter, createMcpRouter } = require('./mcp-server/mcpServer');
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

        // --- Middleware & Config ---
        
        // Enable trust proxy for Cloud Run/Functions
        app.set('trust proxy', 1);

        const configuredFrontendOrigin = String(process.env.FRONTEND_URL || '').trim();
        const frameAncestors = ["'self'", "http://localhost:3000", "http://localhost:8000", "https://diffsense.netlify.app", "https://diffsense.spacegleam.co.jp"];
        if (configuredFrontendOrigin) {
            frameAncestors.push(configuredFrontendOrigin);
        }

        app.use(helmet({
            contentSecurityPolicy: {
                directives: {
                    ...helmet.contentSecurityPolicy.getDefaultDirectives(),
                    "frame-ancestors": [...new Set(frameAncestors)],
                },
            },
            crossOriginResourcePolicy: { policy: "cross-origin" },
            xFrameOptions: false
        }));

        const envOrigins = process.env.ALLOWED_ORIGINS
            ? process.env.ALLOWED_ORIGINS.split(',')
            : ['http://localhost:3000', 'http://localhost:8000'];
        const requiredOrigins = [
            'https://diffsense.spacegleam.co.jp', 
            'https://diffsense.netlify.app',
            'https://claude.ai',
            'https://www.claude.ai'
        ];
        const allowedOrigins = [...new Set([...envOrigins, ...requiredOrigins, configuredFrontendOrigin].filter(Boolean))];

        app.use(cors((req, callback) => {
            const origin = String(req.headers.origin || '').trim();
            const openMcpCors = isOpenMcpCorsPath(req);

            if (!origin) {
                return callback(null, {
                    origin: true,
                    credentials: !openMcpCors
                });
            }

            if (openMcpCors) {
                return callback(null, {
                    origin: true,
                    credentials: false
                });
            }

            if (process.env.NODE_ENV === 'development' && origin.startsWith('http://localhost')) {
                return callback(null, {
                    origin: true,
                    credentials: true
                });
            }

            if (allowedOrigins.indexOf(origin) !== -1) {
                return callback(null, {
                    origin: true,
                    credentials: true
                });
            }

            logger.warn(`Blocked by CORS: ${origin}`);
            return callback(new Error('Not allowed by CORS'));
        }));

        app.use(morgan((tokens, req, res) => {
            const sanitizedUrl = sanitizeUrlForLogs(req.originalUrl || req.url || '/');
            return [
                tokens['remote-addr'](req, res),
                '-',
                tokens.method(req, res),
                sanitizedUrl,
                tokens.status(req, res),
                tokens.res(req, res, 'content-length') || '-',
                tokens['response-time'](req, res), 'ms'
            ].join(' ');
        }, { stream: logger.stream }));

        // --- Routes ---

        app.use('/api/stripe', express.raw({ type: 'application/json' }), stripeWebhookRoutes);
        app.use('/stripe', express.raw({ type: 'application/json' }), stripeWebhookRoutes);
        app.use('/webhook/stripe', express.raw({ type: 'application/json' }), stripeWebhookRoutes);

        app.use(express.json({ limit: '50mb' }));
        app.use(express.urlencoded({ extended: true, limit: '50mb' }));

        const sendConnectorIconPng = (res) => {
            res.set('Cache-Control', 'public, max-age=3600');
            if (connectorIconPngBuffer) {
                return res.type('png').send(connectorIconPngBuffer);
            }
            return res.status(404).send('Icon not found');
        };

        const sendConnectorIconIco = (res) => {
            res.set('Cache-Control', 'public, max-age=3600');
            if (connectorIconIcoBuffer) {
                return res.type('image/x-icon').send(connectorIconIcoBuffer);
            }
            if (connectorIconPngBuffer) {
                return res.type('png').send(connectorIconPngBuffer);
            }
            return res.status(404).send('Icon not found');
        };

        const sendConnectorAppleTouchIcon = (res) => {
            res.set('Cache-Control', 'public, max-age=3600');
            if (connectorAppleTouchIconBuffer) {
                return res.type('png').send(connectorAppleTouchIconBuffer);
            }
            if (connectorIconPngBuffer) {
                return res.type('png').send(connectorIconPngBuffer);
            }
            return res.status(404).send('Icon not found');
        };

        app.get('/', (req, res) => {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            const iconUrl = `${req.protocol}://${req.get('host')}/icon.png`;
            const faviconUrl = `${baseUrl}/favicon.ico`;
            const appleTouchIconUrl = `${baseUrl}/apple-touch-icon.png`;
            res.type('html').send(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DIFFsense MCP Server</title>
  <meta name="description" content="DIFFsense remote MCP server endpoint">
  <meta name="application-name" content="DIFFsense">
  <meta property="og:title" content="DIFFsense MCP Server">
  <meta property="og:description" content="DIFFsense remote MCP server endpoint">
  <meta property="og:image" content="${iconUrl}">
  <meta property="og:image:type" content="image/png">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:image" content="${iconUrl}">
  <link rel="icon" type="image/x-icon" href="${faviconUrl}">
  <link rel="icon" type="image/png" href="${iconUrl}">
  <link rel="shortcut icon" href="${faviconUrl}">
  <link rel="apple-touch-icon" href="${appleTouchIconUrl}">
</head>
<body style="font-family:system-ui,-apple-system,sans-serif; margin:40px; color:#111827;">
  <h1 style="margin:0 0 12px;">DIFFsense MCP Server</h1>
  <p style="margin:0 0 8px;">Claude などの MCP クライアント向け接続先です。</p>
  <p style="margin:0;">Health check: <a href="/health">/health</a></p>
</body>
</html>`);
        });

        const faviconIcoRoutes = [
            '/favicon.ico',
            '/api/favicon.ico',
            '/mcp/favicon.ico',
            '/api/mcp/favicon.ico'
        ];
        const iconPngRoutes = [
            '/favicon.png',
            '/favicon2.png',
            '/icon.png',
            '/api/favicon.png',
            '/api/favicon2.png',
            '/api/icon.png',
            '/mcp/favicon.png',
            '/mcp/favicon2.png',
            '/mcp/icon.png',
            '/api/mcp/favicon.png',
            '/api/mcp/favicon2.png',
            '/api/mcp/icon.png'
        ];
        const appleTouchIconRoutes = [
            '/apple-touch-icon.png',
            '/api/apple-touch-icon.png',
            '/mcp/apple-touch-icon.png',
            '/api/mcp/apple-touch-icon.png'
        ];

        app.get(faviconIcoRoutes, (req, res) => sendConnectorIconIco(res));
        app.head(faviconIcoRoutes, (req, res) => sendConnectorIconIco(res));
        app.get(iconPngRoutes, (req, res) => sendConnectorIconPng(res));
        app.head(iconPngRoutes, (req, res) => sendConnectorIconPng(res));
        app.get(appleTouchIconRoutes, (req, res) => sendConnectorAppleTouchIcon(res));
        app.head(appleTouchIconRoutes, (req, res) => sendConnectorAppleTouchIcon(res));

        app.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                timestamp: new Date().toISOString(),
                environment: process.env.NODE_ENV || 'development',
                bootstrapped: isBootstrapped
            });
        });

        app.use('/webhook', webhookRoutes);
        app.use('/api/cron', cronRoutes);

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
                    }
                }
            });
        });

        app.use('/api/sign', (req, res, next) => {
            if (['/verify', '/submit', '/decline', '/original-file', '/generate-pdf'].includes(req.path)) return signRoutes(req, res, next);
            return next();
        });
        app.use('/sign', (req, res, next) => {
            if (['/verify', '/submit', '/decline', '/original-file', '/generate-pdf'].includes(req.path)) return signRoutes(req, res, next);
            return next();
        });

        const mcpRouter = createMcpRouter();
        app.use(createMcpAuthRouter());
        app.use('/mcp', mcpRouter);
        app.use('/api/mcp', mcpRouter);
        app.use('/contracts', authMiddleware, contractRoutes);
        app.use('/api/contracts', authMiddleware, contractRoutes);
        app.use('/invite', authMiddleware, inviteRoutes);
        app.use('/user', (req, res, next) => {
            if (req.path === '/check-exists') return userRoutes(req, res, next);
            return authMiddleware(req, res, next);
        }, userRoutes);
        app.use('/payment', authMiddleware, paymentRoutes);
        app.use('/crawl', authMiddleware, crawlRoutes);
        app.use('/api/notifications', authMiddleware, notificationRoutes);
        app.use('/api/slack', (req, res, next) => {
            if (req.path === '/oauth/callback') return next();
            return authMiddleware(req, res, next);
        }, slackRoutes);
        app.use('/api/user/check-exists', userRoutes);
        app.use('/api/user', authMiddleware, userRoutes);
        // Keep DOCX analysis routes ahead of the generic /api mount.
        app.use('/docx', authMiddleware, docxAnalysisRoutes);
        app.use('/api/docx', authMiddleware, docxAnalysisRoutes);
        app.use('/api', authMiddleware, paymentRoutes);
        app.use('/api/sign', authMiddleware, signRoutes);

        app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

        app.use((req, res) => {
            res.status(404).json({ success: false, error: 'Endpoint not found' });
        });

        app.use(errorHandler);

        // Initialize Periodic Tasks
        cronService.init();

        isBootstrapped = true;
        logger.info('Application bootstrapped successfully.');
    })();

    return bootstrapPromise;
}

// Middleware to ensure bootstrap is complete before handling requests
app.use(async (req, res, next) => {
    try {
        await bootstrap();
        next();
    } catch (error) {
        logger.error('Bootstrap failed:', error.message);
        res.status(500).json({ success: false, error: 'Internal Server Error (Bootstrap Failed)' });
    }
});

// Logs directory setup (skip in Cloud Functions)
const isCloudFunction = !!process.env.FUNCTION_TARGET || !!process.env.K_SERVICE;
if (!isCloudFunction) {
    const logsDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }
}

// Graceful shutdown & Server start
if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    bootstrap().then(() => {
        app.listen(PORT, () => {
            logger.info(`DIFFsense Backend API started on port ${PORT}`);
            logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
        });
    }).catch(err => {
        logger.error('Failed to start server:', err);
        process.exit(1);
    });

    process.on('SIGTERM', () => {
        logger.info('SIGTERM received');
        process.exit(0);
    });
    process.on('SIGINT', () => {
        logger.info('SIGINT received');
        process.exit(0);
    });
}

module.exports = { app, bootstrap };
