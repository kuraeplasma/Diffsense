const { randomUUID } = require('crypto');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ErrorCode,
    McpError
} = require('@modelcontextprotocol/sdk/types.js');
const {
    mcpAuthRouter,
    getOAuthProtectedResourceMetadataUrl
} = require('@modelcontextprotocol/sdk/server/auth/router.js');
const express = require('express');
const logger = require('../utils/logger');
const { validateApiKey } = require('./auth');
const { createDiffsenseOAuthProvider } = require('./oauthProvider');
const handlers = require('./handlers');

const DEFAULT_PRODUCTION_BACKEND_URL = 'https://api-qf37m5ba2q-an.a.run.app';
const DEFAULT_PUBLIC_MCP_ORIGIN = 'https://diffsense.spacegleam.co.jp';

function getPublicConnectorIconUrl(baseUrl) {
    const requestBase = String(baseUrl || '').trim().replace(/\/$/, '');
    const canUseFrontendAsset = publicMcpOrigin.origin !== backendBaseUrl.origin;
    if (canUseFrontendAsset) {
        return new URL('/backend/public/apple-touch-icon.png?v=20260329_claudeicon2', publicMcpOrigin).toString();
    }
    return `${requestBase}${publicMcpPath}/icon.png`;
}

function normalizePathname(value, fallbackPath) {
    const raw = String(value || '').trim();
    const normalized = raw
        ? (raw.startsWith('/') ? raw : `/${raw}`)
        : fallbackPath;
    return normalized.replace(/\/+$/, '') || '/';
}

function getConfiguredBackendBaseUrl() {
    const explicit = String(
        process.env.BACKEND_BASE_URL
        || process.env.API_BASE_URL
        || process.env.APP_BACKEND_URL
        || ''
    ).trim();

    if (explicit) {
        return explicit.replace(/\/$/, '');
    }

    const isProduction = String(process.env.NODE_ENV || '').trim() === 'production';
    return isProduction ? DEFAULT_PRODUCTION_BACKEND_URL : 'http://localhost:3001';
}

function getConfiguredPublicMcpOrigin() {
    const explicit = String(
        process.env.MCP_PUBLIC_BASE_URL
        || process.env.FRONTEND_URL
        || ''
    ).trim();

    if (explicit) {
        return explicit.replace(/\/$/, '');
    }

    const isProduction = String(process.env.NODE_ENV || '').trim() === 'production';
    return isProduction ? DEFAULT_PUBLIC_MCP_ORIGIN : getConfiguredBackendBaseUrl();
}

const backendBaseUrl = new URL(getConfiguredBackendBaseUrl());
const publicMcpOrigin = new URL(getConfiguredPublicMcpOrigin());
const publicMcpPath = normalizePathname(
    process.env.MCP_PUBLIC_PATH,
    publicMcpOrigin.origin === backendBaseUrl.origin ? '/api/mcp' : '/mcp'
);
const resourceServerUrl = new URL(publicMcpPath, publicMcpOrigin);
const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
const oauthProvider = createDiffsenseOAuthProvider(resourceServerUrl);
const allowLegacyQueryAuth = String(process.env.MCP_ALLOW_LEGACY_QUERY_AUTH || '').trim().toLowerCase() === 'true'
    || String(process.env.NODE_ENV || '').trim() !== 'production';

class RemoteSafeSSEServerTransport extends SSEServerTransport {
    async start() {
        if (this._sseResponse) {
            throw new Error('SSEServerTransport already started! If using Server class, note that connect() calls start() automatically.');
        }

        this.res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive'
        });

        const endpointUrl = new URL(this._endpoint);
        endpointUrl.searchParams.set('sessionId', this.sessionId);
        this.res.write(`event: endpoint\ndata: ${endpointUrl.toString()}\n\n`);

        this._sseResponse = this.res;
        this.res.on('close', () => {
            this._sseResponse = undefined;
            this.onclose?.();
        });
    }
}

function createServerForUser(user, baseUrl) {
    const mcpBaseUrl = `${baseUrl}${publicMcpPath}`;
    const iconUrl = getPublicConnectorIconUrl(baseUrl);
    const server = new Server(
        {
            name: 'DIFFsense',
            title: 'DIFFsense',
            version: '1.0.0',
            description: 'DIFFsense contract analysis tools for Claude.',
            websiteUrl: String(process.env.FRONTEND_URL || 'https://diffsense.spacegleam.co.jp'),
            icons: [
                {
                    src: iconUrl,
                    mimeType: 'image/png',
                    sizes: ['180x180']
                }
            ]
        },
        {
            capabilities: {
                tools: {},
                resources: {}
            },
        }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                {
                    name: 'list_contracts',
                    description: 'ユーザーが保存している契約書の一覧を取得します',
                    inputSchema: { type: 'object', properties: {} }
                },
                {
                    name: 'analyze_contract',
                    description: '契約書をAIで解析し、リスクや要約を出力します（解析回数を消費します）。リスク表示は High / Medium / Low です',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            contractId: { type: 'string', description: '契約書ID' }
                        },
                        required: ['contractId']
                    }
                },
                {
                    name: 'compare_contracts',
                    description: '2つの契約書の差分データだけを使って、変更点概要・リスク評価・法規制確認ポイント・推奨アクションを返します（Businessプラン以上）。リスク表示は High / Medium / Low です',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            contractIdA: { type: 'string', description: '比較元（旧）契約書ID' },
                            contractIdB: { type: 'string', description: '比較先（新）契約書ID' }
                        },
                        required: ['contractIdA', 'contractIdB']
                    }
                }
            ]
        };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args = {} } = request.params;

        try {
            switch (name) {
                case 'list_contracts': {
                    const result = await handlers.listContracts(user);
                    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
                }
                case 'analyze_contract': {
                    const result = await handlers.analyzeContract(user, args.contractId);
                    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
                }
                case 'compare_contracts': {
                    const result = await handlers.compareContracts(user, args.contractIdA, args.contractIdB);
                    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
                }
                default:
                    throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
            }
        } catch (error) {
            return {
                isError: true,
                content: [{ type: 'text', text: error.message }]
            };
        }
    });

    return server;
}

function createJsonRpcErrorResponse(res, status, message, code = -32000) {
    return res.status(status).json({
        jsonrpc: '2.0',
        error: {
            code,
            message
        },
        id: null
    });
}

function getBaseUrl(req) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const protocol = forwardedProto || req.protocol;
    const host = forwardedHost || req.get('host');
    return `${protocol}://${host}`;
}

function isInitializeRequestBody(body) {
    const messages = Array.isArray(body) ? body : [body];
    return messages.some((message) => message && typeof message === 'object' && message.method === 'initialize');
}

function sendMcpLandingPage(req, res) {
    const baseUrl = getBaseUrl(req);
    const mcpBaseUrl = `${baseUrl}${publicMcpPath}`;
    const iconUrl = getPublicConnectorIconUrl(baseUrl);
    const faviconUrl = iconUrl;
    const appleTouchIconUrl = iconUrl;
    const connectUrl = mcpBaseUrl;

    return res.type('html').send(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DIFFsense MCP</title>
  <meta name="description" content="DIFFsense remote MCP server endpoint">
  <meta name="application-name" content="DIFFsense">
  <meta property="og:title" content="DIFFsense MCP">
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
  <h1 style="margin:0 0 12px;">DIFFsense MCP</h1>
  <p style="margin:0 0 8px;">Claude 用のリモートMCPサーバーです。</p>
  <p style="margin:0 0 8px;">接続URL: <code>${connectUrl}</code></p>
  <p style="margin:0 0 8px;">認証方式: <code>Authorization: Bearer &lt;OAuth Access Token&gt;</code></p>
  <p style="margin:0;">Health check: <a href="${baseUrl}/health">${baseUrl}/health</a></p>
</body>
</html>`);
}

function applyWwwAuthenticateHeader(res, message = 'Missing or invalid access token') {
    const safeMessage = String(message || 'Missing or invalid access token').replace(/"/g, '\'');
    res.set('WWW-Authenticate', `Bearer error="invalid_token", error_description="${safeMessage}", resource_metadata="${resourceMetadataUrl}"`);
}

async function authenticateInitialRequest(req) {
    const authHeader = String(req.headers.authorization || '').trim();
    if (authHeader) {
        const [scheme, token] = authHeader.split(' ');
        if (scheme.toLowerCase() !== 'bearer' || !token) {
            throw new Error('Invalid Authorization header format');
        }
        const authInfo = await oauthProvider.verifyAccessToken(token);
        return {
            uid: authInfo?.extra?.uid,
            email: authInfo?.extra?.email || '',
            authInfo
        };
    }

    if (allowLegacyQueryAuth) {
        const apiKey = String(req.query.apiKey || req.headers['x-api-key'] || '').trim();
        if (apiKey) {
            const user = await validateApiKey(apiKey);
            if (!user) {
                throw new Error('Invalid legacy MCP API key');
            }
            logger.warn(`[mcp] legacy API key auth used uid=${user.uid}`);
            return user;
        }
    }

    throw new Error('Missing Authorization header');
}

function createMcpAuthRouter() {
    return mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl: publicMcpOrigin,
        baseUrl: publicMcpOrigin,
        resourceServerUrl,
        scopesSupported: ['mcp:tools'],
        resourceName: 'DIFFsense MCP',
        serviceDocumentationUrl: new URL(String(process.env.FRONTEND_URL || 'https://diffsense.spacegleam.co.jp'))
    });
}

function createMcpRouter() {
    const router = express.Router();
    const sessions = new Map();

    const removeSession = (sessionId, expectedTransport = null) => {
        const current = sessions.get(sessionId);
        if (!current) return;
        if (expectedTransport && current.transport !== expectedTransport) return;
        sessions.delete(sessionId);
    };

    router.all('/', async (req, res) => {
        const sessionId = String(req.headers['mcp-session-id'] || '').trim();

        if (!sessionId && req.method === 'GET') {
            return sendMcpLandingPage(req, res);
        }

        if (sessionId) {
            const session = sessions.get(sessionId);
            if (!session) {
                logger.warn(`MCP request received for missing Streamable HTTP session: ${sessionId}`);
                applyWwwAuthenticateHeader(res, 'MCP session not found or expired');
                return createJsonRpcErrorResponse(res, 404, 'MCP session not found or expired');
            }
            if (!(session.transport instanceof StreamableHTTPServerTransport)) {
                return createJsonRpcErrorResponse(res, 400, 'Session exists but uses a different transport protocol');
            }

            try {
                await session.transport.handleRequest(req, res, req.body);
                return undefined;
            } catch (error) {
                logger.error(`Failed to handle Streamable HTTP request for session ${sessionId}: ${error.message}`);
                if (!res.headersSent) {
                    return createJsonRpcErrorResponse(res, 500, 'Failed to handle MCP request', -32603);
                }
                return undefined;
            }
        }

        if (req.method !== 'POST' || !isInitializeRequestBody(req.body)) {
            return createJsonRpcErrorResponse(
                res,
                400,
                'No valid MCP session was provided. Start with an initialize POST request to this endpoint.'
            );
        }

        let user;
        try {
            user = await authenticateInitialRequest(req);
        } catch (error) {
            applyWwwAuthenticateHeader(res, error.message);
            return createJsonRpcErrorResponse(res, 401, 'Unauthorized: Bearer token required');
        }

        const server = createServerForUser(user, getBaseUrl(req));
        let transport;

        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
                sessions.set(newSessionId, {
                    transport,
                    server,
                    user,
                    protocol: 'streamable'
                });
                logger.info(`MCP Streamable HTTP connected for user ${user.uid} (session ${newSessionId})`);
            }
        });

        transport.onclose = () => {
            if (transport.sessionId) {
                removeSession(transport.sessionId, transport);
                logger.info(`MCP Streamable HTTP connection closed for user ${user.uid} (session ${transport.sessionId})`);
            }
        };

        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            return undefined;
        } catch (error) {
            if (transport.sessionId) {
                removeSession(transport.sessionId, transport);
            }
            logger.error(`Failed to establish Streamable HTTP MCP connection: ${error.message}`);
            if (!res.headersSent) {
                return createJsonRpcErrorResponse(res, 500, 'Failed to establish MCP connection', -32603);
            }
            return undefined;
        }
    });

    router.get('/sse', async (req, res) => {
        let user;
        try {
            user = await authenticateInitialRequest(req);
        } catch (error) {
            applyWwwAuthenticateHeader(res, error.message);
            return res.status(401).send('Unauthorized: Bearer token required');
        }

        logger.info(`New MCP SSE connection for user ${user.uid} (${user.email || 'unknown'})`);

        const messagesUrl = new URL(`${publicMcpPath}/messages`, getBaseUrl(req)).toString();
        const transport = new RemoteSafeSSEServerTransport(messagesUrl, res);
        const server = createServerForUser(user, getBaseUrl(req));

        sessions.set(transport.sessionId, {
            transport,
            server,
            user,
            protocol: 'sse'
        });

        transport.onclose = () => {
            removeSession(transport.sessionId, transport);
            logger.info(`MCP SSE connection closed for user ${user.uid} (session ${transport.sessionId})`);
        };

        try {
            await server.connect(transport);
            logger.info(`MCP SSE connected for user ${user.uid} (session ${transport.sessionId})`);
        } catch (error) {
            removeSession(transport.sessionId, transport);
            logger.error(`Failed to establish MCP SSE connection: ${error.message}`);
            if (!res.headersSent) {
                return res.status(500).send('Failed to establish MCP connection');
            }
            throw error;
        }

        req.on('close', () => {
            removeSession(transport.sessionId, transport);
        });

        return undefined;
    });

    router.post('/messages', async (req, res) => {
        const sessionId = String(req.query.sessionId || req.headers['mcp-session-id'] || '').trim();
        if (!sessionId) {
            return res.status(400).json({ success: false, error: 'sessionId is required' });
        }

        const session = sessions.get(sessionId);
        if (!session) {
            logger.warn(`MCP message received for missing session: ${sessionId}`);
            return res.status(404).json({ success: false, error: 'MCP session not found or expired' });
        }
        if (!(session.transport instanceof SSEServerTransport)) {
            return res.status(400).json({ success: false, error: 'Session exists but does not use legacy SSE transport' });
        }

        try {
            await session.transport.handlePostMessage(req, res, req.body);
            return undefined;
        } catch (error) {
            logger.error(`Failed to handle MCP POST message for session ${sessionId}: ${error.message}`);
            if (!res.headersSent) {
                return res.status(500).json({ success: false, error: 'Failed to handle MCP message' });
            }
            return undefined;
        }
    });

    return router;
}

module.exports = {
    createMcpAuthRouter,
    createMcpRouter,
    oauthProvider,
    resourceMetadataUrl
};
