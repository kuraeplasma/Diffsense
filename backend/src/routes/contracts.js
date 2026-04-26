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

    const analysisResult = await geminiService.analyzeStructuredDiff(diffChanges);
    const analysis = analysisResult.data;
    if (analysisResult.success === false || analysis?.isFallback === true) {
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
    logger.info('API /analyze request received');
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
                } else {
                    extractedText = pdfResult;
                }
            } else if (method === 'docx') {
                const docxBuffer = Buffer.from(source, 'base64');
                rawExtractedText = await extractTextFromDocx(docxBuffer);
                extractedText = docxService.parseTextToArticles(rawExtractedText);
                structuredContract = fromLegacyArticleArray(extractedText);
            } else if (method === 'url') {
                extractedText = await urlService.extractText(source);
            } else if (method === 'text') {
                extractedText = source;
            }

            // 3. Analyze with Gemini AI
            if (skipAI) {
                logger.info('skipAI=true: Skipping Gemini analysis, text extraction only');
                aiResult = {
                    changes: [],
                    riskLevel: 1,
                    riskReason: 'AI解析スキップ',
                    summary: 'テキスト抽出のみ完了（AI解析はスキップ）',
                    isFallback: false
                };
            } else {
                const textToAnalyze = normalizeContentToText(extractedText);
                const previousVersionArticles = previousVersion ? await resolvePreviousDocxArticles(previousVersion) : null;
                const previousVersionText = previousVersionArticles ? normalizeContentToText(previousVersionArticles) : null;

                if (textToAnalyze.trim().length > 0) {
                    const structuredPairAnalysis = previousVersionArticles
                        ? await buildStructuredPairAnalysis(
                            normalizeContentToLegacyArticles(previousVersionArticles),
                            normalizeContentToLegacyArticles(extractedText)
                        )
                        : null;

                    const shouldRunGenericAnalysis = !structuredPairAnalysis || !hasStructuredChanges(structuredPairAnalysis);
                    const genericAnalysisResult = shouldRunGenericAnalysis
                        ? await geminiService.analyzeContract(
                            textToAnalyze,
                            previousVersionText
                        )
                        : null;
                    const genericAnalysis = genericAnalysisResult ? genericAnalysisResult.data : null;

                    if (hasStructuredChanges(structuredPairAnalysis)) {
                        aiResult = mergeStructuredAndGeneralAnalysis(structuredPairAnalysis, genericAnalysis);
                    } else if (genericAnalysis) {
                        aiResult = genericAnalysis;
                    } else if (structuredPairAnalysis) {
                        aiResult = structuredPairAnalysis;
                    } else {
                        const directAnalysisResult = await geminiService.analyzeContract(
                            textToAnalyze,
                            previousVersionText
                        );
                        aiResult = directAnalysisResult.data;
                    }

                    // 3.1 Increment Usage Count ONLY on successful AI analysis
                    const aiSucceeded = aiResult && aiResult.summary && !isAiFailureSummary(aiResult.summary) && aiResult.isFallback !== true;
                    if (aiSucceeded && !localUnlimited) {
                        await dbService.incrementUsage(ownerUid);
                        // 3.2 Save contract_meta (deadline info) if extracted
                        const meta = aiResult.contract_meta;
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
                        }
                    }
                }
            }
        } catch (error) {
            logger.error('Non-fatal analysis error:', error);
            aiResult.summary = '解析中にエラーが発生しました: ' + error.message;
            aiResult.isFallback = true;
        }

        const textForHash = (extractedText && typeof extractedText === 'object') ? JSON.stringify(extractedText) : String(extractedText || '');
        const extractedTextHash = crypto.createHash('sha256').update(textForHash).digest('hex');
        
        const resultData = {
            ...aiResult,
            extractedText,
            extractedTextHash,
            extractedTextLength: textForHash.length,
            sourceType: method.toUpperCase(),
            pdfStoragePath,
            pdfUrl,
            isLimited: (userProfile.plan === 'free' || userProfile.plan === 'starter' || aiResult.isLimited === true),
            structuredContract,
            rawExtractedText
        };

        return res.json({
            success: true,
            data: resultData
        });
    } catch (error) {
        logger.error('Critical analysis error:', error);
        return res.json({
            success: false,
            error: error.message || '解析失敗',
            data: null
        });
    }
});

/**
 * POST /api/contracts/upload-docx
 * Parse DOCX and compare by article blocks
 */
router.post('/upload-docx', rateLimit, async (req, res, next) => {
    logger.info('API /upload-docx request received');
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

        // MIMEタイプ検証: DOCXはZIP形式（magic bytes: PK\x03\x04）
        if (!currentBuffer || currentBuffer.length < 4 ||
            currentBuffer[0] !== 0x50 || currentBuffer[1] !== 0x4B ||
            currentBuffer[2] !== 0x03 || currentBuffer[3] !== 0x04) {
            return res.status(400).json({ success: false, error: '無効なファイル形式です。Word文書（.docx）をアップロードしてください。' });
        }

        let extractedRawText = '';
        let conversionMethod = 'mammoth';
        const filename = req.body.filename || 'unknown';

        try {
            // 1. まずはLibreOfficeでのPDF変換を試みる（原本性が高いため）
            const os = require('os');
            const tmpDir = path.join(os.tmpdir(), 'docx-convert');
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
            
            const docxTmpPath = path.join(tmpDir, `upload-${Date.now()}.docx`);
            fs.writeFileSync(docxTmpPath, currentBuffer);
            
            let pdfBuffer = null;
            try {
                const pdfPath = await docxService.convertToPdf(docxTmpPath);
                if (fs.existsSync(pdfPath)) {
                    pdfBuffer = fs.readFileSync(pdfPath);
                    const pdfData = await pdfService.extractText(pdfBuffer.toString('base64'));
                    extractedRawText = pdfData.rawText || pdfData.text || '';
                    conversionMethod = 'libreoffice_pdf';
                    logger.info(`DOCX conversion success via LibreOffice: ${filename}`);
                    
                    // Cleanup
                    fs.unlinkSync(pdfPath);
                }
            } catch (convError) {
                logger.warn(`LibreOffice conversion failed for ${filename}, falling back to mammoth:`, convError.message);
                // Fallback to mammoth
                const mammothResult = await mammoth.extractRawText({ buffer: currentBuffer });
                extractedRawText = mammothResult.value;
                conversionMethod = 'mammoth';
            } finally {
                if (fs.existsSync(docxTmpPath)) {
                    try {
                        fs.unlinkSync(docxTmpPath);
                    } catch (e) {
                        logger.warn('Failed to cleanup tmp docx:', e.message);
                    }
                }
            }
        } catch (extractError) {
            logger.warn('Initial DOCX setup failed, trying direct mammoth fallback:', extractError.message);
            try {
                const mammothResult = await mammoth.extractRawText({ buffer: currentBuffer });
                extractedRawText = mammothResult.value;
                conversionMethod = 'mammoth';
            } catch (mammothError) {
                logger.error('DOCX_EXTRACT_ALL_FAILED', mammothError);
                return res.status(500).json({ 
                    success: false, 
                    error: 'DOCX_CONVERT_FAILED',
                    detail: mammothError.message
                });
            }
        }

        const currentArticles = docxService.parseTextToArticles(extractedRawText);
        const structuredContract = fromLegacyArticleArray(currentArticles);
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
                if (conversionMethod === 'libreoffice_pdf' && typeof pdfBuffer !== 'undefined') {
                    pdfStoragePath = `contracts/${contractId}/${Date.now()}.pdf`;
                    const pdfFile = bucket.file(pdfStoragePath);
                    const downloadToken = crypto.randomBytes(16).toString('hex');
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
        }

        // Update Firestore with new paths
        await dbService.updateContract(contractId, {
            original_file_path,
            pdf_storage_path: pdfStoragePath,
            pdf_url: pdfUrl,
            last_updated_at: new Date().toISOString(),
            status: '解析済み',
            original_filename: filename
        }, ownerUid).catch(dbErr => logger.error('Firestore update failed for DOCX upload:', dbErr.message));

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
                const geminiResultRaw = await geminiService.analyzeContract(currentText, previousText);
                const geminiResult = geminiResultRaw.data;
                aiResult = structuredPairAnalysis
                    ? mergeStructuredAndGeneralAnalysis(structuredPairAnalysis, geminiResult)
                    : {
                        changes: diffChanges.length ? aiResult.changes : (geminiResult.changes || []),
                        riskLevel: geminiResult.riskLevel,
                        riskReason: geminiResult.riskReason,
                        summary: geminiResult.summary,
                        isFallback: geminiResult.isFallback === true
                    };

                const aiSucceeded = aiResult && aiResult.summary && !isAiFailureSummary(aiResult.summary) && aiResult.isFallback !== true;
                if (aiSucceeded && !localUnlimited) {
                    await dbService.incrementUsage(ownerUid);
                    // Save contract_meta (deadline info) if extracted
                    const meta = aiResult.contract_meta;
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

        let aiResult = null;
        const configuredReanalyzeAttempts = Number(process.env.REANALYZE_MAX_ATTEMPTS || 2);
        const maxReanalyzeAttempts = Math.min(Math.max(Math.floor(configuredReanalyzeAttempts), 1), 5);
        const configuredRetryBaseMs = Number(process.env.REANALYZE_RETRY_BASE_MS || 1500);
        const reanalyzeRetryBaseMs = Math.max(Math.floor(configuredRetryBaseMs), 0);
        const configuredRateLimitedRetryBaseMs = Number(process.env.REANALYZE_RATE_LIMIT_RETRY_BASE_MS || 6000);
        const reanalyzeRateLimitedRetryBaseMs = Math.max(Math.floor(configuredRateLimitedRetryBaseMs), 0);

        for (let attempt = 1; attempt <= maxReanalyzeAttempts; attempt++) {
            try {
                const serviceResponse = await geminiService.analyzeContract(contractText, null);
                aiResult = serviceResponse.data;
                if (isAiResultReady(aiResult)) break;
                
                if (attempt < maxReanalyzeAttempts) {
                    logger.warn(`Reanalyze attempt ${attempt} returned fallback, retrying...`);
                    const isRateLimited = serviceResponse?.errorCode === 'AI_RATE_LIMITED';
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
            const failedMetaUpdate = {
                ai_succeeded: false,
                last_analyzed_at: new Date().toISOString(),
                ai_failed_at: new Date().toISOString()
            };

            const fallbackMeta = (aiResult && typeof aiResult.contract_meta === 'object') ? aiResult.contract_meta : null;

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

        if (!localUnlimited) {
            await dbService.incrementUsage(ownerUid);
        }

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
                contract_meta: meta || null,
            }
        });
    } catch (error) {
    } catch (error) {
        logger.error('Reanalyze error:', error);
        next(error);
    }
});

module.exports = router;
