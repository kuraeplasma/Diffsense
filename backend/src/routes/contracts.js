const express = require('express');
const router = express.Router();
const rateLimit = require('../middleware/rateLimit');
const { validateAnalyzeRequest } = require('../utils/validator');
const geminiService = require('../services/gemini');
const pdfService = require('../services/pdf');
const urlService = require('../services/url');
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

        logger.info(`Starting analysis for contract ${contractId}`, { method });

        // 1. Save PDF file early if method is 'pdf'
        let pdfUrl = null;
        let pdfStoragePath = null;
        if (method === 'pdf') {
            const fs = require('fs');
            const path = require('path');
            const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
            if (!fs.existsSync(uploadsDir)) {
                fs.mkdirSync(uploadsDir, { recursive: true });
            }
            const filePath = path.join(uploadsDir, `${contractId}.pdf`);

            const base64Data = source.replace(/^data:application\/pdf;base64,/, '');
            fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));

            pdfUrl = `http://localhost:3001/uploads/${contractId}.pdf`;
            pdfStoragePath = `contracts/uploads/${contractId}/${Date.now()}.pdf`;
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

        res.json({
            success: true,
            data: {
                extractedText,
                extractedTextHash,
                extractedTextLength,
                sourceType: method.toUpperCase(),
                pdfStoragePath,
                pdfUrl,
                changes: aiResult.changes || [],
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
