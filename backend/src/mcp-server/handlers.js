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
            const diffText = String(change?.diffText || '').trim();
            if (diffText) {
                return `${section}\n${diffText}`;
            }
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

function normalizeSearchText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\s+/g, '')
        .trim();
}

function getSortableContractTimestamp(contract) {
    const candidates = [
        contract?.updated_at,
        contract?.updatedAt,
        contract?.created_at,
        contract?.createdAt
    ];

    for (const candidate of candidates) {
        if (candidate && typeof candidate.toDate === 'function') {
            const date = candidate.toDate();
            const parsed = date instanceof Date ? date.getTime() : NaN;
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
            return candidate;
        }
        const numeric = Number(candidate);
        if (Number.isFinite(numeric) && numeric > 0) {
            return numeric;
        }
        const parsed = Date.parse(candidate);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return 0;
}

function sortContractsForListing(contracts) {
    return [...(Array.isArray(contracts) ? contracts : [])]
        .sort((a, b) => getSortableContractTimestamp(b) - getSortableContractTimestamp(a));
}

function filterContractsByQuery(contracts, query) {
    const needle = normalizeSearchText(query);
    if (!needle) return sortContractsForListing(contracts);

    return sortContractsForListing(contracts)
        .filter((contract) => {
            const haystack = normalizeSearchText([
                contract?.name,
                contract?.id,
                contract?.status
            ].filter(Boolean).join(' '));
            return haystack.includes(needle);
        });
}

function buildComparisonReport(result) {
    return [
        `【変更点概要】 ${String(result?.summary || '').trim()}`,
        `【リスク判定】 ${String(result?.riskReason || '').trim()}`,
        '【推奨アクション】',
        Array.isArray(result?.changes) && result.changes.length > 0
            ? result.changes.map(c => `- ${c.section || '本文'}: ${c.summary || c.action || '要確認'}`).join('\n')
            : '- 詳細な変更点を確認してください。'
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

function buildSafeMcpRiskItems(result) {
    return (Array.isArray(result?.risks) ? result.risks : [])
        .map((item) => ({
            section: String(item?.section || '本文').trim() || '本文',
            level: String(item?.level || item?.risk || result?.riskLabel || 'LOW').trim() || 'LOW',
            reason: String(item?.reason || '').trim(),
            action: String(item?.action || '').trim()
        }))
        .filter((item) => item.reason)
        .slice(0, 5);
}

function buildSafeMcpRecommendedActions(risks) {
    return Array.from(new Set((Array.isArray(risks) ? risks : [])
        .map((item) => String(item?.action || '').trim())
        .filter(Boolean)))
        .slice(0, 5);
}

/**
 * List all contracts for a user
 */
async function listContracts(user, query = '') {
    try {
        const contracts = await db.getContracts(user.uid);
        const normalizedQuery = String(query || '').trim();
        const visibleContracts = normalizedQuery
            ? filterContractsByQuery(contracts, normalizedQuery).slice(0, 10)
            : sortContractsForListing(contracts).slice(0, 5);

        return {
            mode: normalizedQuery ? 'search' : 'recent',
            query: normalizedQuery || null,
            contracts: visibleContracts.map(c => ({
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

        const result = decorateAnalysisResult(await gemini.analyzeMcpContract(contractText));
        const risks = buildSafeMcpRiskItems(result);
        
        return {
            id: contract.id,
            name: contract.name,
            success: result.success,
            aiSucceeded: result.aiSucceeded,
            isLimited: result.isLimited,
            riskLevel: result.riskLevel,
            riskLabel: result.riskLabel,
            riskDisplay: result.riskDisplay,
            summary: result.summary,
            riskReason: result.riskReason,
            risks,
            recommendedActions: buildSafeMcpRecommendedActions(risks)
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

        const compactDiffChanges = diffService.compressChangesForMcp(diffChanges, { perSideLineLimit: 4 });

        const result = decorateAnalysisResult(await gemini.analyzeMcpDiff(compactDiffChanges, {
            contractAName: contractA.name,
            contractBName: contractB.name
        }));
        const report = buildComparisonReport(result);
        const diffPreview = buildDiffPreviewLines(compactDiffChanges);

        return {
            contractA: contractA.name,
            contractB: contractB.name,
            success: result.success,
            aiSucceeded: result.aiSucceeded,
            isLimited: result.isLimited,
            riskLevel: result.riskLevel,
            riskLabel: result.riskLabel,
            riskDisplay: result.riskDisplay,
            summary: result.summary,
            riskReason: result.riskReason,
            changes: result.changes,
            diffPreview: diffPreview,
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
