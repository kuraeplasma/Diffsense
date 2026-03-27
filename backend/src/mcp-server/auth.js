const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const db = require('../services/db');

/**
 * Generate a new MCP API key for a user
 * @param {string} uid 
 * @returns {string} 
 */
async function generateApiKey(uid) {
    const key = `mcp_${uuidv4().replace(/-/g, '')}`;
    await db.setUserMcpApiKey(uid, key);
    logger.info(`Generated new MCP API key for user ${uid}`);
    return key;
}

/**
 * Validate an MCP API key and return the user profile
 * @param {string} apiKey 
 * @returns {Promise<Object|null>}
 */
async function validateApiKey(apiKey) {
    if (!apiKey || !apiKey.startsWith('mcp_')) {
        return null;
    }
    const user = await db.findUserByMcpApiKey(apiKey);
    if (!user) {
        logger.warn(`Invalid MCP API key attempt: ${apiKey}`);
        return null;
    }
    return user;
}

module.exports = {
    generateApiKey,
    validateApiKey
};
