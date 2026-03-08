const logger = require('../utils/logger');
const { buildStructuredContract, toLegacyArticleArray } = require('./contractStructure');

let pdfjsModulePromise = null;

async function getPdfJs() {
    if (!pdfjsModulePromise) {
        pdfjsModulePromise = import('pdfjs-dist/legacy/build/pdf.mjs');
    }
    return pdfjsModulePromise;
}

function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

class PDFService {
    async extractText(base64Data) {
        try {
            const base64Clean = base64Data.split(',').pop();
            const pdfBuffer = Buffer.from(base64Clean, 'base64');

            const maxSize = (parseInt(process.env.MAX_FILE_SIZE_MB) || 50) * 1024 * 1024;
            if (pdfBuffer.length > maxSize) {
                throw new Error(`PDF file size exceeds ${process.env.MAX_FILE_SIZE_MB || 50}MB limit`);
            }

            logger.info(`Extracting structured text from PDF (${(pdfBuffer.length / 1024).toFixed(2)} KB) using pdf.js`);
            const pdfjs = await getPdfJs();
            const loadingTask = pdfjs.getDocument({ data: new Uint8Array(pdfBuffer) });
            const pdfDocument = await loadingTask.promise;

            const allLines = [];
            for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
                const page = await pdfDocument.getPage(pageNum);
                const viewport = page.getViewport({ scale: 1.0 });
                const textContent = await page.getTextContent();

                const items = (textContent.items || []).map((item) => {
                    const transform = item.transform || [1, 0, 0, 1, 0, 0];
                    const x = Number(transform[4] || 0);
                    const y = Number(transform[5] || 0);
                    const width = Number(item.width || 0);
                    const height = Math.abs(Number(transform[3] || item.height || 0));
                    return {
                        text: String(item.str || ''),
                        x,
                        y,
                        width,
                        height: height || 10,
                        pageNum
                    };
                }).filter((it) => it.text.trim().length > 0);

                items.sort((a, b) => {
                    if (Math.abs(a.y - b.y) > 1) return b.y - a.y;
                    return a.x - b.x;
                });

                const rows = [];
                const sameLineY = 3;
                for (const item of items) {
                    const row = rows.find((r) => Math.abs(r.y - item.y) < sameLineY);
                    if (!row) {
                        rows.push({
                            y: item.y,
                            items: [item],
                            avgHeight: item.height,
                            pageNum
                        });
                        continue;
                    }
                    row.items.push(item);
                    row.avgHeight = (row.avgHeight + item.height) / 2;
                }

                rows.sort((a, b) => b.y - a.y);
                for (const row of rows) {
                    row.items.sort((a, b) => a.x - b.x);
                    const line = row.items.map((r) => r.text).join(' ').replace(/\s{2,}/g, ' ').trim();
                    if (!line) continue;
                    const minX = row.items[0].x;
                    const maxX = row.items[row.items.length - 1].x + row.items[row.items.length - 1].width;
                    const lineCenter = (minX + maxX) / 2;
                    const centered = Math.abs(lineCenter - viewport.width / 2) < viewport.width * 0.15;
                    allLines.push({
                        text: line,
                        y: row.y,
                        xStart: minX,
                        xEnd: maxX,
                        height: row.avgHeight,
                        centered,
                        pageNum
                    });
                }
            }

            if (!allLines.length) {
                logger.warn('Extracted text is empty. PDF might be image-based.');
                return {
                    structuredContract: {
                        title: '',
                        version: '',
                        preamble: '（PDFからテキストを抽出できませんでした。画像ベースのPDFの可能性があります。）',
                        articles: []
                    },
                    articles: []
                };
            }

            allLines.sort((a, b) => {
                if (a.pageNum !== b.pageNum) return a.pageNum - b.pageNum;
                return b.y - a.y;
            });

            const heights = allLines.map((l) => l.height).filter((h) => h > 0);
            const medianHeight = median(heights) || 10;
            const headCandidates = allLines.slice(0, Math.min(8, allLines.length));
            const titleLine = headCandidates.find((l) => l.height > medianHeight * 1.25 || (l.centered && l.text.length >= 6));
            const versionLine = headCandidates.find((l) => /(?:ver(?:sion)?\.?\s*)?v?\d+(?:\.\d+)+/i.test(l.text));

            const paragraphs = [];
            let current = '';
            let prev = null;
            const lineGapThreshold = Math.max(8, medianHeight * 1.5);
            for (const line of allLines) {
                if (!prev) {
                    current = line.text;
                    prev = line;
                    continue;
                }
                const isNewPage = line.pageNum !== prev.pageNum;
                const lineGap = isNewPage ? 999 : Math.abs(prev.y - line.y);
                const isArticleHeader = /^第\s*[0-9０-９一二三四五六七八九十百千〇零]+\s*条/.test(line.text);
                if (isNewPage || lineGap > lineGapThreshold || isArticleHeader) {
                    if (current.trim()) paragraphs.push(current.trim());
                    current = line.text;
                } else {
                    current += `\n${line.text}`;
                }
                prev = line;
            }
            if (current.trim()) paragraphs.push(current.trim());

            const structuredContract = buildStructuredContract(paragraphs, {
                title: titleLine ? titleLine.text : '',
                version: versionLine ? versionLine.text : ''
            });
            const articles = toLegacyArticleArray(structuredContract);

            logger.info(`Successfully extracted ${paragraphs.length} paragraphs from ${pdfDocument.numPages} pages`);
            return { structuredContract, articles };

        } catch (error) {
            logger.error('PDF extraction error:', error);
            throw new Error(`PDF extraction failed: ${error.message}`);
        }
    }
}

module.exports = new PDFService();
