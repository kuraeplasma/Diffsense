const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const rateLimit = require('../middleware/rateLimit');
const { validateAnalyzeRequest } = require('../utils/validator');
const geminiService = require('../services/gemini');
const pdfService = require('../services/pdf');
const urlService = require('../services/url');
const docxService = require('../services/docxService');
const diffService = require('../services/diffService');
const dbService = require('../services/db');
const { toLegacyArticleArray, fromLegacyArticleArray } = require('../services/contractStructure');
const logger = require('../utils/logger');
const crypto = require('crypto');
const stringSimilarity = require('string-similarity');
const mammoth = require('mammoth');
const { bucket } = require('../firebase');

router.get('/', async (req, res, next) => {
    try {
        const uid = req.user.uid;
        const email = req.user.email;
        const teamInfo = await dbService.getTeamRole(email, uid);
        const ownerUid = teamInfo.ownerUid;

        const contracts = await dbService.getContracts(ownerUid);
        res.json({ success: true, data: contracts });
    } catch (error) {
        logger.error('Contracts list error:', error);
        next(error);
    }
});



router.post('/', async (req, res, next) => {
    try {
        const uid = req.user.uid;
        const email = req.user.email;
        const teamInfo = await dbService.getTeamRole(email, uid);
        const ownerUid = teamInfo.ownerUid;

        // 登録数は全プランで無制限のためチェック不要
        const contracts = await dbService.getContracts(ownerUid);

        const payload = req.body || {};
        const nowIso = new Date().toISOString();
        const contract = {
            id: Number(payload.id) || Date.now(),
            name: String(payload.name || '').trim() || '書類',
            type: String(payload.type || '').trim() || '契約書',
            created_at: payload.created_at || nowIso,
            last_updated_at: payload.last_updated_at || nowIso,
            risk_level: payload.risk_level || 'None',
            status: payload.status || '未解析',
            assignee_name: payload.assignee_name || '-',
            original_content: payload.original_content || '',
            source_url: payload.source_url || '',
            original_filename: payload.original_filename || '',
            monitoring_enabled: payload.monitoring_enabled === true,
            last_checked_at: payload.last_checked_at || null,
            last_hash: payload.last_hash || null,
            stable_count: Number(payload.stable_count || 0),
            extract_status: payload.extract_status || null,
            source_type: payload.source_type || null,
            pdf_storage_path: payload.pdf_storage_path || null,
            pdf_url: payload.pdf_url || null,
            original_file_path: payload.original_file_path || payload.filePath || null,
            original_file_url: payload.original_file_url || payload.fileUrl || null,
            history: Array.isArray(payload.history) ? payload.history : []
        };
        const saved = await dbService.saveContract(ownerUid, contract);
        res.status(201).json({ success: true, data: saved });

        // If URL-based contract, trigger background crawl to save baseline immediately
        if (saved.source_url && !saved.last_hash) {
            const cronService = require('../services/cronService');
            cronService.processContract({ ...saved, ownerUid }).catch(err => {
                logger.warn(`Background baseline crawl failed for contract ${saved.id}: ${err.message}`);
            });
        }
    } catch (error) {
        logger.error('Contracts create error:', error);
        next(error);
    }
});

router.patch('/:id', async (req, res, next) => {
    try {
        const uid = req.user.uid;
        const email = req.user.email;
        const teamInfo = await dbService.getTeamRole(email, uid);
        const ownerUid = teamInfo.ownerUid;

        const contractId = Number(req.params.id);
        if (!Number.isFinite(contractId)) {
            return res.status(400).json({ success: false, error: '契約IDが不正です' });
        }
        const updates = { ...(req.body || {}) };
        delete updates.ownerUid;

        // 空値フィールドで既存データを上書きしない
        const protectedFields = ['original_file_path', 'pdf_storage_path', 'pdf_url', 'source_url'];
        protectedFields.forEach(field => {
            if (updates[field] === null || updates[field] === undefined || updates[field] === '') {
                delete updates[field];
            }
        });

        const updated = await dbService.updateContract(contractId, updates, ownerUid);
        if (!updated) {
            return res.status(404).json({ success: false, error: '契約が見つかりません' });
        }
        res.json({ success: true, data: updated });
    } catch (error) {
        logger.error('Contracts update error:', error);
        next(error);
    }
});

function isLocalUnlimitedMode(req) {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
    const isLocalHost = host.includes('localhost') || host.includes('127.0.0.1');
    return process.env.NODE_ENV === 'development' && process.env.AUTH_BYPASS === 'true' && isLocalHost;
}

function isAiFailureSummary(summary) {
    return /AI解析に失敗|AI分析に失敗|エラーが発生/.test(String(summary || ''));
}

function isAiResultReady(result) {
    const summary = String(result?.summary || '').trim();
    if (!summary) return false;
    if (result?.isFallback === true) return false;
    if (isAiFailureSummary(summary)) return false;
    if (result?.aiSucceeded === false) return false;
    return true;
}

function hasMeaningfulContractMeta(meta) {
    if (!meta || typeof meta !== 'object') return false;
    const noticePeriod = Number(meta.notice_period_days);
    return Boolean(
        meta.expiry_date
        || meta.renewal_deadline
        || meta.contract_start
        || meta.contract_category
        || meta.auto_renewal === true
        || meta.auto_renewal === false
        || Number.isFinite(noticePeriod)
    );
}

function normalizeContentToText(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((section) => {
            if (!section || typeof section !== 'object') return String(section || '');
            const article = typeof section.article === 'string' ? section.article : '';
            const title = typeof section.title === 'string' ? section.title : '';
            const paragraphs = Array.isArray(section.paragraphs)
                ? section.paragraphs.map((p) => {
                    if (typeof p === 'string') return p;
                    if (p && typeof p === 'object') return p.content || p.body || JSON.stringify(p);
                    return '';
                }).filter(Boolean).join('\n')
                : '';
            return `${article} ${title}\n${paragraphs}`.trim();
        }).filter(Boolean).join('\n\n');
    }
    if (typeof content === 'object' && Array.isArray(content.articles)) {
        return toLegacyArticleArray(content).map((a) => `${a.article || ''} ${a.title || ''}\n${(a.paragraphs || []).join('\n')}`.trim()).join('\n\n');
    }
    if (typeof content === 'object') return JSON.stringify(content);
    return String(content);
}

function normalizeContentToLegacyArticles(content) {
    if (content === null || content === undefined) return [];
    if (Array.isArray(content)) return content;
    if (typeof content === 'object' && Array.isArray(content.articles)) {
        return toLegacyArticleArray(content);
    }
    if (typeof content === 'string') {
        const trimmed = content.trim();
        if (!trimmed) return [];
        return docxService.parseTextToArticles(trimmed);
    }
    return [];
}

function defaultStructuredImpact(change) {
    const type = String(change?.type || '').toUpperCase();
    if (type === 'ADD') return '新規条項または文言追加が含まれます';
    if (type === 'DELETE') return '既存条項または文言の削除が含まれます';
    return '既存条項の文言変更が含まれます';
}

function defaultStructuredConcern(change) {
    const type = String(change?.type || '').toUpperCase();
    if (type === 'ADD') return '追加内容の法的効果を確認してください';
    if (type === 'DELETE') return '削除による権利義務の変化を確認してください';
    return '変更前後で条件や責任範囲が変わっていないか確認してください';
}

function normalizeStructuredChangeType(value, fallbackType = 'MODIFY') {
    const raw = String(value || '').trim().toUpperCase();
    if (raw === 'ADD' || raw === '追加') return 'ADD';
    if (raw === 'DELETE' || raw === '削除') return 'DELETE';
    if (raw === 'MODIFY' || raw === 'CHANGE' || raw === '修正' || raw === '変更') return 'MODIFY';
    return normalizeStructuredChangeType(fallbackType || 'MODIFY', 'MODIFY');
}

function deriveStructuredRiskLevel(changes, fallbackLevel = 1) {
    const numeric = Number(fallbackLevel || 0);
    if ([1, 2, 3].includes(numeric)) return numeric;
    const hasDelete = changes.some((item) => String(item?.type || '').toUpperCase() === 'DELETE');
    return hasDelete ? 2 : 1;
}

function structuredRiskConcern(evaluated, change) {
    const level = Number(evaluated?.riskLevel || 0);
    if (level >= 3) return '高リスクの変更として確認してください';
    if (level === 2) return '契約条件への影響を確認してください';
    return defaultStructuredConcern(change);
}

function normalizeSignalText(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .replace(/[（）()【】「」『』\[\]{}]/g, '')
        .trim();
}

function extractMaterialValueTokens(text) {
    return normalizeSignalText(text)
        .match(/\d[\d,]*(?:\.\d+)?(?:円|万円|千円|百万円|億円|%|％|日|営業日|か月|ヶ月|ヵ月|月|年|件|個|株|条|項|回)/g) || [];
}

function hasKeywordDelta(oldText, newText) {
    const keywords = [
        '支払', '金額', '対価', '譲渡価格', '料金', '報酬', '期限', '期間', '営業日',
        '責任', '義務', '権利', '解除', '解約', '再委託', '知的財産', '秘密保持',
        '補償', '損害賠償', '保証', '表明保証', '競業避止', '納期', '数量', '株式',
        '新株予約権', '費用', '条件', 'クロージング'
    ];
    const oldNorm = normalizeSignalText(oldText);
    const newNorm = normalizeSignalText(newText);
    return keywords.some((keyword) => oldNorm.includes(keyword) !== newNorm.includes(keyword));
}

/**
 * Super Normalizer to unify CJK character widths and eliminate layout noise
 */
function superNormalize(str) {
    if (!str) return '';
    return String(str)
        .replace(/[！-～]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)) // Full-width to Half-width
        .replace(/　/g, ' ') // Full-width space to half-width
        .replace(/[（【［]/g, '(')
        .replace(/[）】］]/g, ')')
        .replace(/[「『]/g, '"')
        .replace(/[」』]/g, '"')
        .replace(/[―ー—－]/g, '-')
        .replace(/[\s\n\r\t]+/g, '') // Remove all whitespace for the comparison check
        .trim();
}

function isLikelyMaterialStructuredChange(change) {
    const type = String(change?.type || '').toUpperCase();
    const oldText = String(change?.old || '').trim();
    const newText = String(change?.new || '').trim();

    if (!oldText && !newText) return false;
    if (type === 'ADD' || type === 'DELETE') return true;

    // Use super-normalization for the material change check
    const oldNorm = superNormalize(oldText);
    const newNorm = superNormalize(newText);

    // If identical after super-normalization, it's definitely not material
    if (oldNorm === newNorm) return false;

    // Check similarity on normalized text
    const similarity = stringSimilarity.compareTwoStrings(oldNorm, newNorm);

    // Safety check: if they are extremely similar, it's likely noise (e.g. phantom page numbers)
    // unless it's a very short text where every character matters.
    if (similarity > 0.997 && oldNorm.length > 200) {
        return false;
    }

    const oldTokens = extractMaterialValueTokens(oldText);
    const newTokens = extractMaterialValueTokens(newText);
    if (oldTokens.join('|') !== newTokens.join('|') && (oldTokens.length > 0 || newTokens.length > 0)) {
        return true;
    }

    if (hasKeywordDelta(oldText, newText)) {
        return true;
    }

    if (similarity > 0 && similarity < 0.90 && /(支払|譲渡|解除|責任|義務|保証|補償|対価|料金|費用|株式|新株予約権|期限|期間|延滞|損害)/.test(oldText + newText)) {
        return true;
    }

    return false;
}

function buildGuardrailStructuredChange(change) {
    const type = normalizeStructuredChangeType(change?.type, change?.type);
    const section = String(change?.section || '').trim() || '条文';
    let impact = defaultStructuredImpact(change);
    if (type === 'ADD') {
        impact = `${section} に新しい契約条件が追加されています`;
    } else if (type === 'DELETE') {
        impact = `${section} の契約条件が削除されています`;
    } else if (extractMaterialValueTokens(change?.old).join('|') !== extractMaterialValueTokens(change?.new).join('|')) {
        impact = `${section} の数値条件または金額条件が変更されています`;
    } else {
        impact = `${section} の契約条件が変更されています`;
    }

    return {
        section,
        type,
        old: change?.old || '',
        new: change?.new || '',
        impact,
        concern: defaultStructuredConcern(change)
    };
}

function buildGuardrailSummary(changes) {
    const labels = changes
        .slice(0, 3)
        .map((item) => String(item.section || '').trim())
        .filter(Boolean);
    const suffix = changes.length > labels.length ? ` ほか${changes.length - labels.length}件の変更があります。` : '';
    if (labels.length > 0) {
        return `${labels.join('、')} に契約上の変更があります。${suffix}`.trim();
    }
    return `${changes.length}件の契約変更を検出しました。`;
}

function buildGuardrailRiskReason(changes) {
    const hasDelete = changes.some((item) => String(item.type || '').toUpperCase() === 'DELETE');
    const hasNumeric = changes.some((item) => {
        const oldTokens = extractMaterialValueTokens(item.old);
        const newTokens = extractMaterialValueTokens(item.new);
        return oldTokens.join('|') !== newTokens.join('|') && (oldTokens.length > 0 || newTokens.length > 0);
    });
    if (hasDelete && hasNumeric) return '契約条件の削除と数値条件の変更を検出しました。';
    if (hasDelete) return '契約条件の削除を検出しました。';
    if (hasNumeric) return '金額・数量・期限などの条件変更を検出しました。';
    return '契約条件の変更を検出しました。';
}

function mergeStructuredAndGeneralAnalysis(structuredPairAnalysis, genericAnalysis) {
    const structuredChanges = Array.isArray(structuredPairAnalysis?.changes) ? structuredPairAnalysis.changes.filter(Boolean) : [];
    if (!structuredPairAnalysis) {
        return genericAnalysis;
    }
    if (!genericAnalysis) {
        return structuredPairAnalysis;
    }

    return geminiService.normalizeAnalyzeResult({
        changes: structuredChanges.length > 0
            ? structuredChanges
            : (Array.isArray(genericAnalysis.changes) ? genericAnalysis.changes : []),
        riskLevel: Number(genericAnalysis.riskLevel || structuredPairAnalysis.riskLevel || 1),
        riskReason: String(genericAnalysis.riskReason || structuredPairAnalysis.riskReason || '').trim(),
        summary: String(genericAnalysis.summary || structuredPairAnalysis.summary || '').trim(),
        isFallback: genericAnalysis.isFallback === true && structuredPairAnalysis.isFallback === true
    });
}

function hasStructuredChanges(analysis) {
    return Array.isArray(analysis?.changes) && analysis.changes.filter(Boolean).length > 0;
}

async function buildStructuredPairAnalysis(oldArticles, newArticles) {
    if (!Array.isArray(oldArticles) || !Array.isArray(newArticles)) return null;
    if (oldArticles.length === 0 || newArticles.length === 0) return null;

    const diffChanges = diffService.compare(oldArticles, newArticles);
    if (diffChanges.length === 0) {
        return {
            changes: [],
            riskLevel: 1,
            riskReason: '差分は検出されませんでした',
            summary: '差分は検出されませんでした',
            isFallback: false
        };
    }

    const analysis = await geminiService.analyzeStructuredDiff(diffChanges);
    if (analysis?.isFallback === true) {
        const guardrailChanges = diffChanges.filter(isLikelyMaterialStructuredChange).map(buildGuardrailStructuredChange);
        logger.warn('Structured pair analysis fell back', {
            diffChanges: diffChanges.length,
            guardrailChanges: guardrailChanges.length
        });
        if (guardrailChanges.length > 0) {
            return {
                changes: guardrailChanges,
                riskLevel: guardrailChanges.some((item) => String(item.type || '').toUpperCase() === 'DELETE') ? 2 : 1,
                riskReason: buildGuardrailRiskReason(guardrailChanges),
                summary: buildGuardrailSummary(guardrailChanges),
                isFallback: false
            };
        }
        return {
            changes: [],
            riskLevel: 1,
            riskReason: String(analysis?.riskReason || 'AI要約未取得').trim() || 'AI要約未取得',
            summary: String(analysis?.summary || 'AI解析の結果、実質的な変更は検出されませんでした。').trim() || 'AI解析の結果、実質的な変更は検出されませんでした。',
            isFallback: true
        };
    }

    const resultMap = new Map(
        (Array.isArray(analysis?.results) ? analysis.results : [])
            .filter((item) => item && item.sectionId)
            .map((item) => [String(item.sectionId), item])
    );
    const mappedChanges = diffChanges.map((change, index) => {
        const evaluated = resultMap.get(`CHG-${index}`);
        const aiConfirmed = evaluated?.change === true;
        return {
            section: change.section,
            type: normalizeStructuredChangeType(change.type, change.type),
            old: change.old,
            new: change.new,
            impact: aiConfirmed
                ? (evaluated.summary || defaultStructuredImpact(change))
                : defaultStructuredImpact(change),
            concern: aiConfirmed
                ? structuredRiskConcern(evaluated, change)
                : ''
        };
    }).filter(Boolean);

    if (mappedChanges.length === 0) {
        const guardrailChanges = diffChanges.filter(isLikelyMaterialStructuredChange).map(buildGuardrailStructuredChange);
        logger.info('Structured pair analysis produced no AI changes', {
            diffChanges: diffChanges.length,
            guardrailChanges: guardrailChanges.length
        });
        if (guardrailChanges.length > 0) {
            return {
                changes: guardrailChanges,
                riskLevel: guardrailChanges.some((item) => String(item.type || '').toUpperCase() === 'DELETE') ? 2 : 1,
                riskReason: buildGuardrailRiskReason(guardrailChanges),
                summary: buildGuardrailSummary(guardrailChanges),
                isFallback: false
            };
        }
        return {
            changes: [],
            riskLevel: 1,
            riskReason: String(analysis?.riskReason || '契約上の意味変更はありません。').trim() || '契約上の意味変更はありません。',
            summary: String(analysis?.summary || '実質的な契約変更は検出されませんでした。').trim() || '実質的な契約変更は検出されませんでした。',
            isFallback: false
        };
    }

    return {
        changes: mappedChanges,
        riskLevel: deriveStructuredRiskLevel(mappedChanges, analysis?.riskLevel),
        riskReason: String(analysis?.riskReason || '').trim() || '変更点を確認してください',
        summary: String(analysis?.summary || '').trim() || `${mappedChanges.length}件の変更を検出しました`,
        isFallback: analysis?.isFallback === true
    };
}

function decodeBase64Payload(raw) {
    const base64Clean = String(raw || '').split(',').pop();
    return Buffer.from(base64Clean, 'base64');
}

function buildFirebaseDownloadUrl(bucketName, objectPath, token) {
    const encodedPath = encodeURIComponent(objectPath).replace(/%2F/g, '%2F');
    return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodedPath}?alt=media&token=${token}`;
}

async function extractTextFromDocx(buffer) {
    const result = await mammoth.extractRawText({ buffer });
    return String(result?.value || '').replace(/\r/g, '');
}

function getArticleExtractionStats(articles = []) {
    const list = Array.isArray(articles) ? articles : [];
    let articleCount = 0;
    let maxArticleNumber = 0;
    let textLength = 0;

    for (const article of list) {
        const label = String(article?.article || '').trim();
        if (/^第\s*[0-9０-９一二三四五六七八九十百千〇○◯零]+\s*条$/.test(label)) {
            articleCount += 1;
            const numeric = Number(article.article_number || 0);
            if (Number.isFinite(numeric)) {
                maxArticleNumber = Math.max(maxArticleNumber, numeric);
            }
        }
        textLength += normalizeContentToText([article]).length;
    }

    return { articleCount, maxArticleNumber, textLength };
}

function isBetterDocxExtraction(candidate, current) {
    if (!current) return true;
    const a = candidate.stats || getArticleExtractionStats(candidate.articles);
    const b = current.stats || getArticleExtractionStats(current.articles);
    if (a.articleCount !== b.articleCount) return a.articleCount > b.articleCount;
    if (a.maxArticleNumber !== b.maxArticleNumber) return a.maxArticleNumber > b.maxArticleNumber;
    return a.textLength > b.textLength;
}

async function extractReliableDocxContent(buffer, primaryText = '', primaryMethod = 'mammoth') {
    const candidates = [];
    const pushCandidate = (method, rawText, articles) => {
        const normalizedArticles = Array.isArray(articles) ? articles : docxService.parseTextToArticles(rawText);
        candidates.push({
            method,
            rawText: String(rawText || '').replace(/\r/g, ''),
            articles: normalizedArticles,
            stats: getArticleExtractionStats(normalizedArticles)
        });
    };

    if (String(primaryText || '').trim()) {
        pushCandidate(primaryMethod, primaryText, null);
    }

    try {
        const mammothText = await extractTextFromDocx(buffer);
        pushCandidate('mammoth', mammothText, null);
    } catch (error) {
        logger.warn('Mammoth DOCX extraction failed:', error.message);
    }

    try {
        const xmlArticles = await docxService.parseDocx(buffer);
        pushCandidate('docx_xml', normalizeContentToText(xmlArticles), xmlArticles);
    } catch (error) {
        logger.warn('DOCX XML extraction failed:', error.message);
    }

    const best = candidates.reduce((selected, candidate) => (
        isBetterDocxExtraction(candidate, selected) ? candidate : selected
    ), null);

    if (!best) {
        throw new Error('DOCX_TEXT_EXTRACTION_FAILED');
    }

    logger.info(
        `DOCX extraction selected ${best.method}: articles=${best.stats.articleCount}, max=${best.stats.maxArticleNumber}, length=${best.stats.textLength}`
    );

    return {
        rawText: best.rawText || normalizeContentToText(best.articles),
        articles: best.articles,
        structuredContract: fromLegacyArticleArray(best.articles),
        method: best.method,
        stats: best.stats
    };
}

async function resolvePreviousDocxArticles(previousVersion) {
    if (!previousVersion) return [];
    if (Array.isArray(previousVersion)) return previousVersion;
    if (typeof previousVersion === 'object' && Array.isArray(previousVersion.articles)) {
        return toLegacyArticleArray(previousVersion);
    }
    if (typeof previousVersion !== 'string') return [];

    const trimmed = previousVersion.trim();
    if (!trimmed) return [];

    const looksLikeRawText = /\n|第\s*[0-9０-９一二三四五六七八九十百千〇零]+\s*条/.test(trimmed);
    if (looksLikeRawText) {
        return docxService.parseTextToArticles(trimmed);
    }

    try {
        const buffer = decodeBase64Payload(trimmed);
        const isZip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4B;
        if (!isZip) return docxService.parseTextToArticles(trimmed);
        try {
            const extractedText = await extractTextFromDocx(buffer);
            return docxService.parseTextToArticles(extractedText);
        } catch (mammothError) {
            logger.warn('Mammoth parse failed for previous DOCX; fallback parser used:', mammothError.message);
            return await docxService.parseDocx(buffer);
        }
    } catch (error) {
        logger.warn('Failed to parse previousVersion as DOCX, fallback to text parser:', error.message);
        return docxService.parseTextToArticles(trimmed);
    }
}

/**
 * POST /api/contracts/analyze
 * Analyze a contract from PDF or URL
 */
router.post('/analyze', rateLimit, async (req, res, next) => {
    try {
        // Validate request
        const { error, value } = validateAnalyzeRequest(req.body);
        if (error) {
            logger.warn('Validation error:', error.details[0].message);
            return res.status(400).json({
                success: false,
                error: error.details[0].message
            });
        }

        const { contractId, method, source, previousVersion } = value;
        const skipAI = req.body.skipAI === true;
        const uid = req.user.uid;
        const email = req.user.email;

        // Resolve ownerUid for team members to check usage against owner's plan
        const teamInfo = await dbService.getTeamRole(email, uid);
        const ownerUid = teamInfo.ownerUid;

        logger.info(`Starting analysis for contract ${contractId} by user ${uid} (owner: ${ownerUid})`, { method });

        // 0. Usage & Plan Limit Check (skip for text-only extraction)
        const userProfile = await dbService.getUserProfile(ownerUid);
        const localUnlimited = isLocalUnlimitedMode(req);
        const limit = localUnlimited ? Number.MAX_SAFE_INTEGER : dbService.getUsageLimit(userProfile);

        logger.info(`Usage check for ${uid} (owner: ${ownerUid}):`, {
            plan: userProfile.plan,
            usageCount: userProfile.usageCount,
            limit: limit,
            skipAI: skipAI,
            hasPaymentMethod: userProfile.hasPaymentMethod
        });

        if (!skipAI && !localUnlimited) {
            if (userProfile.usageCount >= limit) {
                logger.warn(`Usage limit reached for user ${uid}`, { plan: userProfile.plan, current: userProfile.usageCount });

                const plan = userProfile.plan || 'free';
                const nextPlanMap = {
                    'free': { name: 'Starter', limit: 50, price: '¥1,480' },
                    'trial': { name: 'Starter', limit: 50, price: '¥1,480' },
                    'starter': { name: 'Business', limit: 120, price: '¥4,980' },
                    'business': { name: 'Pro', limit: 400, price: '¥9,800' },
                    'pro': null
                };
                const next = nextPlanMap[plan];
                let suggestion = '来月までお待ちいただくか、プランのアップグレードをご検討ください。';
                if (next) {
                    suggestion = `${next.name}プラン（${next.price}/月）にアップグレードすると、月${next.limit}回までAI解析が可能です。`;
                }

                return res.status(403).json({
                    success: false,
                    code: 'ANALYSIS_LIMIT_EXCEEDED',
                    message: `今月のAI差分チェック回数の上限に達しました。\n\n${suggestion}`,
                    error: '今月のAI差分チェック回数の上限に達しました',
                    currentUsage: userProfile.usageCount,
                    limit: limit,
                    plan: plan,
                    nextPlan: next
                });
            }
        }

        // 1. Save PDF file early if method is 'pdf'
        let pdfUrl = null;
        let pdfStoragePath = null;
        if (method === 'pdf') {
            const { bucket } = require('../firebase');

            // Remove data URL prefix
            const buffer = decodeBase64Payload(source);

            // Try to upload to Firebase Storage (optional - analysis continues even if this fails)
            if (bucket) {
                // Delete old PDF from Storage before uploading new one (prevents unbounded storage growth)
                // Safety check: do NOT delete if there are pending sign requests referencing this contract
                try {
                    const existingContracts = await dbService.getContracts(ownerUid);
                    const existingContract = Array.isArray(existingContracts)
                        ? existingContracts.find(c => String(c.id) === String(contractId))
                        : null;
                    const oldStoragePath = existingContract?.pdf_storage_path || existingContract?.pdfStoragePath;
                    if (oldStoragePath && oldStoragePath.startsWith('contracts/')) {
                        // Check for pending sign requests (status: pending/sent/partially_signed)
                        const signRequests = await dbService.getSignRequests(ownerUid).catch(() => []);
                        const pendingSignStatuses = ['pending', 'sent', 'partially_signed', 'in_progress'];
                        const hasPendingSign = Array.isArray(signRequests) && signRequests.some(sr =>
                            String(sr.contract_id) === String(contractId)
                            && pendingSignStatuses.includes(sr.status)
                        );
                        if (hasPendingSign) {
                            logger.info(`Old PDF NOT deleted: pending sign request exists for contract ${contractId}`);
                        } else {
                            const oldFile = bucket.file(oldStoragePath);
                            await oldFile.delete().catch(e => logger.warn(`Old PDF delete failed (non-fatal): ${e.message}`));
                            logger.info(`Old PDF deleted from Storage: ${oldStoragePath}`);
                        }
                    }
                } catch (cleanupError) {
                    logger.warn(`Old PDF cleanup failed (non-fatal): ${cleanupError.message}`);
                }

                try {
                    pdfStoragePath = `contracts/${contractId}/${Date.now()}.pdf`;
                    const file = bucket.file(pdfStoragePath);
                    const downloadToken = crypto.randomUUID();

                    await file.save(buffer, {
                        metadata: {
                            contentType: 'application/pdf',
                            metadata: {
                                firebaseStorageDownloadTokens: downloadToken
                            }
                        }
                    });

                    try {
                        const [signedUrl] = await file.getSignedUrl({
                            action: 'read',
                            expires: Date.now() + 31536000000
                        });
                        pdfUrl = signedUrl;
                    } catch (signedUrlError) {
                        // Fallback: tokenized download URL (does not rely on signBlob capability)
                        const bucketName = bucket.name || process.env.FB_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET;
                        if (!bucketName) {
                            throw signedUrlError;
                        }
                        pdfUrl = buildFirebaseDownloadUrl(bucketName, pdfStoragePath, downloadToken);
                        logger.warn('Signed URL generation failed. Falling back to token download URL:', signedUrlError.message);
                    }
                    logger.info(`PDF uploaded to Firebase Storage: ${pdfStoragePath}`);
                } catch (storageError) {
                    logger.warn('Firebase Storage upload failed. bucket=' + (bucket?.name || 'null') + ' error=' + (storageError?.message || String(storageError)) + ' stack=' + (storageError?.stack || ''));
                    pdfUrl = null;
                    pdfStoragePath = null;
                }
            } else {
                // No bucket available - try local save in dev
                const isCloudFunction = !!process.env.FUNCTION_TARGET || !!process.env.K_SERVICE;
                if (!isCloudFunction) {
                    try {
                        const fs = require('fs');
                        const path = require('path');
                        const filename = `contract-${contractId}-${crypto.randomUUID()}.pdf`;
                        const uploadsDir = path.join(__dirname, '../../uploads');
                        if (!fs.existsSync(uploadsDir)) {
                            fs.mkdirSync(uploadsDir, { recursive: true });
                        }
                        pdfStoragePath = path.join(uploadsDir, filename);
                        await fs.promises.writeFile(pdfStoragePath, buffer);
                        const protocol = req.protocol;
                        const baseUrl = `${protocol}://${req.get('host')}`;
                        pdfUrl = `${baseUrl}/uploads/${filename}`;
                        logger.info(`PDF saved locally: ${pdfStoragePath}`);
                    } catch (localError) {
                        logger.warn('Local PDF save failed:', localError.message);
                    }
                } else {
                    logger.warn('No storage available in Cloud Functions - PDF will not be persisted');
                }
            }

        } else if (method === 'url') {
            pdfUrl = source;
            pdfStoragePath = source;
        }

        let extractedText = "";
        let structuredContract = null;
        let rawExtractedText = '';
        let aiResult = {
            changes: [],
            riskLevel: 1,
            riskReason: '解析待ち',
            summary: '解析の準備ができました'
        };

        try {
            // 2. Extract text
            if (method === 'pdf') {
                const pdfResult = await pdfService.extractText(source);
                if (pdfResult && typeof pdfResult === 'object' && Array.isArray(pdfResult.articles)) {
                    structuredContract = pdfResult.structuredContract || null;
                    extractedText = pdfResult.articles;
                    rawExtractedText = String(pdfResult.rawText || '');
                    
                    const pageCount = pdfResult.pageCount || 0;
                    if (pageCount > 0 && contractId) {
                        await dbService.updateContract(contractId, {
                            document_meta: { pageCount }
                        }, ownerUid).catch(e => logger.warn(`Failed to update pageCount for PDF ${contractId}: ${e.message}`));
                    }
                } else {
                    extractedText = pdfResult;
                }
            } else if (method === 'docx') {
                const docxBuffer = decodeBase64Payload(source);
                const docxContent = await extractReliableDocxContent(docxBuffer);
                rawExtractedText = docxContent.rawText;
                extractedText = docxContent.articles;
                structuredContract = docxContent.structuredContract;
            } else if (method === 'url') {
                extractedText = await urlService.extractText(source);
            } else if (method === 'text') {
                extractedText = source;
            }

            // 3. Analyze with Gemini AI (skip if text-only extraction)
            if (skipAI) {
                logger.info('skipAI=true: Skipping Gemini analysis, text extraction only');
                aiResult.summary = 'テキスト抽出のみ完了（AI解析はスキップ）';
            } else {
                const textToAnalyze = normalizeContentToText(extractedText);
                const previousVersionText = normalizeContentToText(previousVersion);

                if (textToAnalyze.trim().length > 0) {
                    const structuredPairAnalysis = previousVersionText
                        ? await buildStructuredPairAnalysis(
                            normalizeContentToLegacyArticles(previousVersion),
                            normalizeContentToLegacyArticles(extractedText)
                        )
                        : null;

                    const shouldRunGenericAnalysis = Boolean(previousVersionText);
                    const genericAnalysis = shouldRunGenericAnalysis
                        ? await geminiService.analyzeContract(
                            textToAnalyze,
                            previousVersionText
                        )
                        : null;

                    if (hasStructuredChanges(structuredPairAnalysis)) {
                        aiResult = mergeStructuredAndGeneralAnalysis(structuredPairAnalysis, genericAnalysis);
                    } else if (genericAnalysis) {
                        aiResult = mergeStructuredAndGeneralAnalysis(structuredPairAnalysis, genericAnalysis);
                    } else if (structuredPairAnalysis) {
                        aiResult = structuredPairAnalysis;
                    } else {
                        aiResult = await geminiService.analyzeContract(
                            textToAnalyze,
                            previousVersionText
                        );
                    }

                    // 3.1 Increment Usage Count ONLY on successful AI analysis
                    const aiSucceeded = aiResult && aiResult.summary && !isAiFailureSummary(aiResult.summary) && aiResult.isFallback !== true;
                    if (aiSucceeded && !localUnlimited) {
                        await dbService.incrementUsage(ownerUid);
                        // 3.2 Save contract_meta (deadline info) - with ensureContractMeta fallback
                        const meta = await geminiService.ensureContractMeta(textToAnalyze, previousVersionText, aiResult.contract_meta);
                        if (meta && contractId) {
                            const metaUpdate = {
                                expiry_date: meta.expiry_date || null,
                                renewal_deadline: meta.renewal_deadline || null,
                                contract_start: meta.contract_start || null,
                                auto_renewal: meta.auto_renewal === true,
                                notice_period_days: Number(meta.notice_period_days) || null,
                                contract_category: meta.contract_category || null,
                                contract_amount: meta.contract_amount || null,
                                parties: meta.parties || null,
                                date_confidence: meta.date_confidence || 'unknown',
                                alert_sent_30d: false,
                                alert_sent_7d: false,
                                alert_sent_0d: false
                            };
                            await dbService.updateContract(contractId, metaUpdate, ownerUid);
                            logger.info(`contract_meta saved for contract ${contractId}: expiry=${meta.expiry_date}, confidence=${meta.date_confidence}`);
                        }
                    } else if (!aiSucceeded) {
                        logger.info(`AI analysis failed for user ${uid} - usage count NOT incremented`);
                    }
                } else {
                    logger.warn('No text extracted, skipping AI analysis');
                    aiResult.summary = 'テキストを抽出できませんでした（画像ベースの可能性があります）';
                    aiResult.riskReason = 'テキストを抽出できませんでした';
                }
            }

        } catch (error) {
            logger.error('Non-fatal analysis error:', error);
            // We don't rethrow, just return what we have (file is saved)
            aiResult.summary = `解析中にエラーが発生しました: ${error.message}`;
            aiResult.riskReason = 'エラーにより解析中断';
        }

        const textForHash = (extractedText && typeof extractedText === 'object')
            ? JSON.stringify(extractedText)
            : String(extractedText || '');
        const extractedTextHash = crypto.createHash('sha256').update(textForHash).digest('hex');
        const extractedTextLength = textForHash.length;

        logger.info(`Response ready for contract ${contractId}`);

        // 4. Feature Gating
        let gatedChanges = aiResult.changes || [];
        const plan = userProfile.plan || 'free';
        const isFree = plan === 'free';
        const isStarter = plan === 'starter';

        const isLimited = isFree || isStarter || aiResult.isLimited === true;

        logger.info(`analyze response contractId=${contractId} success=${aiResult.success} aiSucceeded=${aiResult.aiSucceeded} isLimited=${isLimited}`);
        res.json({
            success: true,
            data: {
                ...aiResult,
                extractedText,
                extractedTextHash,
                extractedTextLength,
                sourceType: method.toUpperCase(),
                pdfStoragePath,
                pdfUrl,
                isLimited,
                structuredContract,
                rawExtractedText
            }
        });
    } catch (error) {
        logger.error('Analysis error:', error);
        next(error);
    }
});

/**
 * POST /api/contracts/convert-docx
 * Manually trigger DOCX to PDF conversion for an existing contract
 */
router.post('/convert-docx', async (req, res, next) => {
    try {
        const { contractId } = req.body;
        const uid = req.user.uid;
        const email = req.user.email;
        const teamInfo = await dbService.getTeamRole(email, uid);
        const ownerUid = teamInfo.ownerUid;

        logger.info(`Starting manual DOCX conversion for contract ${contractId}`);

        const contract = await dbService.getContractById(contractId, ownerUid);
        if (!contract) {
            return res.status(404).json({ success: false, error: '契約が見つかりません' });
        }

        let originalPath = contract.original_file_path || contract.originalFilePath;
        const fs = require('fs');
        const pathMod = require('path');
        const uploadsDir = pathMod.join(__dirname, '../../uploads');
        let localPath = null;

        if (originalPath) {
            localPath = pathMod.isAbsolute(originalPath) ? originalPath : pathMod.resolve(pathMod.join(__dirname, '../..', originalPath));
            if (!fs.existsSync(localPath)) {
                // Fallback: search by basename in uploadsDir
                const filename = pathMod.basename(originalPath);
                const candidate = pathMod.join(uploadsDir, filename);
                if (fs.existsSync(candidate)) localPath = candidate;
            }
        }

        // Final Fallback: search by contractId if still not found or no path provided
        if ((!localPath || !fs.existsSync(localPath)) && fs.existsSync(uploadsDir)) {
            const prefix = `original-${contractId}-`;
            const files = fs.readdirSync(uploadsDir)
                .filter(f => f.startsWith(prefix) && f.toLowerCase().endsWith('.docx'))
                .map(f => ({ f, mtime: fs.statSync(pathMod.join(uploadsDir, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);
            if (files.length > 0) {
                localPath = pathMod.join(uploadsDir, files[0].f);
                logger.info(`Found DOCX via ID search: ${localPath}`);
            }
        }

        if (!localPath || !fs.existsSync(localPath)) {
             return res.status(400).json({ success: false, error: '変換可能なDOCX原本ファイルがサーバー上に見つかりません' });
        }

        // 変換実行
        const pdfPath = await docxService.convertToPdf(localPath);
        if (!fs.existsSync(pdfPath)) {
            throw new Error('LibreOffice conversion failed to produce a file');
        }

        // Generate high-fidelity PNG fallback images
        const pageImages = await docxService.generatePageImages(pdfPath, contractId);

        const pdfBuffer = fs.readFileSync(pdfPath);

        // Upload to Storage
        let pdfUrl = null;
        let pdfStoragePath = null;

        if (bucket) {
            pdfStoragePath = `contracts/${contractId}/${Date.now()}.pdf`;
            const pdfFile = bucket.file(pdfStoragePath);
            const downloadToken = crypto.randomUUID();
            await pdfFile.save(pdfBuffer, {
                metadata: {
                    contentType: 'application/pdf',
                    metadata: { firebaseStorageDownloadTokens: downloadToken }
                }
            });

            try {
                const [signedUrl] = await pdfFile.getSignedUrl({
                    action: 'read',
                    expires: Date.now() + 31536000000 // 1 year
                });
                pdfUrl = signedUrl;
            } catch (e) {
                const bucketName = bucket.name || process.env.FIREBASE_STORAGE_BUCKET;
                pdfUrl = buildFirebaseDownloadUrl(bucketName, pdfStoragePath, downloadToken);
            }

            // Update contract in DB
            await dbService.updateContract(contractId, {
                pdf_storage_path: pdfStoragePath,
                pdf_url: pdfUrl,
                page_images: pageImages
            }, ownerUid);
            logger.info(`Contract ${contractId} updated with manual PDF conversion: ${pdfUrl}`);
        } else {
            // Local dev fallback (if no bucket)
            const filename = `manual-${contractId}-${Date.now()}.pdf`;
            const localPdfPath = pathMod.join(uploadsDir, filename);
            fs.writeFileSync(localPdfPath, pdfBuffer);
            const protocol = req.protocol;
            const baseUrl = `${protocol}://${req.get('host')}`;
            pdfUrl = `${baseUrl}/uploads/${filename}`;

            await dbService.updateContract(contractId, {
                pdf_storage_path: localPdfPath,
                pdf_url: pdfUrl
            }, ownerUid);
            logger.info(`Contract ${contractId} updated with local manual PDF conversion: ${pdfUrl}`);
        }

        // Cleanup
        if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);

        res.json({ success: true, url: pdfUrl });

    } catch (error) {
        logger.error('Manual DOCX conversion error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/contracts/upload-docx
 * Parse DOCX and compare by article blocks
 */
router.post('/upload-docx', rateLimit, async (req, res, next) => {
    try {
        const { contractId, source, previousVersion, skipAI } = req.body || {};
        const uid = req.user.uid;
        const email = req.user.email;

        // Resolve ownerUid for team members to check usage against owner's plan
        const teamInfo = await dbService.getTeamRole(email, uid);
        const ownerUid = teamInfo.ownerUid;

        if (!Number.isInteger(contractId) || contractId <= 0) {
            return res.status(400).json({ success: false, error: '"contractId" must be a positive integer' });
        }
        if (!source || typeof source !== 'string') {
            return res.status(400).json({ success: false, error: '"source" is required' });
        }

        const userProfile = await dbService.getUserProfile(ownerUid);
        const localUnlimited = isLocalUnlimitedMode(req);
        const limit = localUnlimited ? Number.MAX_SAFE_INTEGER : dbService.getUsageLimit(userProfile);

        if (!skipAI && !localUnlimited && userProfile.usageCount >= limit) {
            const plan = userProfile.plan || 'free';
            const nextPlanMap = {
                'free': { name: 'Starter', limit: 50, price: '¥1,480' },
                'trial': { name: 'Starter', limit: 50, price: '¥1,480' },
                'starter': { name: 'Business', limit: 120, price: '¥4,980' },
                'business': { name: 'Pro', limit: 400, price: '¥9,800' },
                'pro': null
            };
            const next = nextPlanMap[plan];
            let suggestion = '来月までお待ちいただくか、プランのアップグレードをご検討ください。';
            if (next) {
                suggestion = `${next.name}プラン（${next.price}/月）にアップグレードすると、月${next.limit}回までAI解析が可能です。`;
            }
            return res.status(403).json({
                success: false,
                code: 'ANALYSIS_LIMIT_EXCEEDED',
                message: `今月のAI差分チェック回数の上限に達しました。\n\n${suggestion}`,
                error: '今月のAI差分チェック回数の上限に達しました',
                currentUsage: userProfile.usageCount,
                limit: limit,
                plan: plan,
                nextPlan: next
            });
        }

        const currentBuffer = decodeBase64Payload(source);

        // DEBUG: Log first 4 bytes to identify why magic byte check fails
        if (currentBuffer && currentBuffer.length >= 4) {
            logger.info(`DOCX Upload Magic Bytes: ${currentBuffer[0].toString(16)} ${currentBuffer[1].toString(16)} ${currentBuffer[2].toString(16)} ${currentBuffer[3].toString(16)}`);
        }

        // MIMEタイプ検証: DOCXはZIP形式（magic bytes: PK\x03\x04）
        /* Temporarily disabled as per user feedback "fixed this before" - might be too strict
        if (!currentBuffer || currentBuffer.length < 4 ||
            currentBuffer[0] !== 0x50 || currentBuffer[1] !== 0x4B ||
            currentBuffer[2] !== 0x03 || currentBuffer[3] !== 0x04) {
            return res.status(400).json({ success: false, error: '無効なファイル形式です。Word文書（.docx）をアップロードしてください。' });
        }
        */

        let extractedRawText = '';
        let conversionMethod = 'mammoth';
        const filename = req.body.filename || 'unknown';
        let pdfBuffer = null;
        let pageImages = [];
        let pdfData = null;
        let selectedDocxContent = null;

        try {
            // 1. まずはLibreOfficeでのPDF変換を試みる（原本性が高いため）
            const tmpDir = path.join(__dirname, '../../tmp/docx-convert');
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

            const docxTmpPath = path.join(tmpDir, `upload-${Date.now()}.docx`);
            fs.writeFileSync(docxTmpPath, currentBuffer);

            try {
                const pdfPath = await docxService.convertToPdf(docxTmpPath);
                if (fs.existsSync(pdfPath)) {
                    // Generate high-fidelity PNG fallback images BEFORE unlinking PDF
                    pageImages = await docxService.generatePageImages(pdfPath, contractId);

                    pdfBuffer = fs.readFileSync(pdfPath);
                    pdfData = await pdfService.extractText(pdfBuffer.toString('base64'));
                    extractedRawText = pdfData.rawText || pdfData.text || '';
                    conversionMethod = 'libreoffice_pdf';
                    logger.info(`DOCX conversion success via LibreOffice: ${filename}`);

                    // Cleanup
                    fs.unlinkSync(pdfPath);
                }
            } catch (convError) {
                logger.warn(`LibreOffice conversion failed for ${filename}, falling back to mammoth:`, convError.message);
                conversionMethod = 'mammoth';
            } finally {
                if (fs.existsSync(docxTmpPath)) fs.unlinkSync(docxTmpPath);
            }

            selectedDocxContent = await extractReliableDocxContent(currentBuffer, extractedRawText, conversionMethod);
        } catch (extractError) {
            logger.error('DOCX_CONVERT_ERROR', extractError);
            return res.status(500).json({
                success: false,
                error: 'DOCX_CONVERT_FAILED',
                detail: extractError.message
            });
        }

        extractedRawText = selectedDocxContent.rawText;
        conversionMethod = selectedDocxContent.method;
        const currentArticles = selectedDocxContent.articles;
        const structuredContract = selectedDocxContent.structuredContract;
        const previousArticles = await resolvePreviousDocxArticles(previousVersion);

        const extractedTextHash = crypto.createHash('sha256').update(extractedRawText).digest('hex');

        // --- Persistence Logic: Upload DOCX and PDF to Storage ---
        let original_file_path = null;
        let pdfStoragePath = null;
        let pdfUrl = null;

        const { bucket } = require('../firebase');
        if (bucket) {
            try {
                // 1. Upload Original DOCX
                const docxStoragePath = `contracts/${contractId}/original-${Date.now()}.docx`;
                const docxFile = bucket.file(docxStoragePath);
                await docxFile.save(currentBuffer, {
                    metadata: { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
                });
                original_file_path = docxStoragePath;
                logger.info(`Original DOCX uploaded: ${docxStoragePath}`);

                // 2. Upload Converted PDF (if available)
                if (conversionMethod === 'libreoffice_pdf' && pdfBuffer) {
                    pdfStoragePath = `contracts/${contractId}/${Date.now()}.pdf`;
                    const pdfFile = bucket.file(pdfStoragePath);
                    const downloadToken = crypto.randomUUID();
                    await pdfFile.save(pdfBuffer, {
                        metadata: {
                            contentType: 'application/pdf',
                            metadata: { firebaseStorageDownloadTokens: downloadToken }
                        }
                    });

                    try {
                        const [signedUrl] = await pdfFile.getSignedUrl({
                            action: 'read',
                            expires: Date.now() + 31536000000
                        });
                        pdfUrl = signedUrl;
                    } catch (e) {
                        const bucketName = bucket.name || process.env.FIREBASE_STORAGE_BUCKET;
                        pdfUrl = buildFirebaseDownloadUrl(bucketName, pdfStoragePath, downloadToken);
                    }
                    logger.info(`Converted PDF uploaded: ${pdfStoragePath}`);
                }
            } catch (storageErr) {
                logger.warn('DOCX Storage upload failed:', storageErr.message);
            }
        } else {
            // Local dev fallback (if no bucket)
            const isCloudFunction = !!process.env.FUNCTION_TARGET || !!process.env.K_SERVICE;
            if (!isCloudFunction) {
                try {
                    const uploadsDir = path.join(__dirname, '../../uploads');
                    if (!fs.existsSync(uploadsDir)) {
                        fs.mkdirSync(uploadsDir, { recursive: true });
                    }

                    // 1. Save Original DOCX locally
                    const docxFilename = `original-${contractId}-${Date.now()}.docx`;
                    const docxLocalPath = path.join(uploadsDir, docxFilename);
                    fs.writeFileSync(docxLocalPath, currentBuffer);
                    original_file_path = `uploads/${docxFilename}`;
                    logger.info(`Original DOCX saved locally: ${docxLocalPath}`);

                    // 2. Save Converted PDF locally (if available)
                    if (conversionMethod === 'libreoffice_pdf' && pdfBuffer) {
                        const pdfFilename = `contract-${contractId}-${Date.now()}.pdf`;
                        const pdfLocalPath = path.join(uploadsDir, pdfFilename);
                        fs.writeFileSync(pdfLocalPath, pdfBuffer);
                        pdfStoragePath = pdfLocalPath;

                        const protocol = req.protocol;
                        const baseUrl = `${protocol}://${req.get('host')}`;
                        pdfUrl = `${baseUrl}/uploads/${pdfFilename}`;
                        logger.info(`Converted PDF saved locally: ${pdfLocalPath}`);
                    }
                } catch (localError) {
                    logger.warn('Local DOCX/PDF save failed:', localError.message);
                }
            }
        }

        // Update Firestore with new paths and metadata
        const updatePayload = {
            original_file_path,
            pdf_storage_path: pdfStoragePath,
            pdf_url: pdfUrl,
            page_images: pageImages,
            last_updated_at: new Date().toISOString(),
            status: '解析済み',
            original_filename: filename
        };

        // If we have a pageCount from PDF extraction, save it
        if (pdfData && typeof pdfData === 'object' && pdfData.pageCount > 0) {
            updatePayload.document_meta = { pageCount: pdfData.pageCount };
        }

        await dbService.updateContract(contractId, updatePayload, ownerUid)
            .catch(dbErr => logger.error('Firestore update failed for DOCX upload:', dbErr.message));

        const diffChanges = previousArticles.length
            ? diffService.compare(previousArticles, currentArticles)
            : [];

        let aiResult = {
            changes: diffChanges.map((c) => ({
                section: c.section,
                type: c.type,
                old: c.old,
                new: c.new,
                impact: '',
                concern: ''
            })),
            riskLevel: diffChanges.some((c) => c.type === 'DELETE') ? 2 : 1,
            riskReason: diffChanges.length ? '条文単位の差分を検出しました' : '差分は検出されませんでした',
            summary: diffChanges.length ? `${diffChanges.length}件の差分を検出しました` : '差分は検出されませんでした',
            isFallback: false
        };

        if (!skipAI) {
            const structuredPairAnalysis = previousArticles.length
                ? await buildStructuredPairAnalysis(previousArticles, currentArticles)
                : null;
            const currentText = normalizeContentToText(currentArticles);
            const previousText = normalizeContentToText(previousArticles);

            if (currentText.trim().length > 0) {
                const geminiResult = await geminiService.analyzeContract(currentText, previousText);
                aiResult = structuredPairAnalysis
                    ? mergeStructuredAndGeneralAnalysis(structuredPairAnalysis, geminiResult)
                    : {
                        changes: diffChanges.length ? aiResult.changes : (geminiResult.changes || []),
                        riskLevel: geminiResult.riskLevel,
                        riskReason: geminiResult.riskReason,
                        summary: geminiResult.summary,
                        isFallback: geminiResult.isFallback === true,
                        contract_meta: geminiResult.contract_meta
                    };

                const aiSucceeded = aiResult && aiResult.summary && !isAiFailureSummary(aiResult.summary) && aiResult.isFallback !== true;
                if (aiSucceeded && !localUnlimited) {
                    await dbService.incrementUsage(ownerUid);
                    // Save contract_meta (deadline info) - with ensureContractMeta fallback
                    const meta = await geminiService.ensureContractMeta(currentText, previousText, aiResult.contract_meta);
                    if (meta && contractId) {
                        const metaUpdate = {
                            expiry_date: meta.expiry_date || null,
                            renewal_deadline: meta.renewal_deadline || null,
                            contract_start: meta.contract_start || null,
                            auto_renewal: meta.auto_renewal === true,
                            notice_period_days: Number(meta.notice_period_days) || null,
                            contract_category: meta.contract_category || null,
                            date_confidence: meta.date_confidence || 'unknown',
                            alert_sent_30d: false,
                            alert_sent_7d: false,
                            alert_sent_0d: false
                        };
                        await dbService.updateContract(contractId, metaUpdate, ownerUid);
                        logger.info(`contract_meta saved for DOCX contract ${contractId}: expiry=${meta.expiry_date}`);
                    }
                }
            }
        }

        // 4. Feature Gating
        let gatedChanges = aiResult.changes || [];
        const plan = userProfile.plan || 'free';
        const isFree = plan === 'free';
        const isStarter = plan === 'starter';

        const isLimited = isFree || isStarter || aiResult.isLimited === true;

        res.json({
            success: true,
            data: {
                ...aiResult,
                sourceType: 'DOCX',
                type: 'docx',
                content: extractedRawText,
                extractedText: currentArticles,
                rawExtractedText: extractedRawText,
                structuredContract,
                previousArticles,
                isLimited,
                extractedTextHash,
                extractedTextLength: extractedRawText.length,
                pdfStoragePath,
                pdfUrl,
                original_file_path,
                doc: {
                    content: extractedRawText,
                    type: 'docx',
                    size: extractedRawText.length
                }
            }
        });
    } catch (error) {
        logger.error('DOCX upload error:', error);
        next(error);
    }
});

/**
 * GET /api/contracts/:id/original-file
 * 元のDOCX/PDFファイルをサーブする（認証済みオーナー向け）
 * sign-editor.jsのloadDocx()が呼び出す
 */
router.get('/:id/original-file', async (req, res, next) => {
    try {
        const uid = req.user.uid;
        const email = req.user.email;
        const teamInfo = await dbService.getTeamRole(email, uid);
        const ownerUid = teamInfo.ownerUid;

        const contractId = parseInt(req.params.id, 10);
        if (isNaN(contractId)) {
            return res.status(400).json({ success: false, error: '契約IDが不正です' });
        }

        const contracts = await dbService.getContracts(ownerUid);
        const contract = (Array.isArray(contracts) ? contracts : [])
            .find(c => String(c.id) === String(contractId));
        if (!contract) {
            return res.status(404).json({ success: false, error: '契約が見つかりません' });
        }

        const fs = require('fs');
        const pathMod = require('path');
        const uploadsDir = pathMod.join(__dirname, '../../uploads');

        let resolved = null;
        if (contract.original_file_path) {
            const candidate = pathMod.resolve(contract.original_file_path);
            if (fs.existsSync(candidate)) resolved = candidate;
        }

        // Fallback: search /uploads/ for contract-{id}-*.docx or docx-{id}-*.docx
        if (!resolved && fs.existsSync(uploadsDir)) {
            const prefix1 = `contract-${contractId}-`;
            const prefix2 = `docx-${contractId}-`;
            const files = fs.readdirSync(uploadsDir)
                .filter(f => (f.startsWith(prefix1) || f.startsWith(prefix2)) && /\.(docx?|pdf)$/i.test(f))
                .map(f => ({ f, mtime: fs.statSync(pathMod.join(uploadsDir, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);
            if (files.length > 0) resolved = pathMod.join(uploadsDir, files[0].f);
        }

        if (!resolved) {
            return res.status(404).json({ success: false, error: '原本ファイルが保存されていません' });
        }

        const originalName = contract.original_filename || pathMod.basename(resolved);
        const ext = pathMod.extname(originalName).toLowerCase();
        const contentTypeMap = {
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.doc':  'application/msword',
            '.pdf':  'application/pdf'
        };
        const contentType = contentTypeMap[ext] || 'application/octet-stream';

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(originalName)}`);
        res.setHeader('Cache-Control', 'no-store');
        fs.createReadStream(resolved).pipe(res);
        logger.info(`Served original file for contract ${contractId}: ${resolved}`);
    } catch (error) {
        logger.error('Original file serve error:', error);
        next(error);
    }
});

/**
 * GET /api/contracts/:id/preview-html
 * Word原本をHTMLに変換して返却（原本プレビューのフォールバック用）
 */
router.get('/:id/preview-html', async (req, res, next) => {
    try {
        const uid = req.user.uid;
        const email = req.user.email;
        const teamInfo = await dbService.getTeamRole(email, uid);
        const ownerUid = teamInfo.ownerUid;

        const contractId = parseInt(req.params.id, 10);
        const contracts = await dbService.getContracts(ownerUid);
        const contract = (Array.isArray(contracts) ? contracts : [])
            .find(c => String(c.id) === String(contractId));

        if (!contract) {
            return res.status(404).json({ success: false, error: '契約が見つかりません' });
        }

        let html = '';
        const originalPath = contract.original_file_path || contract.originalFilePath;
        const fs = require('fs');
        const pathMod = require('path');
        const uploadsDir = pathMod.join(__dirname, '../../uploads');

        let localPath = null;
        if (originalPath) {
            localPath = pathMod.isAbsolute(originalPath) ? originalPath : pathMod.resolve(pathMod.join(__dirname, '../..', originalPath));
            if (!fs.existsSync(localPath)) {
                const filename = pathMod.basename(originalPath);
                const candidate = pathMod.join(uploadsDir, filename);
                if (fs.existsSync(candidate)) localPath = candidate;
            }
        }

        if ((!localPath || !fs.existsSync(localPath)) && fs.existsSync(uploadsDir)) {
            const prefix = `original-${contractId}-`;
            const files = fs.readdirSync(uploadsDir)
                .filter(f => f.startsWith(prefix) && f.toLowerCase().endsWith('.docx'))
                .map(f => ({ f, mtime: fs.statSync(pathMod.join(uploadsDir, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);
            if (files.length > 0) localPath = pathMod.join(uploadsDir, files[0].f);
        }

        if (localPath && fs.existsSync(localPath)) {
            const mammoth = require('mammoth');
            const result = await mammoth.convertToHtml({ path: localPath });
            html = result.value;
        } else {
            // DOCXがない場合は、保存されているテキスト（あれば）を表示
            html = contract.original_content
                ? contract.original_content.replace(/\n/g, '<br>')
                : 'プレビューを表示できるDOCXファイルまたはテキストデータが見つかりません。';
        }

        res.json({ success: true, html });
    } catch (error) {
        logger.error('Preview HTML error:', error);
        next(error);
    }
});

/**
 * POST /api/contracts/storage/cleanup
 * 各契約の最新PDF以外のStorageファイルを削除（ストレージ節約）
 */
router.post('/storage/cleanup', async (req, res, next) => {
    try {
        const uid = req.user.uid;
        const email = req.user.email;
        const teamInfo = await dbService.getTeamRole(email, uid);
        const ownerUid = teamInfo.ownerUid;

        const { bucket } = require('../firebase');
        if (!bucket) {
            return res.json({ success: true, message: 'Storage not available', deleted: 0 });
        }

        // contracts/ プレフィックスのファイルを全件取得
        const [allFiles] = await bucket.getFiles({ prefix: 'contracts/' });

        // 現在のユーザーの契約を取得し、有効なpdf_storage_pathを収集
        const contracts = await dbService.getContracts(ownerUid);
        const validPaths = new Set(
            (Array.isArray(contracts) ? contracts : [])
                .map(c => c.pdf_storage_path || c.pdfStoragePath)
                .filter(Boolean)
        );

        // 有効なパスに含まれないファイルを削除
        let deleted = 0;
        for (const file of allFiles) {
            const filePath = file.name;
            // contracts/{contractId}/ パターンのみ対象
            if (!validPaths.has(filePath)) {
                await file.delete().catch(e => logger.warn(`Cleanup delete failed: ${filePath} ${e.message}`));
                deleted++;
                logger.info(`Storage cleanup deleted: ${filePath}`);
            }
        }

        logger.info(`Storage cleanup complete: ${deleted} files deleted`);
        res.json({ success: true, deleted, total: allFiles.length });
    } catch (error) {
        logger.error('Storage cleanup error:', error);
        next(error);
    }
});

/**
 * POST /api/contracts/:id/reanalyze
 * AI を使って 修正案を contract本文の適切な位置に反映する。
 * 入力: { change: {section, type, old, new, impact, concern} }
 * 出力: { new_final_content: string }
 * regex/anchorベースの挿入が失敗 or 精度不足の場合の代替手段。
 */
router.post('/:id/ai-apply-change', rateLimit, async (req, res, next) => {
    try {
        const contractId = parseInt(req.params.id, 10);
        const change = req.body?.change || {};
        if (!change || (!change.old && !change.new)) {
            return res.status(400).json({ error: 'change パラメータが不正です (old/new いずれかが必要)' });
        }
        const dbService = require('../services/db');
        const uid = req.user?.uid;
        if (!uid) return res.status(401).json({ error: 'unauthorized' });
        const contract = await dbService.getContractById(contractId, uid);
        if (!contract) return res.status(404).json({ error: 'contract が見つかりません' });

        const baseText = String(contract.final_content || contract.original_content || '').trim();
        if (!baseText) return res.status(400).json({ error: 'contract本文が空です' });
        if (baseText.length > 60000) return res.status(400).json({ error: 'contractが長すぎます (60K chars超)' });

        const section = String(change.section || '').trim();
        const oldText = String(change.old || '').trim();
        const newText = String(change.new || '').trim();
        const isDeletion = !newText && !!oldText;

        const prompt = `あなたは法務文書編集の専門家です。 以下の契約書に修正案を反映してください。

【契約書全文】
\`\`\`
${baseText}
\`\`\`

【修正案 - 必読】
- 対象条項: ${section || '不明'}  ← この条項のみに反映。他の条項には絶対に手を加えない。
- 修正タイプ: ${isDeletion ? '削除' : (oldText ? '置換 (oldをnewに書き換え)' : '追加')}
- 修正前テキスト (old): ${oldText ? `"""${oldText}"""` : '(なし - 新規追加)'}
- 修正後テキスト (new): ${newText ? `"""${newText}"""` : '(なし - 削除のみ)'}

【絶対厳守ルール - 違反は重大な不適合】
★★ 1. 対象条項の絶対遵守:
   - 修正は「${section || '対象条項'}」 という1つの条項の内部 にのみ行うこと
   - 「${section || '対象条項'}」 以外の条項 (例: 第N条のNが異なる条項) には 一文字も変更を加えないこと
   - 仮に他条項に挿入したほうが適切に見えても、 絶対に他条項には触らない
★★ 2. 配置 - 厳密厳守:
   - 「${section || '対象条項'}」 のヘッダー行直後から始まり、 次の「第N+1条」 が始まる直前で終わる範囲を「対象条項の範囲」 と呼ぶ
   - 修正案 (new) は この対象条項の範囲の 内側 (= 最後の項目の直後、 次条が始まる前) に挿入する
   - **絶対禁止**: contract全体の末尾 (署名欄や末尾の管轄条項の後) に追加すること。 これは商用品質違反として強制的に reject される
   - **絶対禁止**: 対象条項ヘッダー直後への挿入 (= 既存項目より上)。 既存項目の後に追加すること
★★ 3. フォーマット完全保持:
   - 改行、 字下げ (全角空白)、 番号付け (1, 2, 3 / １, ２, ３ / (一)(二)(三)等) を 既存条項と完全一致させる
   - 既存条項が「１ 〜」 で始まっていれば 追加条項も「N+1 〜」 で始める
★★ 4. 他条項の変更禁止:
   - 対象条項以外の text は 1文字も変更しない (改行・空白含む)
★★ 5. 出力形式:
   - 反映後の契約書本文のみを出力
   - 説明文、 コードブロック記号、 前置き、 後置き は 一切含めない
   - もし対象条項が契約書内で見つからない場合のみ 出力末尾に \`\\n\\n[AI_APPLY_FAILED]\` と記載

【最重要】
出力前に確認: 修正は「${section || '対象条項'}」 の内部だけに行ったか? 他条項に1文字でも変更を加えていないか?
yes なら出力、 no なら修正をやり直してから出力。`;

        // generateText は maxOutputTokens=512 で short text 用のため、 contract全文用に
        // 直接 axios で gemini API 呼ぶ (maxOutputTokens 8192)
        const axios = require('axios');
        const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
        if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY 未設定' });
        const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
        let updatedText = '';
        try {
            const apiRes = await axios.post(GEMINI_URL, {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.0, maxOutputTokens: 8192 }
            }, {
                timeout: 120000,
                headers: {
                    'Content-Type': 'application/json',
                    'Referer': 'https://diffsense.spacegleam.co.jp'  // API key の referer制限回避 (既存 requestGeminiJson と同じ)
                }
            });
            updatedText = apiRes?.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        } catch (apiErr) {
            console.error('[ai-apply-change] gemini API error:', apiErr?.response?.status, apiErr?.response?.data?.error?.message || apiErr?.message);
            return res.status(500).json({
                error: 'AI API 呼び出し失敗',
                detail: apiErr?.response?.data?.error?.message || apiErr?.message
            });
        }
        if (!updatedText || typeof updatedText !== 'string') {
            return res.status(500).json({ error: 'AI 応答が不正です (空)' });
        }
        const cleaned = updatedText.replace(/^```[a-z]*\n?|```$/g, '').trim();
        if (cleaned.includes('[AI_APPLY_FAILED]')) {
            return res.status(422).json({ error: '指定位置が見つかりませんでした', detail: cleaned });
        }
        if (cleaned.length < baseText.length * 0.5) {
            return res.status(500).json({ error: 'AI 応答が著しく短い (元の半分未満)、 反映を中断' });
        }
        // 商用品質検証: 対象条項以外が変更されていないかチェック
        // 各条項を「第N条」 で split し、 対象条項以外の各条項の内容が元と一致するか比較
        try {
            const articleHeaderRe = /(?=^[ 　\t]*第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条)/m;
            const splitArticles = (text) => {
                const parts = String(text || '').split(articleHeaderRe);
                const map = {};
                parts.forEach(p => {
                    const m = p.match(/^[ 　\t]*第\s*([0-9０-９零〇一二三四五六七八九十百千]+)\s*条/);
                    if (m) {
                        const key = String(m[1]);
                        map[key] = (map[key] || '') + p; // 同番号は連結
                    }
                });
                return map;
            };
            const before = splitArticles(baseText);
            const after = splitArticles(cleaned);
            const targetNumMatch = String(section || '').match(/第\s*([0-9０-９零〇一二三四五六七八九十百千]+)\s*条/);
            const targetKey = targetNumMatch ? String(targetNumMatch[1]) : null;
            const normalize = (s) => String(s || '').replace(/[\s　]+/g, '');
            const changedKeys = [];
            for (const key of Object.keys(before)) {
                if (key === targetKey) continue; // 対象条項は変更OK
                if (!after[key]) { changedKeys.push(`第${key}条(消失)`); continue; }
                if (normalize(before[key]) !== normalize(after[key])) {
                    changedKeys.push(`第${key}条`);
                }
            }
            if (changedKeys.length > 0) {
                console.warn(`[ai-apply-change] 他条項変更検知、 reject: ${changedKeys.join(', ')}`);
                return res.status(422).json({
                    error: `対象外条項が変更されました: ${changedKeys.join(', ')}。 AI出力を破棄しました。`,
                    detail: '商用品質保証のため、 対象条項以外への影響がある反映は受け付けません。'
                });
            }
            // 追加検証: 新規挿入text (newText) が 対象条項範囲内 に含まれているか確認
            // 末尾追加や別条項挿入 を検出 (前の changedKeys 検証は条項境界 split で末尾追加は通る)
            if (newText && newText.length >= 10 && targetKey) {
                const targetArticleText = String(after[targetKey] || '');
                const normNewText = normalize(newText);
                const normTargetArticle = normalize(targetArticleText);
                if (normTargetArticle.length === 0 || !normTargetArticle.includes(normNewText)) {
                    // 対象条項に挿入されてない → contract末尾追加 or 別条項に紛れた
                    console.warn(`[ai-apply-change] newText が対象条項 ${targetKey} 内にない、 reject`);
                    return res.status(422).json({
                        error: `修正案が対象条項 (第${targetKey}条) の範囲外に挿入されました。 AI出力を破棄しました。`,
                        detail: 'AIが対象条項以外の位置 (contract末尾等) に挿入したため reject しました。'
                    });
                }
            }
        } catch (verifyErr) {
            console.warn('[ai-apply-change] verify failed:', verifyErr?.message);
            // 検証失敗時は通す (= 検証ロジックバグで反映を妨げない)
        }
        return res.json({ new_final_content: cleaned });
    } catch (err) {
        console.error('[ai-apply-change] error:', err);
        return res.status(500).json({ error: 'AI 反映に失敗しました', detail: String(err?.message || err) });
    }
});

/**
 * 既存の契約書テキストを使ってリスク解析＋期限解析を単体実行（差分なし）。
 * 解析1回消費。
 */
router.post('/:id/reanalyze', rateLimit, async (req, res, next) => {
    try {
        const uid = req.user.uid;
        const email = req.user.email;
        const contractId = parseInt(req.params.id, 10);
        if (isNaN(contractId)) {
            return res.status(400).json({ success: false, error: '契約IDが不正です' });
        }

        const teamInfo = await dbService.getTeamRole(email, uid);
        const ownerUid = teamInfo.ownerUid;
        const userProfile = await dbService.getUserProfile(ownerUid);
        const localUnlimited = isLocalUnlimitedMode(req);
        const limit = localUnlimited ? Number.MAX_SAFE_INTEGER : dbService.getUsageLimit(userProfile);

        if (!localUnlimited && userProfile.usageCount >= limit) {
            const plan = userProfile.plan || 'free';
            const nextPlanMap = {
                'free': { name: 'Starter', limit: 50, price: '¥1,480' },
                'trial': { name: 'Starter', limit: 50, price: '¥1,480' },
                'starter': { name: 'Business', limit: 120, price: '¥4,980' },
                'business': { name: 'Pro', limit: 400, price: '¥9,800' },
                'pro': null
            };
            const next = nextPlanMap[plan];
            let suggestion = '来月までお待ちいただくか、プランのアップグレードをご検討ください。';
            if (next) {
                suggestion = `${next.name}プラン（${next.price}/月）にアップグレードすると、月${next.limit}回までAI解析が可能です。`;
            }

            return res.status(403).json({
                success: false,
                code: 'ANALYSIS_LIMIT_EXCEEDED',
                message: `今月のAI差分チェック回数の上限に達しました。\n\n${suggestion}`,
                error: '今月のAI差分チェック回数の上限に達しました',
                currentUsage: userProfile.usageCount,
                limit: limit,
                plan: plan,
                nextPlan: next
            });
        }

        // フロントから本文を受け取る（キャッシュ済みテキスト）
        // 受け取れなかった場合は保存済み本文から復元して解析する。
        const requestText = typeof req.body?.contractText === 'string' ? req.body.contractText.trim() : '';
        let contractText = requestText;

        if (!contractText || contractText.length < 10) {
            const savedContract = await dbService.getContractById(contractId, ownerUid);
            if (savedContract) {
                const textCandidates = [
                    savedContract.original_content,
                    savedContract.current_content,
                    savedContract.extracted_text,
                    savedContract.originalContent,
                    savedContract.currentContent,
                    savedContract.text
                ];
                for (const candidate of textCandidates) {
                    const normalized = normalizeContentToText(candidate).trim();
                    if (normalized.length >= 10) {
                        contractText = normalized;
                        break;
                    }
                }
            }
        }

        if (!contractText || contractText.trim().length < 10) {
            return res.status(400).json({ success: false, error: '解析対象のテキストがありません' });
        }

        // 単体解析（previousVersion = null）
        let aiResult = null;
        const configuredReanalyzeAttempts = Number(process.env.REANALYZE_MAX_ATTEMPTS || 2);
        const maxReanalyzeAttempts = Number.isFinite(configuredReanalyzeAttempts) && configuredReanalyzeAttempts >= 1
            ? Math.min(Math.floor(configuredReanalyzeAttempts), 5)
            : 2;
        const configuredRetryBaseMs = Number(process.env.REANALYZE_RETRY_BASE_MS || 1500);
        const reanalyzeRetryBaseMs = Number.isFinite(configuredRetryBaseMs) && configuredRetryBaseMs >= 0
            ? Math.floor(configuredRetryBaseMs)
            : 1500;
        const configuredRateLimitedRetryBaseMs = Number(process.env.REANALYZE_RATE_LIMIT_RETRY_BASE_MS || 6000);
        const reanalyzeRateLimitedRetryBaseMs = Number.isFinite(configuredRateLimitedRetryBaseMs) && configuredRateLimitedRetryBaseMs >= 0
            ? Math.floor(configuredRateLimitedRetryBaseMs)
            : 6000;
        for (let attempt = 1; attempt <= maxReanalyzeAttempts; attempt++) {
            try {
                aiResult = await geminiService.analyzeContract(contractText, null);
                if (isAiResultReady(aiResult)) break;
                if (attempt < maxReanalyzeAttempts) {
                    logger.warn(`Reanalyze attempt ${attempt} returned fallback, retrying...`);
                    const isRateLimited = aiResult?.errorCode === 'AI_RATE_LIMITED';
                    const waitMs = (isRateLimited ? reanalyzeRateLimitedRetryBaseMs : reanalyzeRetryBaseMs) * attempt;
                    await new Promise(r => setTimeout(r, waitMs));
                }
            } catch (e) {
                logger.warn(`Reanalyze attempt ${attempt} threw: ${e.message}`);
                if (attempt < maxReanalyzeAttempts) {
                    const status = Number(e?.response?.status || 0);
                    const isRateLimited = status === 429;
                    const waitMs = (isRateLimited ? reanalyzeRateLimitedRetryBaseMs : reanalyzeRetryBaseMs) * attempt;
                    await new Promise(r => setTimeout(r, waitMs));
                }
            }
        }

        const aiReady = isAiResultReady(aiResult);
        if (!aiReady) {
            // 解析失敗時でもステータスを確実に更新
            const failedMetaUpdate = {
                ai_succeeded: false,
                last_analyzed_at: new Date().toISOString(),
                ai_failed_at: new Date().toISOString()
            };

            const fallbackMeta = (aiResult && typeof aiResult.contract_meta === 'object')
                ? aiResult.contract_meta
                : null;

            if (hasMeaningfulContractMeta(fallbackMeta)) {
                Object.assign(failedMetaUpdate, {
                    expiry_date: fallbackMeta.expiry_date || null,
                    renewal_deadline: fallbackMeta.renewal_deadline || null,
                    contract_start: fallbackMeta.contract_start || null,
                    auto_renewal: fallbackMeta.auto_renewal === true,
                    notice_period_days: Number(fallbackMeta.notice_period_days) || null,
                    contract_category: fallbackMeta.contract_category || null,
                    date_confidence: fallbackMeta.date_confidence || 'unknown'
                });
            }

            await dbService.updateContract(contractId, failedMetaUpdate, ownerUid);
            logger.info(`Recorded AI failure for contract ${contractId}. meaningfulMeta=${!!fallbackMeta}`);

            return res.json({
                success: true,
                data: {
                    summary: '',
                    riskLevel: 1,
                    riskReason: '',
                    changes: [],
                    isFallback: false,
                    isLimited: false,
                    aiSucceeded: false,
                    aiFailed: true,
                    contract_meta: fallbackMeta,
                    errorCode: aiResult?.errorCode || null,
                    errorMessage: aiResult?.errorMessage || null
                }
            });
        }

        // 解析成功時のみ解析回数を消費
        if (!localUnlimited) {
            await dbService.incrementUsage(ownerUid);
        }

        // contract_meta を Firestore に保存
        const meta = aiResult.contract_meta;
        const metaUpdate = {
            summary: aiResult.summary || null,
            ai_summary: aiResult.summary || null,
            risk_level: aiResult.riskLevel === "3" || aiResult.riskLevel === 3 ? 'High' : (aiResult.riskLevel === "2" || aiResult.riskLevel === 2 ? 'Medium' : 'Low'),
            ai_risk_reason: aiResult.riskReason || null,
            ai_changes: aiResult.changes || [],
            last_analyzed_at: new Date().toISOString(),
            ai_succeeded: aiReady,
            ai_limited: aiResult.isLimited === true,
            ...(meta ? {
                expiry_date: meta.expiry_date || null,
                renewal_deadline: meta.renewal_deadline || null,
                contract_start: meta.contract_start || null,
                auto_renewal: meta.auto_renewal === true,
                notice_period_days: Number(meta.notice_period_days) || null,
                contract_category: meta.contract_category || null,
                date_confidence: meta.date_confidence || 'unknown',
                alert_sent_30d: false,
                alert_sent_7d: false,
                alert_sent_0d: false,
            } : {})
        };
        await dbService.updateContract(contractId, metaUpdate, ownerUid);

        logger.info(`Reanalysis complete for contract ${contractId}, risk=${aiResult.riskLevel}, expiry=${meta?.expiry_date}`);

        const responseMeta = meta || null;

        res.json({
            success: true,
            data: {
                ...aiResult,
                aiSucceeded: aiReady,
                aiFailed: false,
                summary: aiResult.summary,
                riskLevel: aiResult.riskLevel,
                riskReason: aiResult.riskReason,
                changes: aiResult.changes,
                contract_meta: responseMeta,
            }
        });
    } catch (error) {
        logger.error('Reanalyze error:', error);
        next(error);
    }
});

router.post('/analyze-enhanced', rateLimit, async (req, res, next) => {
    try {
        const { contractId, extractedText } = req.body || {};
        if (!extractedText) {
            return res.status(400).json({ success: false, error: 'extractedText is required' });
        }

        const text = typeof extractedText === 'string'
            ? extractedText
            : Array.isArray(extractedText)
                ? extractedText.map(s => `${s?.article || ''} ${s?.title || ''}\n${(s?.paragraphs || []).join('\n')}`).join('\n\n')
                : String(extractedText || '');

        if (!text.trim()) {
            return res.status(400).json({ success: false, error: '契約書テキストが空です' });
        }

        logger.info(`analyze-enhanced: contractId=${contractId}, textLen=${text.length}`);
        const result = await geminiService.analyzeContractEnhanced(text);
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('analyze-enhanced error:', error);
        next(error);
    }
});

/**
 * GET /api/contracts/:id/word-online-url
 * Microsoft Word Online で表示するための短命署名付きURLを生成する
 */
router.get('/:id/word-online-url', async (req, res, next) => {
    try {
        const uid = req.user.uid;
        const email = req.user.email;
        const teamInfo = await dbService.getTeamRole(email, uid);
        const ownerUid = teamInfo.ownerUid;

        const contractId = req.params.id;
        const contract = await dbService.getContractById(contractId, ownerUid);
        if (!contract) {
            return res.status(404).json({ success: false, error: '契約が見つかりません' });
        }

        const filePath = contract.original_file_path || contract.originalFilePath;
        if (!filePath) {
            return res.status(404).json({ success: false, error: '原本ファイルが保存されていません' });
        }

        // GCS以外（ローカル等）の場合は生成不可
        const { bucket } = require('../firebase');
        if (!bucket || filePath.startsWith('http') || filePath.includes('uploads/')) {
            return res.status(400).json({ success: false, error: 'Word Online は Cloud Storage に保存されたファイルのみ対応しています' });
        }

        const file = bucket.file(filePath);
        const [exists] = await file.exists();
        if (!exists) {
            return res.status(404).json({ success: false, error: 'Storage上にファイルが存在しません' });
        }

        // 5分間有効な署名付きURLを生成
        const [signedUrl] = await file.getSignedUrl({
            action: 'read',
            version: 'v4',
            expires: Date.now() + 5 * 60 * 1000 // 5 minutes
        });

        res.json({ success: true, url: signedUrl });
    } catch (error) {
        logger.error('Word Online URL error:', error);
        res.status(500).json({ success: false, error: 'Word Online URLの生成に失敗しました' });
    }
});

/**
 * GET /api/contracts/:id/temp-word-token
 * デスクトップWordで開くための短命トークンURLを発行する。
 * GCSファイル → 署名付きURL、ローカルファイル → tempTokenStore経由のURL
 */
router.get('/:id/temp-word-token', async (req, res, next) => {
    try {
        const uid = req.user.uid;
        const email = req.user.email;
        const teamInfo = await dbService.getTeamRole(email, uid);
        const ownerUid = teamInfo.ownerUid;

        const contractId = parseInt(req.params.id, 10);
        if (isNaN(contractId)) {
            return res.status(400).json({ success: false, error: '契約IDが不正です' });
        }

        const contracts = await dbService.getContracts(ownerUid);
        const contract = (Array.isArray(contracts) ? contracts : [])
            .find(c => String(c.id) === String(contractId));
        if (!contract) {
            return res.status(404).json({ success: false, error: '契約が見つかりません' });
        }

        const filePath = contract.original_file_path || contract.originalFilePath;
        const originalName = contract.original_filename || `contract_${contractId}.docx`;

        // GCS ファイルの場合: 署名付きURLを直接返す
        if (filePath && !filePath.startsWith('/') && !filePath.match(/^[A-Za-z]:[\\\/]/) && !filePath.includes('uploads/')) {
            try {
                const file = bucket.file(filePath);
                const [exists] = await file.exists();
                if (exists) {
                    const [signedUrl] = await file.getSignedUrl({
                        action: 'read',
                        version: 'v4',
                        expires: Date.now() + 5 * 60 * 1000,
                        responseDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(originalName)}`
                    });
                    return res.json({ success: true, type: 'gcs', url: signedUrl });
                }
            } catch (gcsErr) {
                logger.warn('GCS signed URL failed, falling back to local:', gcsErr.message);
            }
        }

        // ローカルファイルの場合: tempTokenを発行
        const uploadsDir = path.join(__dirname, '../../uploads');
        let resolved = null;

        if (filePath) {
            const candidate = path.resolve(filePath);
            if (fs.existsSync(candidate)) resolved = candidate;
        }

        if (!resolved && fs.existsSync(uploadsDir)) {
            const prefix1 = `contract-${contractId}-`;
            const prefix2 = `docx-${contractId}-`;
            const files = fs.readdirSync(uploadsDir)
                .filter(f => (f.startsWith(prefix1) || f.startsWith(prefix2)) && /\.(docx?|pdf)$/i.test(f))
                .map(f => ({ f, mtime: fs.statSync(path.join(uploadsDir, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);
            if (files.length > 0) resolved = path.join(uploadsDir, files[0].f);
        }

        if (!resolved) {
            return res.status(404).json({ success: false, error: '原本ファイルが見つかりません' });
        }

        const { createToken } = require('../services/tempTokenStore');
        const token = createToken(resolved, originalName);
        const host = `${req.protocol}://${req.get('host')}`;
        const url = `${host}/api/download/temp/${token}`;

        return res.json({ success: true, type: 'local', url });
    } catch (error) {
        logger.error('temp-word-token error:', error);
        next(error);
    }
});

/**
 * GET /api/contracts/:id/export
 * 契約書のPDFまたはWord原本をエクスポート（ダウンロード）する。
 * dashboard.js の downloadContract から呼び出される。
 */
router.get('/:id/export', async (req, res, next) => {
    try {
        const uid = req.user.uid;
        const email = req.user.email;
        const teamInfo = await dbService.getTeamRole(email, uid);
        const ownerUid = teamInfo.ownerUid;

        const contractId = req.params.id;
        const contract = await dbService.getContractById(contractId, ownerUid);
        if (!contract) {
            return res.status(404).json({ success: false, error: '契約が見つかりません' });
        }

        const format = (req.query.format || 'pdf').toLowerCase();
        
        // 元の原本ファイルパスまたはPDFパスを特定
        let filePath = null;
        let fileName = contract.original_filename || contract.name || 'contract';
        let contentType = 'application/octet-stream';

        if (format === 'docx') {
            filePath = contract.original_file_path || contract.originalFilePath;
            contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
            if (!fileName.toLowerCase().endsWith('.docx')) fileName += '.docx';
        } else {
            // デフォルトはPDF
            filePath = contract.pdf_storage_path || contract.pdf_url;
            contentType = 'application/pdf';
            if (!fileName.toLowerCase().endsWith('.pdf')) fileName += '.pdf';
        }

        if (!filePath) {
            return res.status(404).json({ success: false, error: 'エクスポート可能なファイルが見つかりません' });
        }

        // ストレージまたはローカルパスからファイルを読み込み
        const fs = require('fs');
        const pathMod = require('path');
        const { bucket } = require('../firebase');

        let buffer = null;
        if (filePath.startsWith('http')) {
            // URLの場合はaxiosで取得
            const axios = require('axios');
            const response = await axios.get(filePath, { responseType: 'arraybuffer' });
            buffer = Buffer.from(response.data);
        } else if (bucket && !pathMod.isAbsolute(filePath) && !filePath.includes('uploads/')) {
            // GCSパスの場合
            const [data] = await bucket.file(filePath).download();
            buffer = data;
        } else {
            // ローカルパスの場合
            let localPath = filePath;
            if (!pathMod.isAbsolute(localPath)) {
                localPath = pathMod.join(__dirname, '../../', localPath);
            }
            if (fs.existsSync(localPath)) {
                buffer = fs.readFileSync(localPath);
            }
        }

        if (!buffer) {
            return res.status(404).json({ success: false, error: 'ファイルの実体が見つかりません' });
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
        res.send(buffer);

    } catch (error) {
        logger.error('Export error:', error);
        res.status(500).json({ success: false, error: 'エクスポートに失敗しました' });
    }
});

/**
 * GET /api/contracts/:id/export-token
 * ms-word: などのプロトコルハンドラで使用するための短命トークンを発行する。
 */
router.get('/:id/export-token', async (req, res, next) => {
    try {
        const uid = req.user.uid;
        const email = req.user.email;
        const contractId = req.params.id;

        const jwt = require('jsonwebtoken');
        const token = jwt.sign(
            { uid, email, contractId, action: 'export' },
            process.env.JWT_SECRET,
            { expiresIn: '5m' }
        );

        res.json({ success: true, token });
    } catch (error) {
        logger.error('Export token error:', error);
        res.status(500).json({ success: false, error: 'トークンの発行に失敗しました' });
    }
});

/**
 * GET /api/contracts/:id/direct-export
 * トークン認証による直接ダウンロード（プロトコルハンドラ用）
 */
router.get('/:id/direct-export', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { token, format } = req.query;

        if (!token) return res.status(401).send('Unauthorized');

        const jwt = require('jsonwebtoken');
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        if (payload.contractId !== id) return res.status(403).send('Forbidden');

        // 通常のエクスポート処理を再利用するために req.user を偽装
        req.user = { uid: payload.uid, email: payload.email };
        // 再帰呼び出しではなく、内部的に export ロジックを実行
        return next(); 
    } catch (error) {
        return res.status(401).send('Invalid token');
    }
}, async (req, res) => {
    // 認証後のエクスポート処理（GET /:id/export と同等）
    try {
        const uid = req.user.uid;
        const email = req.user.email;
        const teamInfo = await dbService.getTeamRole(email, uid);
        const ownerUid = teamInfo.ownerUid;

        const contract = await dbService.getContractById(req.params.id, ownerUid);
        if (!contract) return res.status(404).send('Not Found');

        const format = (req.query.format || 'docx').toLowerCase();
        let filePath = (format === 'docx') ? (contract.original_file_path || contract.originalFilePath) : (contract.pdf_storage_path || contract.pdf_url);
        let fileName = (contract.original_filename || contract.name || 'contract') + (format === 'docx' ? '.docx' : '.pdf');

        const fs = require('fs');
        const pathMod = require('path');
        const { bucket } = require('../firebase');

        let buffer = null;
        if (filePath.startsWith('http')) {
            const axios = require('axios');
            const response = await axios.get(filePath, { responseType: 'arraybuffer' });
            buffer = Buffer.from(response.data);
        } else if (bucket && !pathMod.isAbsolute(filePath) && !filePath.includes('uploads/')) {
            const [data] = await bucket.file(filePath).download();
            buffer = data;
        } else {
            let localPath = filePath;
            if (!pathMod.isAbsolute(localPath)) localPath = pathMod.join(__dirname, '../../', localPath);
            if (fs.existsSync(localPath)) buffer = fs.readFileSync(localPath);
        }

        if (!buffer) return res.status(404).send('File not found');

        res.setHeader('Content-Type', format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
        res.send(buffer);
    } catch (err) {
        res.status(500).send('Internal Server Error');
    }
});

/**
 * GET /api/contracts/:id
 * 単一の契約情報を取得（他の方針を優先するため最後に配置）
 */
router.get('/:id', async (req, res, next) => {
    try {
        const uid = req.user.uid;
        const email = req.user.email;
        const teamInfo = await dbService.getTeamRole(email, uid);
        const ownerUid = teamInfo.ownerUid;

        const { id } = req.params;
        const contract = await dbService.getContractById(id, ownerUid);
        if (!contract) {
            return res.status(404).json({ success: false, error: '契約が見つかりません' });
        }
        res.json({ success: true, data: contract });
    } catch (error) {
        logger.error('GET /contracts/:id error:', error);
        next(error);
    }
});

module.exports = router;
