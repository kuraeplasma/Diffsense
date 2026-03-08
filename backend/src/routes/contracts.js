const express = require('express');
const router = express.Router();
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

function decodeBase64Payload(raw) {
    const base64Clean = String(raw || '').split(',').pop();
    return Buffer.from(base64Clean, 'base64');
}

function buildFirebaseDownloadUrl(bucketName, objectPath, token) {
    const encodedPath = encodeURIComponent(objectPath).replace(/%2F/g, '%2F');
    return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodedPath}?alt=media&token=${token}`;
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
        return await docxService.parseDocx(buffer);
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

        logger.info(`Starting analysis for contract ${contractId} by user ${uid}`, { method });

        // 0. Usage & Plan Limit Check (skip for text-only extraction)
        const userProfile = await dbService.getUserProfile(uid);
        const limit = dbService.getUsageLimit(userProfile);
        const isInTrial = dbService.isTrialActive(userProfile);

        logger.info(`Usage check for ${uid}:`, {
            plan: userProfile.plan,
            usageCount: userProfile.usageCount,
            limit: limit,
            isInTrial: isInTrial,
            skipAI: skipAI,
            trialStartedAt: userProfile.trialStartedAt,
            hasPaymentMethod: userProfile.hasPaymentMethod
        });

        if (!skipAI) {
            // Trial Expiration Check - Only if trial was ever started
            if (userProfile.trialStartedAt && isInTrial === false) {
                // Check if user has registered a payment method for auto-transition
                if (!userProfile.hasPaymentMethod) {
                    logger.warn(`Trial expired and no payment method for user ${uid}`);
                    return res.status(403).json({
                        success: false,
                        error: "無料トライアル期間（7日間）が終了しました。継続して利用するには、お支払い方法（PayPal/クレジットカード）の登録が必要です。",
                        code: "TRIAL_EXPIRED"
                    });
                } else {
                    logger.info(`Trial expired but user ${uid} has payment method. Auto-continuing to paid plan.`);
                }
            }

            if (userProfile.usageCount >= limit) {
                const limitMsg = isInTrial
                    ? `無料トライアルの解析上限（${limit}回）に達しました。継続して利用するにはプランの契約が必要です。`
                    : `プランの月間解析上限（${limit}回）に達しました。アップグレードをご検討ください。`;

                logger.warn(`Usage limit reached for user ${uid}`, { plan: userProfile.plan, current: userProfile.usageCount });
                return res.status(403).json({
                    success: false,
                    error: limitMsg
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
                    logger.warn('Firebase Storage upload failed (analysis will continue):', storageError.message);
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
                        const filename = `contract-${contractId}-${Date.now()}.pdf`;
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
                const docxBuffer = decodeBase64Payload(source);
                extractedText = await docxService.parseDocx(docxBuffer);
                structuredContract = fromLegacyArticleArray(extractedText);
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
                aiResult = await geminiService.analyzeContract(
                    textToAnalyze,
                    previousVersionText
                );

                // 3.1 Increment Usage Count ONLY on successful AI analysis
                const aiSucceeded = aiResult && aiResult.summary && !aiResult.summary.includes('AI解析に失敗');
                if (aiSucceeded) {
                    await dbService.incrementUsage(uid);
                } else {
                    logger.info(`AI analysis failed for user ${uid} - usage count NOT incremented`);
                }
                } else {
                    logger.warn('No text extracted, skipping AI analysis');
                    aiResult.summary = 'テキストを抽出できませんでした（画像ベースの可能性があります）';
                }
            }

        } catch (error) {
            logger.error('Non-fatal analysis error:', error);
            // We don't rethrow, just return what we have (file is saved)
            aiResult.summary = `解析中にエラーが発生しました: ${error.message}`;
            aiResult.riskReason = 'エラーにより解析中断';
        }

        const crypto = require('crypto');
        const textForHash = Array.isArray(extractedText)
            ? JSON.stringify(extractedText)
            : String(extractedText || '');
        const extractedTextHash = crypto.createHash('sha256').update(textForHash).digest('hex');
        const extractedTextLength = textForHash.length;

        logger.info(`Response ready for contract ${contractId}`);

        // 4. Feature Gating (Business+ only for detailed analysis)
        let gatedChanges = aiResult.changes || [];
        if (userProfile.plan === 'starter' && !isInTrial) {
            gatedChanges = gatedChanges.map(c => ({
                ...c,
                impact: "Businessプラン以上で閲覧可能です。",
                concern: "Businessプラン以上で閲覧可能です。"
            }));
        }

        const aiFailed = !aiResult.summary || aiResult.summary.includes('AI解析に失敗') || aiResult.summary.includes('エラーが発生');

        res.json({
            success: true,
            data: {
                extractedText,
                extractedTextHash,
                extractedTextLength,
                sourceType: method.toUpperCase(),
                pdfStoragePath,
                pdfUrl,
                changes: gatedChanges,
                riskLevel: aiResult.riskLevel,
                riskReason: aiResult.riskReason,
                summary: aiResult.summary,
                structuredContract,
                rawExtractedText,
                aiFailed: aiFailed
            }
        });
    } catch (error) {
        logger.error('Analysis error:', error);
        next(error);
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

        if (!Number.isInteger(contractId) || contractId <= 0) {
            return res.status(400).json({ success: false, error: '"contractId" must be a positive integer' });
        }
        if (!source || typeof source !== 'string') {
            return res.status(400).json({ success: false, error: '"source" is required' });
        }

        const userProfile = await dbService.getUserProfile(uid);
        const limit = dbService.getUsageLimit(userProfile);
        const isInTrial = dbService.isTrialActive(userProfile);

        if (!skipAI && userProfile.usageCount >= limit) {
            const limitMsg = isInTrial
                ? `無料トライアルの解析上限（${limit}回）に達しました。継続して利用するにはプランの契約が必要です。`
                : `プランの月間解析上限（${limit}回）に達しました。アップグレードをご検討ください。`;
            return res.status(403).json({ success: false, error: limitMsg });
        }

        const currentBuffer = decodeBase64Payload(source);
        const currentArticles = await docxService.parseDocx(currentBuffer);
        const structuredContract = fromLegacyArticleArray(currentArticles);
        const previousArticles = await resolvePreviousDocxArticles(previousVersion);

        const diffChanges = previousArticles.length
            ? diffService.compare(previousArticles, currentArticles)
            : [];

        let aiResult = {
            changes: diffChanges.map((c) => ({
                section: c.section,
                old: c.old,
                new: c.new,
                impact: '',
                concern: ''
            })),
            riskLevel: diffChanges.some((c) => c.type === 'DELETE') ? 2 : 1,
            riskReason: diffChanges.length ? '条文単位の差分を検出しました' : '差分は検出されませんでした',
            summary: diffChanges.length ? `${diffChanges.length}件の差分を検出しました` : '差分は検出されませんでした'
        };

        if (!skipAI) {
            const currentText = normalizeContentToText(currentArticles);
            const previousText = normalizeContentToText(previousArticles);

            if (currentText.trim().length > 0) {
                const geminiResult = await geminiService.analyzeContract(currentText, previousText);
                const aiSucceeded = geminiResult && geminiResult.summary && !geminiResult.summary.includes('AI解析に失敗');
                if (aiSucceeded) {
                    await dbService.incrementUsage(uid);
                }

                aiResult = {
                    changes: diffChanges.length ? aiResult.changes : (geminiResult.changes || []),
                    riskLevel: geminiResult.riskLevel,
                    riskReason: geminiResult.riskReason,
                    summary: geminiResult.summary
                };
            }
        }

        const crypto = require('crypto');
        const serialized = JSON.stringify(currentArticles);
        const extractedTextHash = crypto.createHash('sha256').update(serialized).digest('hex');

        res.json({
            success: true,
            data: {
                sourceType: 'DOCX',
                extractedText: currentArticles,
                structuredContract,
                previousArticles,
                changes: aiResult.changes || [],
                riskLevel: aiResult.riskLevel,
                riskReason: aiResult.riskReason,
                summary: aiResult.summary,
                extractedTextHash,
                extractedTextLength: serialized.length,
                aiFailed: Boolean(aiResult.summary && aiResult.summary.includes('AI解析に失敗'))
            }
        });
    } catch (error) {
        logger.error('DOCX upload error:', error);
        next(error);
    }
});

module.exports = router;
