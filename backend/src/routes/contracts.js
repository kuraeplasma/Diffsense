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
            const trialStart = new Date(userProfile.trialStartedAt);
            const now = new Date();
            if (now - trialStart > 7 * 24 * 60 * 60 * 1000) {
                // For this prototype, if trial is over and no "subscription" (simulated), block access.
                // In production, we'd check userProfile.plan and if they've paid.
                logger.warn(`Trial expired for user ${uid}`);
                return res.status(403).json({
                    success: false,
                    error: "無料トライアル期間（7日間）が終了しました。継続して利用するにはプランの契約が必要です。"
                });
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
            const admin = require('firebase-admin'); // Assuming firebase-admin is initialized elsewhere

            // Check if Firebase Storage is available (Production or correctly configured Dev)
            // We use a simple check: if we are in production OR if we have credentials
            const isProduction = process.env.NODE_ENV === 'production';
            const hasFirebaseCredentials = process.env.FIREBASE_PRIVATE_KEY || (admin.apps.length > 0 && admin.app().options.credential);
            const useFirebase = isProduction || hasFirebaseCredentials;

            // Remove data URL prefix
            const base64Clean = source.replace(/^data:application\/pdf;base64,/, '');
            const buffer = Buffer.from(base64Clean, 'base64');

            if (useFirebase) {
                // Production / Firebase Mode
                try {
                    // Storage path: contracts/{contractId}/{timestamp}.pdf
                    pdfStoragePath = `contracts/${contractId}/${Date.now()}.pdf`;
                    const file = bucket.file(pdfStoragePath);

                    // Upload to Firebase Storage
                    await file.save(buffer, {
                        metadata: { contentType: 'application/pdf' }
                    });

                    // Generate Signed URL (valid for 1 year)
                    const [signedUrl] = await file.getSignedUrl({
                        action: 'read',
                        expires: Date.now() + 31536000000 // 1 year
                    });

                    pdfUrl = signedUrl;
                    logger.info(`PDF uploaded to Firebase Storage: ${pdfStoragePath}`);
                } catch (firebaseError) {
                    // If Firebase fails in dev, fall back to local (renaming variable to avoid conflict)
                    if (!isProduction) {
                        logger.warn('Firebase upload failed in dev, falling back to local storage:', firebaseError.message);
                        await saveLocally();
                    } else {
                        throw firebaseError;
                    }
                }
            } else {
                // Development / Local Mode (No credentials)
                await saveLocally();
            }

            // Helper function for local save
            async function saveLocally() {
                const fs = require('fs');
                const path = require('path');

                // Local storage path: backend/uploads/contract-{id}-{timestamp}.pdf
                const filename = `contract-${contractId}-${Date.now()}.pdf`;
                const uploadsDir = path.join(__dirname, '../../uploads');

                if (!fs.existsSync(uploadsDir)) {
                    fs.mkdirSync(uploadsDir, { recursive: true });
                }

                pdfStoragePath = path.join(uploadsDir, filename);

                // Write to local file
                await fs.promises.writeFile(pdfStoragePath, buffer);

                // Construct URL
                // In dev, we use the backend port
                // Construct URL
                // In dev, we use the backend port. In prod (even if NODE_ENV is dev), we need HTTPS.
                const protocol = (req.get('host').includes('run.app') || process.env.NODE_ENV === 'production') ? 'https' : req.protocol;
                const baseUrl = `${protocol}://${req.get('host')}`;

                pdfUrl = `${baseUrl}/uploads/${filename}`;

                logger.info(`PDF saved locally (Dev/Fallback): ${pdfStoragePath}`);
                logger.info(`PDF URL: ${pdfUrl}`);
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

                // 3.1 Increment Usage Count on SUCCESS
                await dbService.incrementUsage(uid);
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
                summary: aiResult.summary
            }
        });
    } catch (error) {
        logger.error('Analysis error:', error);
        next(error);
    }
});

module.exports = router;
