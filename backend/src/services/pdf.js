const logger = require('../utils/logger');
const pdf = require('pdf-parse');

class PDFService {
    async extractText(base64Data) {
        try {
            // Remove data URL prefix if present
            const base64Clean = base64Data.replace(/^data:application\/pdf;base64,/, '');
            const pdfBuffer = Buffer.from(base64Clean, 'base64');

            // File size check
            const maxSize = (parseInt(process.env.MAX_FILE_SIZE_MB) || 50) * 1024 * 1024;
            if (pdfBuffer.length > maxSize) {
                throw new Error(`PDF file size exceeds ${process.env.MAX_FILE_SIZE_MB || 50}MB limit`);
            }

            logger.info(`Extracting text from PDF (${(pdfBuffer.length / 1024).toFixed(2)} KB) using pdf-parse`);

            const data = await pdf(pdfBuffer);
            const fullText = data.text;

            if (!fullText || fullText.trim().length === 0) {
                logger.warn('Extracted text is empty. PDF might be image-based.');
                return "（PDFからテキストを抽出できませんでした。画像ベースのPDFの可能性があります。）";
            }

            logger.info(`Successfully extracted ${fullText.length} characters from ${data.numpages} pages`);
            return fullText.trim();

        } catch (error) {
            logger.error('PDF extraction error:', error);
            throw new Error(`PDF extraction failed: ${error.message}`);
        }
    }
}

module.exports = new PDFService();
