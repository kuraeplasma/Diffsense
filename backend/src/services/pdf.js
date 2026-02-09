const logger = require('../utils/logger');

class PDFService {
    async extractText(base64Data) {
        try {
            // Dynamic import for ESM module
            // Note: pdfjs-dist v4+ is ESM only, so we must use import() in CommonJS
            const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

            // Disable worker for Node.js environment
            // In Node.js with this version, we don't need to set workerSrc or can set it to null/undefined if needed
            // But usually just leaving it alone works for basic text extraction

            // Remove data URL prefix if present
            const base64Clean = base64Data.replace(/^data:application\/pdf;base64,/, '');
            const pdfBuffer = Buffer.from(base64Clean, 'base64');
            const uint8Array = new Uint8Array(pdfBuffer);

            // File size check
            const maxSize = (parseInt(process.env.MAX_FILE_SIZE_MB) || 50) * 1024 * 1024;
            if (pdfBuffer.length > maxSize) {
                throw new Error(`PDF file size exceeds ${process.env.MAX_FILE_SIZE_MB || 50}MB limit`);
            }

            logger.info(`Extracting text from PDF (${(pdfBuffer.length / 1024).toFixed(2)} KB) using pdfjs-dist`);

            // Load PDF document
            const loadingTask = getDocument({
                data: uint8Array,
                useSystemFonts: true,
                disableFontFace: true,
                verbosity: 0
            });
            const doc = await loadingTask.promise;

            let fullText = '';
            const numPages = doc.numPages;

            // Iterate through all pages
            for (let i = 1; i <= numPages; i++) {
                const page = await doc.getPage(i);
                const textContent = await page.getTextContent();

                let lastY = -1;
                let pageText = '';

                for (const item of textContent.items) {
                    if (!item.str || item.str.trim() === '') continue;

                    // Font height estimation (scaleY is at index 3 of transform matrix)
                    const fontHeight = (item.transform && item.transform[3]) ? Math.abs(item.transform[3]) : 10;
                    const currentY = item.transform ? item.transform[5] : -1;

                    // If Y changes significantly, start a new line
                    // Note: PDF coordinates usually start from bottom, so Y decreases as we go down
                    if (lastY !== -1 && currentY !== -1 && Math.abs(currentY - lastY) > fontHeight * 0.5) {
                        pageText += '\n';
                    }

                    pageText += item.str;
                    lastY = currentY;
                }

                fullText += pageText.trim() + '\n\n';
            }

            if (!fullText || fullText.trim().length === 0) {
                logger.warn('Extracted text is empty. PDF might be image-based.');
                return "（PDFからテキストを抽出できませんでした。画像ベースのPDFの可能性があります。）";
            }

            logger.info(`Successfully extracted ${fullText.length} characters from ${numPages} pages`);
            return fullText.trim();

        } catch (error) {
            logger.error('PDF extraction error:', error);
            throw new Error(`PDF extraction failed: ${error.message}`);
        }
    }
}

module.exports = new PDFService();
