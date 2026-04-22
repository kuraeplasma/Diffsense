const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const dbService = require('./db');
const docxService = require('./docxService');
const pdfService = require('./pdf');
const diffService = require('./diffService');
const geminiService = require('./gemini');
const { fromLegacyArticleArray } = require('./contractStructure');
const mammoth = require('mammoth');

/**
 * Extracts text from DOCX buffer using mammoth fallback
 */
async function extractTextFromDocx(buffer) {
    try {
        const result = await mammoth.extractRawText({ buffer });
        return result.value;
    } catch (error) {
        logger.error('Mammoth extraction failed:', error);
        return '';
    }
}

/**
 * Resolves previous version articles
 */
async function resolvePreviousDocxArticles(previousVersion) {
    if (!previousVersion) return [];
    if (Array.isArray(previousVersion)) return previousVersion;
    if (typeof previousVersion === 'string') {
        if (previousVersion.startsWith('data:')) {
            // Base64 file
            const base64 = previousVersion.split(',')[1] || previousVersion;
            const buffer = Buffer.from(base64, 'base64');
            const text = await extractTextFromDocx(buffer);
            return docxService.parseTextToArticles(text);
        }
        return docxService.parseTextToArticles(previousVersion);
    }
    return [];
}

/**
 * Normalize articles to plain text for AI
 */
function normalizeContentToText(articles) {
    if (!Array.isArray(articles)) return String(articles || '');
    return articles.map(a => `${a.articleNumber || a.article || ''} ${a.title || ''}\n${(a.paragraphs || []).join('\n')}`).join('\n\n');
}

/**
 * Check if AI summary indicates failure
 */
function isAiFailureSummary(summary) {
    if (!summary) return true;
    return /AI解析に失敗|解析の準備|テキスト抽出のみ完了|エラーが発生/.test(summary);
}

function readPositiveIntFromEnv(name, fallback) {
    const raw = Number.parseInt(String(process.env[name] || ''), 10);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

async function withTimeout(task, timeoutMs, label) {
    let timerId = null;
    try {
        return await Promise.race([
            task,
            new Promise((_, reject) => {
                timerId = setTimeout(() => reject(new Error(`${label} timeout (${timeoutMs}ms)`)), timeoutMs);
            })
        ]);
    } finally {
        if (timerId) clearTimeout(timerId);
    }
}

/**
 * Merge structured and general analysis
 */
function mergeStructuredAndGeneralAnalysis(structured, general) {
    return {
        ...general,
        changes: structured.changes || general.changes || [],
        riskLevel: general.riskLevel || structured.riskLevel || 1,
        riskReason: general.riskReason || structured.riskReason || '',
        summary: general.summary || structured.summary || ''
    };
}

/**
 * Build structured pair analysis (Placeholder or real logic)
 */
async function buildStructuredPairAnalysis(prev, curr) {
    const diffChanges = diffService.compare(prev, curr);
    return {
        changes: diffChanges.map((c) => ({
            section: c.section,
            type: c.type,
            old: c.old,
            new: c.new,
            impact: '',
            concern: ''
        })),
        riskLevel: diffChanges.some((c) => c.type === 'DELETE') ? 2 : 1,
        summary: `${diffChanges.length}件の差分を検出しました`
    };
}

/**
 * Main background processor
 */
async function processDocxBackground(contractId, currentBuffer, filename, contentType, previousVersion, skipAI, uid) {
    let extractedRawText = '';
    let conversionMethod = 'mammoth';
    const shouldSkipAI = skipAI === 'true' || skipAI === true;
    const mammothMinCharsForFallback = readPositiveIntFromEnv('DOCX_MAMMOTH_MIN_CHARS', 80);
    const geminiTimeoutMs = readPositiveIntFromEnv('DOCX_AI_TIMEOUT_MS', 90000);

    try {
        logger.info(`Starting background DOCX processing for ${contractId} (${filename})`);
        const extractionStartedAt = Date.now();

        // 1. Fast path: mammoth extraction first
        extractedRawText = await extractTextFromDocx(currentBuffer);
        conversionMethod = 'mammoth';

        // 2. Slow fallback: LibreOffice -> PDF extraction only when mammoth text is too short
        const tmpDir = path.join(__dirname, '../../tmp/docx-convert');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        if (String(extractedRawText || '').trim().length < mammothMinCharsForFallback) {
            const docxTmpPath = path.join(tmpDir, `upload-${Date.now()}-${contractId}.docx`);
            fs.writeFileSync(docxTmpPath, currentBuffer);

            try {
                const pdfPath = await docxService.convertToPdf(docxTmpPath);
                if (fs.existsSync(pdfPath)) {
                    const pdfBuffer = fs.readFileSync(pdfPath);
                    const pdfBase64 = `data:application/pdf;base64,${pdfBuffer.toString('base64')}`;
                    const pdfData = await pdfService.extractText(pdfBase64);
                    const pdfText = String(pdfData?.rawText || '').trim();
                    if (pdfText.length > String(extractedRawText || '').trim().length) {
                        extractedRawText = pdfText;
                        conversionMethod = 'libreoffice_pdf';
                    }
                    fs.unlinkSync(pdfPath);
                }
            } catch (convError) {
                logger.warn(`LibreOffice conversion skipped for ${filename}: ${convError.message}`);
            } finally {
                if (fs.existsSync(docxTmpPath)) fs.unlinkSync(docxTmpPath);
            }
        }

        if (!extractedRawText) {
            throw new Error('テキストの抽出に失敗しました。');
        }
        logger.info(`DOCX extraction finished for ${contractId}: method=${conversionMethod}, durationMs=${Date.now() - extractionStartedAt}`);

        const currentArticles = docxService.parseTextToArticles(extractedRawText);
        const structuredContract = fromLegacyArticleArray(currentArticles);
        const previousArticles = await resolvePreviousDocxArticles(previousVersion);

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

        if (!shouldSkipAI) {
            const structuredPairAnalysis = previousArticles.length
                ? await buildStructuredPairAnalysis(previousArticles, currentArticles)
                : null;
            const currentText = normalizeContentToText(currentArticles);
            const previousText = normalizeContentToText(previousArticles);

            if (currentText.trim().length > 0) {
                try {
                    const aiStartedAt = Date.now();
                    const geminiResult = await withTimeout(
                        geminiService.analyzeContract(currentText, previousText),
                        geminiTimeoutMs,
                        'Gemini DOCX analysis'
                    );
                    logger.info(`Gemini DOCX analysis finished for ${contractId}: durationMs=${Date.now() - aiStartedAt}`);
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
                    if (aiSucceeded) {
                        await dbService.incrementUsage(uid);
                    }
                } catch (aiError) {
                    logger.warn(`Gemini analysis timed out/failed for contract ${contractId}; returning diff-only result: ${aiError.message}`);
                }
            }
        }

        // Final Firestore Update
        const updateData = {
            status: 'completed',
            original_content: extractedRawText,
            sections: structuredContract.sections || [],
            summary: aiResult.summary,
            ai_summary: aiResult.summary,
            risk_level: aiResult.riskLevel === 3 || aiResult.riskLevel === '3' ? 'High' : (aiResult.riskLevel === 2 || aiResult.riskLevel === '2' ? 'Medium' : 'Low'),
            ai_risk_reason: aiResult.riskReason,
            ai_changes: aiResult.changes,
            last_analyzed_at: new Date().toISOString(),
            last_updated_at: new Date().toISOString(),
            conversion_method: conversionMethod
        };

        // Deadline info
        if (aiResult.contract_meta) {
            const meta = aiResult.contract_meta;
            Object.assign(updateData, {
                expiry_date: meta.expiry_date || null,
                renewal_deadline: meta.renewal_deadline || null,
                contract_start: meta.contract_start || null,
                auto_renewal: meta.auto_renewal === true,
                notice_period_days: Number(meta.notice_period_days) || null,
                contract_category: meta.contract_category || null
            });
        }

        await dbService.updateContract(contractId, updateData, uid);
        logger.info(`Async DOCX processing completed for contract ${contractId}`);
        return { success: true, data: updateData };

    } catch (error) {
        logger.error(`Async DOCX processing FAILED for contract ${contractId}:`, error);
        await dbService.updateContract(contractId, {
            status: 'error',
            errorMessage: error.message,
            last_updated_at: new Date().toISOString()
        }, uid).catch(e => logger.error('Failed to update error status in Firestore:', e));
        throw error;
    }
}

module.exports = {
    processDocxBackground,
    extractTextFromDocx,
    resolvePreviousDocxArticles
};
