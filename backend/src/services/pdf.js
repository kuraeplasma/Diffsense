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

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function round1(value) {
    return Math.round(Number(value || 0) * 10) / 10;
}

function isCjkChar(ch) {
    return /[\u3040-\u30ff\u3400-\u9fff]/.test(ch || '');
}

function normalizeChunk(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function shouldInsertSpace(prevText, nextText, gap, fontSize) {
    const prevLast = (prevText || '').slice(-1);
    const nextFirst = (nextText || '').slice(0, 1);
    if (!prevLast || !nextFirst) return false;
    if (gap <= 0.2) return false;

    // Japanese text should not be split by aggressive spaces.
    if (isCjkChar(prevLast) && isCjkChar(nextFirst)) {
        return gap > Math.max(3, fontSize * 1.1);
    }

    return gap > Math.max(1.2, fontSize * 0.45);
}

function normalizeLineText(text) {
    let line = String(text || '');
    line = line.replace(/\s{2,}/g, ' ').trim();
    line = line.replace(/\s+([、。。，．,.;:!?])/g, '$1');
    line = line.replace(/([（(「『【])\s+/g, '$1');
    line = line.replace(/\s+([）」』】])/g, '$1');

    // Recover article headers corrupted by extracted spacing.
    line = line.replace(/^第\s*第?\s*([0-9０-９一二三四五六七八九十百千〇零]+)\s*条\s*条?/, '第$1条');
    line = line.replace(/^第\s+([0-9０-９一二三四五六七八九十百千〇零]+)\s+条/, '第$1条');
    return line.trim();
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

                const seen = new Set();
                const items = (textContent.items || []).map((item) => {
                    const transform = item.transform || [1, 0, 0, 1, 0, 0];
                    const x = Number(transform[4] || 0);
                    const y = Number(transform[5] || 0);
                    const width = Number(item.width || 0);
                    const height = Math.abs(Number(transform[3] || item.height || 0));
                    const text = normalizeChunk(item.str);
                    const dedupeKey = `${round1(x)}|${round1(y)}|${round1(width)}|${text}`;
                    if (!text || seen.has(dedupeKey)) {
                        return null;
                    }
                    seen.add(dedupeKey);
                    return {
                        text,
                        x,
                        y,
                        width,
                        height: height || 10,
                        pageNum
                    };
                }).filter((it) => it && it.text.length > 0);

                items.sort((a, b) => {
                    if (Math.abs(a.y - b.y) > 1) return b.y - a.y;
                    return a.x - b.x;
                });

                const rows = [];
                const itemHeights = items.map((i) => i.height).filter((h) => h > 0);
                const sameLineY = clamp((median(itemHeights) || 10) * 0.35, 1.5, 4);
                for (const item of items) {
                    let row = null;
                    let nearestDelta = Infinity;
                    for (const candidate of rows) {
                        const delta = Math.abs(candidate.y - item.y);
                        if (delta <= sameLineY && delta < nearestDelta) {
                            nearestDelta = delta;
                            row = candidate;
                        }
                    }
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
                    let line = '';
                    let prevRight = null;
                    let prevText = '';
                    for (const token of row.items) {
                        const chunk = token.text;
                        if (!chunk) continue;
                        if (!line) {
                            line = chunk;
                            prevRight = token.x + token.width;
                            prevText = chunk;
                            continue;
                        }

                        const gap = prevRight === null ? 0 : token.x - prevRight;
                        if (shouldInsertSpace(prevText, chunk, gap, row.avgHeight || token.height || 10)) {
                            line += ' ';
                        }
                        line += chunk;
                        prevRight = Math.max(prevRight || 0, token.x + token.width);
                        prevText = chunk;
                    }
                    line = normalizeLineText(line);
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
