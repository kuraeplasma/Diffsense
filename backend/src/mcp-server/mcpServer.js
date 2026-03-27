const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { 
    ListToolsRequestSchema, 
    CallToolRequestSchema,
    ErrorCode,
    McpError
} = require('@modelcontextprotocol/sdk/types.js');
const express = require('express');
const logger = require('../utils/logger');
const { validateApiKey } = require('./auth');
const handlers = require('./handlers');

/**
 * Creates and configures the MCP server
 * Returns an Express router that handles MCP SSE connections
 */
function createMcpRouter() {
    const router = express.Router();
    
    // Store active servers/transports by session if needed, 
    // but for simple SSE we can create on the fly or keep a map.
    const transports = new Map();

    const server = new Server(
        {
            name: 'diffsense-mcp-server',
            version: '1.0.0',
        },
        {
            capabilities: {
                tools: {},
                resources: {}
            },
        }
    );

    // --- Tool Definitions ---

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                {
                    name: 'list_contracts',
                    description: 'ユーザーが保存している契約書の一覧を取得します',
                    inputSchema: { type: 'object', properties: {} }
                },
                {
                    name: 'get_contract_text',
                    description: '指定した契約書の全文テキストを取得します',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            contractId: { type: 'string', description: '契約書ID' }
                        },
                        required: ['contractId']
                    }
                },
                {
                    name: 'analyze_contract',
                    description: '契約書をAIで解析し、リスクや要約を出力します（解析回数を消費します）',
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
                    description: '2つの契約書を比較し、差分とリスクを解析します（Businessプラン以上）',
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
        // Auth is handled in the transport layer (SSE connection)
        // because we need the user profile for each request.
        // However, the SDK's server instance doesn't easily expose the request context 
        // to handlers unless we wrap them.
        
        const { name, arguments: args } = request.params;
        const user = request.metadata?.user; // We'll inject this in the transport wrap

        if (!user) {
            throw new McpError(ErrorCode.InvalidRequest, '認証が必要です');
        }

        try {
            switch (name) {
                case 'list_contracts': {
                    const result = await handlers.listContracts(user);
                    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
                }
                case 'get_contract_text': {
                    const result = await handlers.getContractText(user, args.contractId);
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

    // --- Express Routes for SSE ---

    router.get('/sse', async (req, res) => {
        const apiKey = req.query.apiKey || req.headers['x-api-key'];
        const user = await validateApiKey(apiKey);

        if (!user) {
            return res.status(401).send('Unauthorized: Invalid MCP API Key');
        }

        logger.info(`New MCP SSE connection for user ${user.uid} (${user.email})`);

        const transport = new SSEServerTransport('/api/mcp/messages', res);
        
        // Wrap the server to inject user metadata into handlers
        // This is a bit of a hack because SDK handles the metadata poorly 
        // in some versions, but we can use a proxy or just rely on closure 
        // if we change the handler set logic.
        
        // For simplicity, we'll use a per-transport handler approach if needed, 
        // but let's try the standard way with metadata check.
        
        // We need to pass the user to the server so tools can use it.
        // A common pattern is to wrap the call.
        
        const originalHandler = server.executeHandler.bind(server);
        server.executeHandler = (request) => {
            request.metadata = { user }; // Inject user
            return originalHandler(request);
        };

        await server.connect(transport);

        req.on('close', () => {
            logger.info(`MCP SSE connection closed for user ${user.uid}`);
            // Note: Server.connect handles transport closing usually
        });
    });

    router.post('/messages', async (req, res) => {
        // Find the transport for this session and pass the message
        // SSEServerTransport handles the message routing via session IDs usually.
        // We just need to call the transport handler.
        await SSEServerTransport.handlePostMessage(req, res);
    });

    return router;
}

module.exports = { createMcpRouter };
