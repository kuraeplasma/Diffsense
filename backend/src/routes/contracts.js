const express = require('express');
const router = express.Router();
const rateLimit = require('../middleware/rateLimit');
const { validateAnalyzeRequest } = require('../utils/validator');
const geminiService = require('../services/gemini');
const pdfService = require('../services/pdf');
const urlService = require('../services/url');
const dbService = require('../services/db');
const logger = require('../utils/logger');

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
        const uid = req.user.uid;

        logger.info(`Starting analysis for contract ${contractId} by user ${uid}`, { method });

        // 0. Usage & Plan Limit Check
        const userProfile = await dbService.getUserProfile(uid);
        const limit = dbService.getUsageLimit(userProfile);
        const isInTrial = dbService.isTrialActive(userProfile);

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

        // 1. Save PDF file early if method is 'pdf'
        let pdfUrl = null;
        let pdfStoragePath = null;
        if (method === 'pdf') {
            const { bucket } = require('../firebase');

            // Remove data URL prefix
            const base64Clean = source.replace(/^data:application\/pdf;base64,/, '');
            const buffer = Buffer.from(base64Clean, 'base64');

            // Try to upload to Firebase Storage (optional - analysis continues even if this fails)
            if (bucket) {
                try {
                    pdfStoragePath = `contracts/${contractId}/${Date.now()}.pdf`;
                    const file = bucket.file(pdfStoragePath);

                    await file.save(buffer, {
                        metadata: { contentType: 'application/pdf' }
                    });

                    const [signedUrl] = await file.getSignedUrl({
                        action: 'read',
                        expires: Date.now() + 31536000000
                    });

                    pdfUrl = signedUrl;
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
        let aiResult = {
            changes: [],
            riskLevel: 1,
            riskReason: '解析待ち',
            summary: '解析の準備ができました'
        };

        try {
            // 2. Extract text
            if (method === 'pdf') {
                extractedText = await pdfService.extractText(source);
            } else if (method === 'url') {
                extractedText = await urlService.extractText(source);
            } else if (method === 'text') {
                extractedText = source;
            }

            // 3. Analyze with Gemini AI
            if (extractedText && extractedText.trim().length > 0) {
                aiResult = await geminiService.analyzeContract(
                    extractedText,
                    previousVersion
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

        } catch (error) {
            logger.error('Non-fatal analysis error:', error);
            // We don't rethrow, just return what we have (file is saved)
            aiResult.summary = `解析中にエラーが発生しました: ${error.message}`;
            aiResult.riskReason = 'エラーにより解析中断';
        }

        const crypto = require('crypto');
        const extractedTextHash = crypto.createHash('sha256').update(extractedText || '').digest('hex');
        const extractedTextLength = (extractedText || '').length;

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
                aiFailed: aiFailed
            }
        });
    } catch (error) {
        logger.error('Analysis error:', error);
        next(error);
    }
});

module.exports = router;
