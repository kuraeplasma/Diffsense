const logger = require('../utils/logger');
const db = require('../services/db');
const gemini = require('../services/gemini');
const diffService = require('../services/diffService');
const docxService = require('../services/docxService');
const { toLegacyArticleArray } = require('../services/contractStructure');

function contractContentToText(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content.trim();

    if (Array.isArray(content)) {
        return content.map((section) => {
            if (!section || typeof section !== 'object') return String(section || '').trim();
            const article = String(section.article || section.articleNumber || '').trim();
            const title = String(section.title || '').trim();
            const body = Array.isArray(section.paragraphs)
                ? section.paragraphs.map((paragraph) => {
                    if (typeof paragraph === 'string') return paragraph.trim();
                    if (paragraph && typeof paragraph === 'object') {
                        return String(paragraph.content || paragraph.body || paragraph.full_text || '').trim();
                    }
                    return '';
                }).filter(Boolean).join('\n')
                : String(section.body || section.full_text || '').trim();
            return `${article}${title ? ` ${title}` : ''}\n${body}`.trim();
        }).filter(Boolean).join('\n\n').trim();
    }

    if (typeof content === 'object' && Array.isArray(content.articles)) {
        const preamble = String(content.preamble || '').trim();
        const articlesText = contractContentToText(content.articles);
        return [preamble, articlesText].filter(Boolean).join('\n\n').trim();
    }

    if (typeof content === 'object') {
        const inlineText = String(content.text || content.body || content.full_text || '').trim();
        if (inlineText) return inlineText;
        try {
            return JSON.stringify(content);
        } catch {
            return '';
        }
    }

    return String(content).trim();
}

function resolveContractText(contract) {
    const candidates = [
        contract?.structured_contract,
        contract?.original_content,
        contract?.extracted_text,
        contract?.text,
        contract?.pdf_raw_text
    ];

    for (const candidate of candidates) {
        const text = contractContentToText(candidate);
        if (text) return text;
    }

    return '';
}

function normalizeContentToLegacyArticles(content) {
    if (content === null || content === undefined) return [];
    if (Array.isArray(content)) {
        const first = content.find(Boolean);
        if (first && typeof first === 'object' && ('full_text' in first || 'article_number' in first || 'article' in first)) {
            return content;
        }
        if (first && typeof first === 'object' && ('articleNumber' in first || 'content' in first)) {
            return toLegacyArticleArray({ articles: content });
        }
        const asText = contractContentToText(content);
        return asText ? docxService.parseTextToArticles(asText) : [];
    }
    if (typeof content === 'object' && Array.isArray(content.articles)) {
        return toLegacyArticleArray(content);
    }
    if (typeof content === 'string') {
        const trimmed = content.trim();
        return trimmed ? docxService.parseTextToArticles(trimmed) : [];
    }
    return [];
}

function resolveContractArticles(contract) {
    const candidates = [
        contract?.structured_contract,
        contract?.original_content,
        contract?.extracted_text,
        contract?.text,
        contract?.pdf_raw_text
    ];

    for (const candidate of candidates) {
        const articles = normalizeContentToLegacyArticles(candidate);
        if (Array.isArray(articles) && articles.length > 0) {
            return articles;
        }
    }

    return [];
}

function truncatePreviewText(text, maxLength = 220) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    return normalized.length > maxLength
        ? `${normalized.slice(0, maxLength)}...`
        : normalized;
}

function buildDiffPreviewLines(changes, limit = 6) {
    return (Array.isArray(changes) ? changes : [])
        .slice(0, limit)
        .map((change) => {
            const section = String(change?.section || '本文').trim() || '本文';
            const oldText = truncatePreviewText(change?.old || '');
            const newText = truncatePreviewText(change?.new || '');
            if (String(change?.type || '').toUpperCase() === 'ADD') {
                return `+ ${section}: ${newText || '追加内容あり'}`;
            }
            if (String(change?.type || '').toUpperCase() === 'DELETE') {
                return `- ${section}: ${oldText || '削除内容あり'}`;
            }
            return `- ${section}: ${oldText || '変更前あり'}\n+ ${section}: ${newText || '変更後あり'}`;
        });
}

function buildComparisonReport(result) {
    const actions = Array.isArray(result?.recommendedActions) && result.recommendedActions.length > 0
        ? result.recommendedActions.map((item) => `- ${item}`).join('\n')
        : '- 主要差分を確認してください。';
    return [
        `【変更点概要】 ${String(result?.changeSummary || '').trim()}`,
        `【リスク評価】 ${String(result?.riskEvaluation || '').trim()}`,
        `【最新法規制との整合性】 ${String(result?.latestRegulatoryAlignment || '').trim()}`,
        '【推奨アクション】',
        actions
    ].join('\n');
}

function riskLevelToUiLabel(value) {
    const level = Number(value || 0);
    if (level >= 3) return 'High';
    if (level === 2) return 'Medium';
    return 'Low';
}

function decorateAnalysisResult(result) {
    const riskLevel = [1, 2, 3].includes(Number(result?.riskLevel))
        ? Number(result.riskLevel)
        : 1;
    const riskLabel = riskLevelToUiLabel(riskLevel);

    return {
        ...result,
        riskLevel,
        riskLabel,
        riskDisplay: `${riskLabel} (${riskLevel}/3)`
    };
}

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
            text: '契約全文の直接取得はセキュリティ保護のため現在無効化されています。analyze_contract または compare_contracts を利用してください。'
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

        const contractText = resolveContractText(contract);
        if (!contractText) {
            throw new Error('解析対象のテキストがありません');
        }

        // Increment usage first (conservative)
        await db.incrementUsage(user.uid);

        const result = decorateAnalysisResult(await gemini.analyzeContract(contractText));
        
        return {
            id: contract.id,
            name: contract.name,
            risk_level: result.riskLabel,
            risk_display: result.riskDisplay,
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

        const textA = resolveContractText(contractA);
        const textB = resolveContractText(contractB);
        if (!textA || !textB) {
            throw new Error('比較対象の契約書本文が見つかりません');
        }

        const articlesA = resolveContractArticles(contractA);
        const articlesB = resolveContractArticles(contractB);
        let diffChanges = diffService.compare(articlesA, articlesB);
        if (diffChanges.length === 0 && textA.trim() !== textB.trim()) {
            diffChanges = [{
                type: 'MODIFY',
                section: '本文',
                old: textA,
                new: textB
            }];
        }

        const result = decorateAnalysisResult(await gemini.analyzeMcpDiff(diffChanges, {
            contractAName: contractA.name,
            contractBName: contractB.name
        }));
        const report = buildComparisonReport(result);
        const diffPreview = buildDiffPreviewLines(diffChanges);

        return {
            contractA: contractA.name,
            contractB: contractB.name,
            risk_level: result.riskLabel,
            risk_display: result.riskDisplay,
            change_summary: result.changeSummary,
            risk_evaluation: result.riskEvaluation,
            latest_regulatory_alignment: result.latestRegulatoryAlignment,
            recommended_actions: result.recommendedActions,
            material_changes: result.materialChanges,
            regulatory_search: result.regulatorySearch,
            diff_preview: diffPreview,
            report,
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
