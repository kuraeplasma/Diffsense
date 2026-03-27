const logger = require('../utils/logger');
const db = require('../services/db');
const gemini = require('../services/gemini');
const diffService = require('../services/diffService');

/**
 * List all contracts for a user
 */
async function listContracts(user) {
    try {
        const contracts = await db.getContracts(user.uid);
        return {
            contracts: contracts.map(c => ({
                id: c.id,
                name: c.name || '名称未設定',
                status: c.status || '不明',
                created_at: c.created_at || c.updated_at
            }))
        };
    } catch (error) {
        logger.error(`MCP listContracts error: ${error.message}`);
        throw new Error('契約書一覧の取得に失敗しました');
    }
}

/**
 * Get full text of a contract
 */
async function getContractText(user, contractId) {
    try {
        const contract = await db.getContractById(contractId, user.uid);
        if (!contract) {
            throw new Error('契約書が見つかりません');
        }
        return {
            id: contract.id,
            name: contract.name,
            text: contract.extracted_text || contract.text || 'テキストデータがありません'
        };
    } catch (error) {
        logger.error(`MCP getContractText error: ${error.message}`);
        throw new Error(error.message);
    }
}

/**
 * Analyze a contract using AI
 */
async function analyzeContract(user, contractId) {
    try {
        const userProfile = await db.getUserProfile(user.uid);
        const limit = db.getUsageLimit(userProfile);
        const currentUsage = userProfile.usageCount || 0;

        if (currentUsage >= limit) {
            throw new Error(`今月のAI解析回数上限（${limit}回）に達しています。ダッシュボードからプランをご確認ください。`);
        }

        const contract = await db.getContractById(contractId, user.uid);
        if (!contract) {
            throw new Error('契約書が見つかりません');
        }

        const contractText = contract.extracted_text || contract.text;
        if (!contractText) {
            throw new Error('解析対象のテキストがありません');
        }

        // Increment usage first (conservative)
        await db.incrementUsage(user.uid);

        const result = await gemini.analyzeContract(contractText);
        
        return {
            id: contract.id,
            name: contract.name,
            analysis: result
        };
    } catch (error) {
        logger.error(`MCP analyzeContract error: ${error.message}`);
        throw new Error(error.message);
    }
}

/**
 * Compare two contracts
 */
async function compareContracts(user, contractIdA, contractIdB) {
    try {
        const userProfile = await db.getUserProfile(user.uid);
        const limit = db.getUsageLimit(userProfile);
        const currentUsage = userProfile.usageCount || 0;

        if (currentUsage >= limit) {
            throw new Error(`今月のAI解析回数上限（${limit}回）に達しています。ダッシュボードからプランをご確認ください。`);
        }

        // Increment usage (comparison consumes 2 counts by default as it compares two documents)
        await db.incrementUsage(user.uid);
        // Note: We might want to increment twice for a more balanced pricing, 
        // but for now let's stick to 1 increment as per analyzeContract pattern 
        // unless specified otherwise. The user said "consume count(s)".

        const contractA = await db.getContractById(contractIdA, user.uid);
        const contractB = await db.getContractById(contractIdB, user.uid);

        if (!contractA || !contractB) {
            throw new Error('比較対象の契約書が見つかりません');
        }

        // Use structured data if available
        const textA = contractA.structured_contract || contractA.extracted_text || contractA.text;
        const textB = contractB.structured_contract || contractB.extracted_text || contractB.text;

        const result = await gemini.analyzeContract(textB, textA);

        return {
            contractA: contractA.name,
            contractB: contractB.name,
            comparison: result
        };
    } catch (error) {
        logger.error(`MCP compareContracts error: ${error.message}`);
        throw new Error(error.message);
    }
}

module.exports = {
    listContracts,
    getContractText,
    analyzeContract,
    compareContracts
};
