const AdmZip = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');
const logger = require('../utils/logger');

class DocxService {
    constructor() {
        this.parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: "@_",
            preserveOrder: true
        });
    }

    /**
     * Parse a .docx buffer into a structured article-based format
     * @param {Buffer} buffer 
     * @returns {Promise<Array>} List of articles/paragraphs/tables
     */
    async parseDocx(buffer) {
        try {
            const zip = new AdmZip(buffer);
            const contentXml = zip.readAsText('word/document.xml');

            if (!contentXml) {
                throw new Error('Invalid docx: word/document.xml not found');
            }

            const jsonObj = this.parser.parse(contentXml);
            // XML構造差異に強くするため、再帰で body ノードを探索する
            const body = this._extractBodyNode(jsonObj);
            if (!Array.isArray(body)) {
                throw new Error('Invalid docx: document body not found');
            }

            return this._processBody(body);
        } catch (error) {
            logger.error('Error parsing docx:', error);
            throw error;
        }
    }

    /**
     * Recursively find Word body node from fast-xml-parser output.
     * Supports namespace variants and shape differences in preserveOrder mode.
     */
    _extractBodyNode(node) {
        if (!node) return null;

        if (Array.isArray(node)) {
            for (const item of node) {
                const found = this._extractBodyNode(item);
                if (found) return found;
            }
            return null;
        }

        if (typeof node !== 'object') return null;

        for (const [key, value] of Object.entries(node)) {
            if (key === 'w:body' || key.endsWith(':body')) {
                return Array.isArray(value) ? value : [value];
            }
            const found = this._extractBodyNode(value);
            if (found) return found;
        }

        return null;
    }

    /**
     * Helper to find a tag in ordered fast-xml-parser output
     */
    _findInOrdered(arr, tagName) {
        if (!Array.isArray(arr)) return [];
        return arr.filter(item => item[tagName]);
    }

    /**
     * Process the body elements into structured blocks
     */
    _processBody(body) {
        const blocks = [];

        for (const element of body) {
            if (element['w:p']) {
                // Paragraph
                const paragraphNode = element['w:p'];
                const text = this._extractTextFromParagraph(paragraphNode);
                const paragraphStyle = this._extractParagraphStyle(paragraphNode);

                // Skip Word TOC/control heading paragraphs to avoid misplaced
                // "第n条 ..." lists at the beginning of extracted content.
                if (this._isTocParagraph(paragraphStyle, text)) {
                    continue;
                }
                // 空行も構造として保持（ただしトリミングが必要な場合もある）
                if (text.trim() || text.includes('\n')) {
                    blocks.push(this._categorizeParagraph(text));
                } else if (text === "") {
                    // Blank line
                    blocks.push({ type: 'blank_line', full_text: '\n' });
                }
            } else if (element['w:tbl']) {
                // Table
                const tableData = this._extractTableData(element['w:tbl']);
                blocks.push({
                    type: 'table',
                    data: tableData,
                    raw: '[Table]'
                });
            }
        }

        return this._regroupByArticle(blocks);
    }

    _extractParagraphStyle(p) {
        if (!Array.isArray(p)) return '';
        for (const part of p) {
            if (!part || !part['w:pPr'] || !Array.isArray(part['w:pPr'])) continue;
            for (const prop of part['w:pPr']) {
                if (!prop) continue;
                const styleNode = prop['w:pStyle'] || prop['pStyle'] || null;
                if (!styleNode) continue;
                const styleArr = Array.isArray(styleNode) ? styleNode : [styleNode];
                for (const styleItem of styleArr) {
                    if (!styleItem || typeof styleItem !== 'object') continue;
                    const val = styleItem['@_w:val'] || styleItem['@_val'] || styleItem['#text'] || '';
                    if (val) return String(val).trim();
                }
            }
        }
        return '';
    }

    _isTocParagraph(style, text) {
        const styleName = String(style || '').trim();
        const line = String(text || '').trim();
        if (!line) return false;

        if (/^TOC\d*$/i.test(styleName) || /^ContentsHeading$/i.test(styleName)) {
            return true;
        }

        // Fallback heuristic for explicit TOC heading line.
        if (/^(目次|TABLE OF CONTENTS)$/i.test(line)) {
            return true;
        }

        return false;
    }

    /**
     * Extract plain text from paragraph element, handling tracked changes
     */
    _extractTextFromParagraph(p) {
        let text = "";

        const traverse = (elements) => {
            if (!Array.isArray(elements)) return;

            for (const el of elements) {
                if (el['w:t']) {
                    // Actual text
                    const t = el['w:t'];
                    if (Array.isArray(t)) {
                        text += t.map(item => item['#text'] || '').join('');
                    } else if (typeof t === 'object') {
                        text += t['#text'] || '';
                    } else {
                        text += t;
                    }
                } else if (el['w:r']) {
                    traverse(el['w:r']);
                } else if (el['w:tab']) {
                    text += "  "; // Tab as double space
                } else if (el['w:br'] || el['w:cr']) {
                    text += "\n";
                } else if (el['w:ins']) {
                    // Tracked insertion: Keep content
                    traverse(el['w:ins']);
                } else if (el['w:hyperlink']) {
                    // TOC and normal hyperlink text are stored here.
                    // Keep text unless the paragraph itself is filtered as TOC.
                    traverse(el['w:hyperlink']);
                }
            }
        };

        traverse(p);
        return this._normalizeExtractedLine(text);
    }

    _normalizeExtractedLine(text) {
        const normalized = String(text || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/[ \t]{2,}/g, ' ')
            .trim();

        if (!normalized) return '';

        // Collapse exact doubled lines such as "利用規約利用規約".
        const exactDouble = normalized.match(/^(.{2,120}?)\1$/u);
        if (exactDouble) {
            return exactDouble[1].trim();
        }

        return normalized;
    }

    /**
     * Extract table structure
     */
    _extractTableData(tbl) {
        const rows = [];
        const trs = this._findInOrdered(tbl, 'w:tr');

        for (const tr of trs) {
            const cells = [];
            const tcs = this._findInOrdered(tr['w:tr'], 'w:tc');

            for (const tc of tcs) {
                // A cell contains paragraphs
                const cellText = tc['w:tc']
                    .filter(item => item['w:p'])
                    .map(p => this._extractTextFromParagraph(p['w:p']))
                    .join('\n');
                cells.push(cellText);
            }
            rows.push(cells);
        }
        return rows;
    }

    /**
     * Detect article number and title from paragraph text
     */
    _categorizeParagraph(text) {
        // Pattern: 第1条, 第１条, 第一条, 【第1条】 などに対応
        const articleMatch = text.match(/^(?:第\s*([\d０-９一二三四五六七八九十百]+)\s*条|【\s*第\s*([\d０-９一二三四五六七八九十百]+)\s*条\s*】)[\s　]*(?:\s*|\(|（|【)?([^）\(\s】]+)?(?:\)|）|】)?(.*)/);

        if (articleMatch) {
            const numStr = articleMatch[1] || articleMatch[2];
            return {
                type: 'article_header',
                clause_number: `第${numStr}条`,
                article_number: this._parseJapaneseNumber(numStr),
                title: articleMatch[3] || '',
                content: articleMatch[4] ? articleMatch[4].trim() : '',
                full_text: text
            };
        }

        // List item detection (1. or ① or ● or -)
        const listMatch = text.match(/^([\d０-９\u2460-\u2473\u2474-\u2487\u2488-\u249b\u249c-\u24af\u25cf\u25cb\u25a0\u25a1\-\・])\s*(.*)/);
        if (listMatch) {
            return {
                type: 'list_item',
                marker: listMatch[1],
                body: listMatch[2],
                full_text: text
            };
        }

        // Check for indentation (leading spaces)
        if (text.startsWith(' ') || text.startsWith('　')) {
            return {
                type: 'indented_paragraph',
                body: text.trim(),
                full_text: text
            };
        }

        return {
            type: 'paragraph',
            body: text,
            full_text: text
        };
    }

    _parseJapaneseNumber(str) {
        if (!str) return 0;
        // Simple conversion for common cases
        const kanji = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
        if (kanji[str]) return kanji[str];
        return parseInt(str.replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))) || 0;
    }

    /**
     * Group fragments into complete Article objects
     */
    _regroupByArticle(blocks) {
        const articles = [];
        let currentArticle = null;

        const startNewArticle = (headerBlock = null) => {
            if (currentArticle) articles.push(currentArticle);
            currentArticle = {
                clause_number: headerBlock ? headerBlock.clause_number : '',
                title: headerBlock ? headerBlock.title : (articles.length === 0 ? '前文/ヘッダー' : ''),
                article_number: headerBlock ? headerBlock.article_number : (articles.length === 0 ? 0 : articles.length + 1),
                paragraphs: headerBlock && headerBlock.content ? [headerBlock.content] : [],
                full_text: headerBlock ? headerBlock.full_text : '',
                blocks: headerBlock ? [headerBlock] : []
            };
        };

        for (const block of blocks) {
            if (block.type === 'article_header') {
                startNewArticle(block);
            } else {
                if (!currentArticle) startNewArticle();

                if (block.type === 'blank_line') {
                    currentArticle.paragraphs.push('');
                } else if (block.type === 'table') {
                    currentArticle.paragraphs.push('[Table]');
                } else {
                    currentArticle.paragraphs.push(block.body || block.full_text);
                }
                currentArticle.blocks.push(block);
                currentArticle.full_text = (currentArticle.full_text || '') + '\n' + (block.full_text || '');
            }
        }

        if (currentArticle) articles.push(currentArticle);

        // Finalize as structured objects
        return articles.map(a => ({
            article: a.clause_number,
            title: a.title,
            article_number: a.article_number,
            paragraphs: a.paragraphs.filter(p => p !== null), // Filter out nulls if any
            full_text: a.full_text
        }));
    }

    /**
     * Parse raw text into the same article format for comparison
     * Use this when we only have previous version as text
     */
    parseTextToArticles(text) {
        if (!text) return [];
        // If already structured (array), return as is
        if (Array.isArray(text)) return text;

        const lines = text.split(/\r?\n/);
        const blocks = lines
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => this._categorizeParagraph(line));

        return this._regroupByArticle(blocks);
    }
}

module.exports = new DocxService();
