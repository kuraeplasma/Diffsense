const logger = require('../utils/logger');
const docxService = require('./docxService');
const contractRuleEngine = require('./contractRuleEngine');
const { buildStructuredContract, toLegacyArticleArray, fromLegacyArticleArray } = require('./contractStructure');

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
    // LOSSLESS: Do NOT collapse multiple spaces as they might be used for alignment
    // line = line.replace(/\s{2,}/g, ' ').trim(); 
    
    // Minimal cleanup for punctuation that often gets weird gaps in PDF extraction
    line = line.replace(/\s+([、。。，．,.;:!?])/g, '$1');
    line = line.replace(/([（(「『【])\s+/g, '$1');
    line = line.replace(/\s+([）」』】])/g, '$1');

    // Recover article headers corrupted by extracted spacing.
    line = line.replace(/^第\s*第?\s*([0-9０-９一二三四五六七八九十百千〇零]+)\s*条\s*条?/, '第$1条');
    line = line.replace(/^第\s+([0-9０-９一二三四五六七八九十百千〇零]+)\s+条/, '第$1条');

    return line.trim();
}

const ARTICLE_HEADER_TOKEN_REGEX = /第\s*[0-9０-９一二三四五六七八九十百千〇零]+\s*条(?=(?:\s|$|[（(【]))/g;

function normalizeArticleHeaderLead(text) {
    let line = String(text || '').trim();
    line = line.replace(/^第\s*第?\s*([0-9０-９一二三四五六七八九十百千〇零]+)\s*条\s*条?/, '第$1条');
    line = line.replace(/^第\s+([0-9０-９一二三四五六七八九十百千〇零]+)\s+条/, '第$1条');
    return line;
}

function isArticleHeaderLine(text) {
    return /^第\s*[0-9０-９一二三四五六七八九十百千〇零]+\s*条(?:\s|$|[（(【])/.test(
        normalizeArticleHeaderLead(text)
    );
}

function splitParagraphByInlineArticleHeaders(text) {
    const line = String(text || '').trim();
    if (!line) return [];

    const rawMatches = [...line.matchAll(ARTICLE_HEADER_TOKEN_REGEX)];
    if (rawMatches.length === 0) return [line];

    const matches = rawMatches.filter((match) => {
        const idx = Number(match.index || 0);
        if (idx === 0) return true;
        const prev = line[idx - 1] || '';
        return /[\s　。．!！?？\n\r]/.test(prev);
    });

    const shouldSplit = matches.length > 1 || matches.some((match) => Number(match.index || 0) > 0);
    if (!shouldSplit) return [line];

    const parts = [];
    for (let i = 0; i < matches.length; i++) {
        const start = Number(matches[i].index || 0);
        const end = i + 1 < matches.length ? Number(matches[i + 1].index || line.length) : line.length;

        if (start > 0 && i === 0) {
            const head = line.slice(0, start).trim();
            if (head) parts.push(head);
        }

        const body = line.slice(start, end).trim();
        if (body) parts.push(body);
    }

    return parts.length > 0 ? parts : [line];
}

function buildSyntheticClauseArticles(paragraphs) {
    const cleanParagraphs = (paragraphs || [])
        .map((line) => String(line || '').trim())
        .filter(Boolean);
    if (cleanParagraphs.length === 0) return [];

    const groups = [];
    let bucket = [];
    let bucketWeight = 0;

    for (const paragraph of cleanParagraphs) {
        const weight = Math.max(1, Math.ceil(paragraph.length / 180));
        const shouldSplit = bucket.length >= 4 || (bucketWeight + weight > 6 && bucket.length > 0);
        if (shouldSplit) {
            groups.push(bucket);
            bucket = [];
            bucketWeight = 0;
        }
        bucket.push(paragraph);
        bucketWeight += weight;
    }

    if (bucket.length > 0) {
        groups.push(bucket);
    }

    return groups.map((lines, index) => ({
        articleNumber: `第${index + 1}条`,
        title: '',
        content: lines.join('\n').trim()
    }));
}

function shouldKeepSoftLineBreak(prevLine, nextLine) {
    const prev = String(prevLine || '').trim();
    const next = String(nextLine || '').trim();
    if (!prev || !next) return true;
    
    // Article headers are always standalone, e.g. "第1条"
    if (/^第\s*[0-9０-９一二三四五六七八九十百千〇零]+\s*条/.test(prev)) return true;
    
    // Explicit sentence endings in Japanese or English
    if (/[。．！？!?]$/.test(prev)) return true;
    
    // Clear list-like prefixes at the start of the next line
    // e.g. "1.", "（1）", "・", "●"
    if (/^([0-9０-９]+[\.．\)]|[・●○■□\-]|（[0-9０-９a-zA-Z]+）|\([0-9０-９a-zA-Z]+\))/.test(next)) return true;
    
    // If the previous line ends in a bracket or closing quote, it might be a heading or the end of a block
    if (/[）)】」』]$/.test(prev) && prev.length <= 40) return true;
    // Otherwise, assume it's a soft wrap if it was a continuation of text
    return false;
}

function areSameToken(a, b) {
    if (!a || !b) return false;
    if (a.text !== b.text) return false;
    const yClose = Math.abs(a.y - b.y) <= 1.8;
    const xClose = Math.abs(a.x - b.x) <= 1.8;
    const widthClose = Math.abs((a.width || 0) - (b.width || 0)) <= 3.2;
    return yClose && xClose && widthClose;
}

function dedupeRowItems(items) {
    const deduped = [];
    for (const token of items) {
        // Remove same-token overlays emitted multiple times by some PDF generators.
        const duplicate = deduped.some((kept) => {
            if (areSameToken(kept, token)) return true;
            if (kept.text !== token.text) return false;
            if (Math.abs(kept.y - token.y) > 2.4) return false;
            const keptStart = kept.x;
            const keptEnd = kept.x + kept.width;
            const tokStart = token.x;
            const tokEnd = token.x + token.width;
            const overlap = Math.max(0, Math.min(keptEnd, tokEnd) - Math.max(keptStart, tokStart));
            const minWidth = Math.max(1, Math.min(kept.width || 0, token.width || 0));
            // Treat strongly-overlapped identical text as duplicate even if x/y is slightly shifted.
            return overlap / minWidth >= 0.55;
        });
        if (!duplicate) deduped.push(token);
    }
    return deduped;
}

function collapseLineDuplicates(text) {
    let line = String(text || '');
    // LOSSLESS: DISABLED. This was too aggressive and removed intentional repeats.
    // line = line.replace(/([\u3040-\u30ff\u3400-\u9fffA-Za-z0-9]{2,24})\1+/g, '$1');
    return line;
}

function normalizeParagraphBreaks(paragraphs) {
    const out = [];
    const articleHeaderPattern = /^第\s*[0-9０-９一二三四五六七八九十百千〇零]+\s*条(?:\s+.*)?$/;
    const articleHeaderLikePattern = /^第\s*[0-9０-９一二三四五六七八九十百千〇零]+\s*条(?:[\s　]*[（(【]?[^。．！？!?、,:：]{0,24}[）)】]?)?$/;
    const shortTailPattern = /^[\u3040-\u30ff\u3400-\u9fffA-Za-z0-9]{1,6}$/;
    const definitionLinePattern = /^[^\s　]{1,20}[：:]/;

    for (const raw of (paragraphs || [])) {
        const line = String(raw || '').trim();
        if (!line) continue;
        if (!out.length) {
            out.push(line);
            continue;
        }

        const prev = out[out.length - 1];
        const canMergeToHeader = articleHeaderPattern.test(prev) && shortTailPattern.test(line);
        const isSoftWrapped =
            !articleHeaderLikePattern.test(prev) &&
            !/[。．！？!?]$/.test(prev) &&
            !definitionLinePattern.test(line) &&
            /[\u3040-\u30ff\u3400-\u9fffA-Za-z0-9）)】]$/.test(prev) &&
            !/^([0-9０-９]+[\.．\)]|[・●○■□\-]|第\s*[0-9０-９一二三四五六七八九十百千〇零]+\s*条)/.test(line);

        if (canMergeToHeader || isSoftWrapped) {
            out[out.length - 1] = `${prev}${line}`;
        } else {
            out.push(line);
        }
    }

    return out;
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
                // Slightly wider tolerance to prevent one logical line from being split.
                const sameLineY = clamp((median(itemHeights) || 10) * 0.42, 2, 6);
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
                let prevRowY = null;
                for (const row of rows) {
                    // LOSSLESS: Detect vertical gaps and insert blank lines if distance is significant
                    if (prevRowY !== null) {
                        const gap = prevRowY - row.y;
                        const rowHeight = row.avgHeight || 10;
                        if (gap > rowHeight * 1.8) {
                            allLines.push({
                                text: '', // Blank line
                                y: row.y + (gap / 2),
                                xStart: 0,
                                xEnd: 0,
                                height: 0,
                                centered: false,
                                pageNum
                            });
                        }
                    }
                    prevRowY = row.y;

                    row.items.sort((a, b) => a.x - b.x);
                    row.items = dedupeRowItems(row.items);
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
                        // Some PDFs emit duplicated adjacent tokens with tiny x-shift.
                        if (prevText === chunk && gap <= Math.max(4, (row.avgHeight || token.height || 10) * 0.9)) {
                            prevRight = Math.max(prevRight || 0, token.x + token.width);
                            continue;
                        }
                        if (shouldInsertSpace(prevText, chunk, gap, row.avgHeight || token.height || 10)) {
                            line += ' ';
                        }
                        line += chunk;
                        prevRight = Math.max(prevRight || 0, token.x + token.width);
                        prevText = chunk;
                    }
                    line = normalizeLineText(collapseLineDuplicates(line));
                    // LOSSLESS: Keep blank lines (after normalization, if it becomes empty but wasn't before, we still might want it)
                    // if (!line) continue;
                    
                    const minX = row.items[0] ? row.items[0].x : 0;
                    const maxX = row.items[0] ? row.items[row.items.length - 1].x + row.items[row.items.length - 1].width : 0;
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
                    articles: [],
                    rawText: ''
                };
            }

            allLines.sort((a, b) => {
                if (a.pageNum !== b.pageNum) return a.pageNum - b.pageNum;
                return b.y - a.y;
            });
            // STEP 1: Rule-based extraction using the new ContractRuleEngine
            // This replaces the unstable coordinate-based paragraph grouping.
            const rawText = allLines.map((l) => l.text).join('\n').trim();

            const heights = allLines.map((l) => l.height).filter((h) => h > 0);
            const medianHeight = median(heights) || 10;
            const headCandidates = allLines.slice(0, Math.min(8, allLines.length));
            const titleLine = headCandidates.find((l) => l.height > medianHeight * 1.25 || (l.centered && l.text.length >= 6));
            const versionLine = headCandidates.find((l) => /(?:ver(?:sion)?\.?\s*)?v?\d+(?:\.\d+)+/i.test(l.text));

            const ruleBlocks = contractRuleEngine.parse(rawText);
            const legacyArticles = contractRuleEngine.toLegacyFormat(ruleBlocks);

            // Maintain title and version detection from PDF metadata/coordinates
            const structuredContract = {
                title: titleLine ? titleLine.text : '',
                version: versionLine ? versionLine.text : '',
                preamble: legacyArticles.find(a => a.article === '前文')?.full_text || '',
                articles: legacyArticles.filter(a => a.article !== '前文').map(a => ({
                    articleNumber: a.article,
                    title: a.title,
                    content: a.paragraphs.join('\n')
                }))
            };

            const articles = toLegacyArticleArray(structuredContract);

            logger.info(`Successfully extracted ${articles.length} articles from ${pdfDocument.numPages} pages`);
            return {
                structuredContract,
                articles,
                rawText,
                pageCount: pdfDocument.numPages
            };

        } catch (error) {
            logger.error('PDF extraction error:', error);
            throw new Error(`PDF extraction failed: ${error.message}`);
        }
    }
}

module.exports = new PDFService();
