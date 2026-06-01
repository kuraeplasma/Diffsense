const AdmZip = require('adm-zip');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const execFileAsync = promisify(execFile);
const os = require('os');
const logger = require('../utils/logger');
const contractRuleEngine = require('./contractRuleEngine');

// LibreOffice runs as a single global instance per machine on Windows. Launching
// multiple `soffice --convert-to` processes at once collides during init and fails
// with exit!=0 / no PDF and a GUI "bootstrap.ini is corrupted" dialog (even though
// the install is fine). Serialize all PDF conversions so only ONE soffice process
// ever runs at a time; concurrent requests queue instead of colliding.
let __pdfConvertQueue = Promise.resolve();

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
                    text += " ";
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
        // LOSSLESS: Do NOT collapse spaces or remove doubled lines that might be intentional
        const normalized = String(text || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+\n/g, '\n');
            // .replace(/[ \t]{2,}/g, ' '); // Removed

        return normalized.trimEnd();
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

    _isShortTitleCandidate(text) {
        const line = String(text || '').trim();
        if (!line) return false;
        if (line.length > 20) return false;
        if (line.includes('。')) return false;
        return true;
    }

    _extractBracketedTitlePrefix(text) {
        const line = String(text || '').trim();
        const match = line.match(/^([（(【][^）)】]{1,20}[）)】])\s*(.*)$/);
        if (!match) return null;
        const title = String(match[1] || '').trim();
        if (!this._isShortTitleCandidate(title)) return null;
        return {
            title,
            rest: String(match[2] || '').trim()
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
     * Group fragments into complete Article objects.
     * Aligned with ContractRuleEngine logic for stability.
     */
    _regroupByArticle(blocks) {
        const articles = [];
        let currentArticle = null;

        // CLAUSE_REGEX same as rule engine
        const CLAUSE_REGEX = /^第\s*([0-9０-９一二三四五六七八九十百]+)\s*条(.*)/;
        const TITLE_BRACKET_REGEX = /^\s*[（(【]([^）)】]+)[）)】]\s*$/;

        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            const text = (block.body || block.full_text || '').trim();

            if (block.type === 'article_header' || (block.type === 'paragraph' && text.match(CLAUSE_REGEX))) {
                const match = text.match(CLAUSE_REGEX);
                const clauseNumber = match ? `第${match[1]}条` : (block.clause_number || '');
                let title = match ? match[2].trim() : (block.title || '');
                
                // OCR/Word robustness: Merge next line if it's a bracketed title
                if (!title && i + 1 < blocks.length) {
                    const nextText = (blocks[i+1].body || blocks[i+1].full_text || '').trim();
                    const titleMatch = nextText.match(TITLE_BRACKET_REGEX);
                    if (titleMatch) {
                        title = titleMatch[1];
                        i++; // Consume next block
                    }
                } else if (title) {
                    const inlineMatch = title.match(TITLE_BRACKET_REGEX);
                    if (inlineMatch) title = inlineMatch[1];
                }

                currentArticle = {
                    article: clauseNumber,
                    title: title,
                    article_number: this._parseJapaneseNumber(clauseNumber.match(/[0-9０-９一二三四五六七八九十百]+/)?.[0] || ''),
                    paragraphs: [],
                    full_text: text
                };
                articles.push(currentArticle);
                continue;
            }

            if (!currentArticle) {
                // Preamble
                currentArticle = {
                    article: '前文',
                    title: '前文',
                    article_number: 0,
                    paragraphs: [],
                    full_text: ''
                };
                articles.push(currentArticle);
            }

            if (block.type === 'blank_line') {
                currentArticle.paragraphs.push('');
            } else if (block.type === 'table') {
                // Flatten table for text-based analysis compatibility
                if (Array.isArray(block.data)) {
                    block.data.forEach(row => {
                        currentArticle.paragraphs.push(row.join(' | '));
                    });
                } else {
                    currentArticle.paragraphs.push('[Table]');
                }
            } else {
                // Use block.full_text to preserve the list markers and indentation,
                // but do not trim leading spaces (only trimEnd to clean up trailing whitespace/newlines).
                const val = (block.full_text !== undefined) ? block.full_text.trimEnd() : text;
                currentArticle.paragraphs.push(val);
            }
        }

        return articles;
    }

    /**
     * Parse raw text into the same article format for comparison.
     * Uses the core RuleEngine for maximum stability.
     */
    parseTextToArticles(text) {
        if (!text) return [];
        if (Array.isArray(text)) return text;

        const blocks = contractRuleEngine.parse(text);
        return contractRuleEngine.toLegacyFormat(blocks);
    }

    _escapeXmlText(value) {
        return String(value || '')
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    _validateWordDocumentXml(xml) {
        const source = String(xml || '');
        if (!source.trim()) throw new Error('Invalid docx: word/document.xml is empty');

        const validation = XMLValidator.validate(source);
        if (validation !== true) {
            const message = validation?.err
                ? `${validation.err.msg} at line ${validation.err.line}, column ${validation.err.col}`
                : 'word/document.xml is not well-formed XML';
            throw new Error(`Invalid generated docx: ${message}`);
        }

        const parsed = this.parser.parse(source);
        const body = this._extractBodyNode(parsed);
        if (!Array.isArray(body)) {
            throw new Error('Invalid generated docx: document body not found');
        }
    }

    _validateDocxPackage(buffer) {
        const zip = new AdmZip(buffer);
        if (!zip.getEntry('[Content_Types].xml')) {
            throw new Error('Invalid generated docx: [Content_Types].xml not found');
        }
        const entry = zip.getEntry('word/document.xml');
        if (!entry) {
            throw new Error('Invalid generated docx: word/document.xml not found');
        }
        this._validateWordDocumentXml(entry.getData().toString('utf8'));
    }

    _stripXmlTags(xml) {
        return String(xml || '')
            .replace(/<w:tab\/?>/g, ' ')
            .replace(/<w:br\/?>/g, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _normalizeDocxSearchText(value) {
        return String(value || '')
            .replace(/[\s　]+/g, '')
            .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    }

    // 参照段落から文字書式（フォント・サイズ等）の <w:rPr> を抽出する。
    // 先頭ランの rPr → 段落マークの rPr の順で探し、無ければ空文字を返す。
    _extractRunProperties(referenceParagraphXml = '') {
        const xml = String(referenceParagraphXml || '');
        const firstRun = xml.match(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/);
        if (firstRun) {
            const rPr = firstRun[0].match(/<w:rPr[\s\S]*?<\/w:rPr>/);
            if (rPr) return rPr[0];
        }
        const pPr = xml.match(/<w:pPr[\s\S]*?<\/w:pPr>/);
        if (pPr) {
            const rPr = pPr[0].match(/<w:rPr[\s\S]*?<\/w:rPr>/);
            if (rPr) return rPr[0];
        }
        return '';
    }

    // 参照段落の段落書式(<w:pPr>)と文字書式(<w:rPr>)を継承して段落XMLを生成する。
    // 既定インデント/行間は注入せず、原文の書式になじませる。
    _buildParagraphsWithReferenceFormatting(text, referenceParagraphXml = '') {
        const pPrMatch = String(referenceParagraphXml || '').match(/<w:pPr[\s\S]*?<\/w:pPr>/);
        const pPr = pPrMatch ? pPrMatch[0] : '';
        const rPr = this._extractRunProperties(referenceParagraphXml);
        return String(text || '')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => '<w:p>' + pPr + '<w:r>' + rPr + '<w:t xml:space="preserve">' + this._escapeXmlText(line) + '</w:t></w:r></w:p>')
            .join('');
    }

    _buildInsertedParagraphXml(text, referenceParagraphXml = '') {
        return this._buildParagraphsWithReferenceFormatting(text, referenceParagraphXml);
    }

    _buildReplacementParagraphXml(text, referenceParagraphXml = '') {
        return this._buildParagraphsWithReferenceFormatting(text, referenceParagraphXml);
    }

    applyRevisionsToDocx(buffer, revisions = []) {
        const zip = new AdmZip(buffer);
        const entry = zip.getEntry('word/document.xml');
        if (!entry) throw new Error('Invalid docx: word/document.xml not found');

        let xml = entry.getData().toString('utf8');
        const normalize = value => this._normalizeDocxSearchText(value);
        const articlePattern = /第\s*[0-9０-９一二三四五六七八九十百千〇零]+\s*条/;
        const normalizedRevisions = (Array.isArray(revisions) ? revisions : [])
            .map(revision => {
                const rawAnchor = String(revision.anchor || revision.section || revision.article || '').trim();
                const rawText = String(revision.text || revision.newText || '').trim();
                const articleMatch = rawAnchor.match(articlePattern) || rawText.match(articlePattern);
                return {
                    anchor: normalize(rawAnchor),
                    articleAnchor: normalize(articleMatch ? articleMatch[0] : ''),
                    text: rawText,
                    oldText: String(revision.oldText || revision.old || '').trim(),
                    normalizedOldText: normalize(revision.oldText || revision.old || ''),
                    type: String(revision.type || '').toLowerCase()
                };
            })
            .filter(revision => revision.text);

        const isInsertionBoundary = text => {
            const value = String(text || '').trim();
            if (!value) return false;
            if (articlePattern.test(value)) return true;
            if (/^（[^）]{1,30}）$/.test(value)) return true;
            if (/^(以上|貸主|借主|甲|乙|連帯保証人|立会人|印)$/.test(value)) return true;
            return false;
        };

        // 後文(結語「以上の通り…」)・署名欄の日付など、条見出しではないが
        // 「本文の終わり」を示す段落。追加条項がこの後ろへ流れ込むのを防ぐための境界。
        // どんな契約書でも末尾(後文・署名押印欄)より前に追加条項が入るようにする。
        const isClosingBoundary = text => {
            const value = String(text || '').trim();
            if (!value) return false;
            if (/^以上/.test(value)) return true;
            if (/(本書|本契約書|本契約).{0,16}[0-9０-９一二三四五六七八九十]+\s*通/.test(value)) return true;
            if (/(記名|署名)\s*(押印|捺印)/.test(value)) return true;
            if (/(各自|各)\s*[0-9０-９一二三四五六七八九十]+\s*通.{0,16}(所持|保有|有する)/.test(value)) return true;
            if (/(令和|平成|昭和|西暦)[\s　○◯0-9０-９元]*年[\s　○◯0-9０-９]*月[\s　○◯0-9０-９]*日/.test(value) && value.length <= 24) return true;
            if (/^[0-9０-９○◯]{1,4}\s*年[\s　]*[0-9０-９○◯]{1,2}\s*月[\s　]*[0-9０-９○◯]{1,2}\s*日/.test(value)) return true;
            return false;
        };

        const findStartIndex = (paragraphs, revision) => {
            if (revision.articleAnchor) {
                const byArticle = paragraphs.findIndex(p => p.normalized.includes(revision.articleAnchor));
                if (byArticle >= 0) return byArticle;
            }
            if (revision.anchor) {
                const exact = paragraphs.findIndex(p => p.normalized.includes(revision.anchor));
                if (exact >= 0) return exact;
                const partial = paragraphs.findIndex(p => p.normalized && revision.anchor.includes(p.normalized) && p.normalized.length >= 3);
                if (partial >= 0) return partial;
            }
            return -1;
        };

        let insertedCount = 0;
        const skipped = [];

        for (const revision of normalizedRevisions) {
            const paragraphs = [...xml.matchAll(/<w:p[\s\S]*?<\/w:p>/g)].map(match => ({
                xml: match[0],
                index: match.index,
                end: match.index + match[0].length,
                text: this._stripXmlTags(match[0]),
                normalized: normalize(this._stripXmlTags(match[0]))
            }));
            if (!paragraphs.length) {
                skipped.push({ anchor: revision.anchor, reason: 'no_paragraphs' });
                continue;
            }

            const startIndex = findStartIndex(paragraphs, revision);
            if (startIndex < 0) {
                skipped.push({ anchor: revision.anchor, articleAnchor: revision.articleAnchor, reason: 'anchor_not_found' });
                continue;
            }

            if (revision.normalizedOldText) {
                // 対象条項のスコープ末尾（次の見出し直前）を求め、条項をまたいだ置換を防ぐ
                let scopeEnd = paragraphs.length;
                for (let i = startIndex + 1; i < paragraphs.length; i++) {
                    if (isInsertionBoundary(paragraphs[i].text)) { scopeEnd = i; break; }
                }
                const replaceIndex = paragraphs.findIndex((p, i) =>
                    i >= startIndex && i < scopeEnd &&
                    (p.normalized.includes(revision.normalizedOldText) || revision.normalizedOldText.includes(p.normalized))
                );
                if (replaceIndex >= 0) {
                    const target = paragraphs[replaceIndex];
                    const alreadyReplaced = normalize(xml).includes(normalize(revision.text));
                    if (alreadyReplaced) {
                        skipped.push({ anchor: revision.anchor, articleAnchor: revision.articleAnchor, reason: 'already_replaced' });
                        continue;
                    }
                    const replacementXml = this._buildReplacementParagraphXml(revision.text, target.xml);
                    xml = xml.slice(0, target.index) + replacementXml + xml.slice(target.end);
                    insertedCount += 1;
                    continue;
                }
            }

            let insertAfter = startIndex;
            for (let i = startIndex + 1; i < paragraphs.length; i += 1) {
                if (isInsertionBoundary(paragraphs[i].text) || isClosingBoundary(paragraphs[i].text)) break;
                insertAfter = i;
            }

            const target = paragraphs[insertAfter];
            const alreadyInserted = normalize(xml).includes(normalize(revision.text));
            if (!target || alreadyInserted) {
                skipped.push({ anchor: revision.anchor, articleAnchor: revision.articleAnchor, reason: alreadyInserted ? 'already_inserted' : 'target_not_found' });
                continue;
            }

            const insertionXml = this._buildInsertedParagraphXml(revision.text, target.xml);
            xml = xml.slice(0, target.end) + insertionXml + xml.slice(target.end);
            insertedCount += 1;
        }

        this._validateWordDocumentXml(xml);
        zip.updateFile('word/document.xml', Buffer.from(xml, 'utf8'));
        const outputBuffer = zip.toBuffer();
        this._validateDocxPackage(outputBuffer);
        return { buffer: outputBuffer, insertedCount, requestedCount: normalizedRevisions.length, skipped };
    }
    /**
     * Convert DOCX file to PDF using LibreOffice/soffice.
     * Serialized: only one soffice conversion runs at a time across the whole process
     * (Windows single-instance safe). Concurrent callers queue rather than collide.
     */
    async convertToPdf(docxPath) {
        const run = () => this._convertToPdfImpl(docxPath);
        const task = __pdfConvertQueue.then(run, run);
        // Keep the queue chain alive regardless of this task's success/failure.
        __pdfConvertQueue = task.then(() => {}, () => {});
        return task;
    }

    /**
     * Actual LibreOffice conversion. Do NOT call directly — always go through
     * convertToPdf() so invocations stay serialized.
     */
    async _convertToPdfImpl(docxPath) {
        const absoluteDocxPath = path.resolve(String(docxPath || ''));
        if (!absoluteDocxPath || !fs.existsSync(absoluteDocxPath)) {
            throw new Error('DOCX file not found for conversion');
        }

        const outputDir = path.dirname(absoluteDocxPath);
        const outputPdfPath = path.join(
            outputDir,
            `${path.basename(absoluteDocxPath, path.extname(absoluteDocxPath))}.pdf`
        );
        if (fs.existsSync(outputPdfPath)) {
            await fs.promises.unlink(outputPdfPath).catch(() => {});
        }

        const commandCandidates = [
            String(process.env.SOFFICE_PATH || '').trim(),
            process.platform === 'win32' ? 'soffice.exe' : 'soffice',
            process.platform === 'win32' ? 'C:\\Program Files\\LibreOffice\\program\\soffice.exe' : 'libreoffice'
        ].filter(Boolean);

        let lastError = null;
        for (const command of commandCandidates) {
            try {
                // [DIAGNOSTIC] Log font matching before conversion
                if (process.platform !== 'win32') {
                    try {
                        const families = ["Yu Gothic", "Yu Mincho", "MS Gothic", "MS Mincho", "Meiryo"];
                        const matches = await Promise.all(families.map(f => execFileAsync('fc-match', [f]).then(r => `${f} => ${r.stdout.trim()}`).catch(() => `${f} => FAILED`)));
                        logger.info(`[FONT DIAGNOSTIC] Fontconfig Mapping:\n${matches.join('\n')}`);
                    } catch (diagErr) {
                        logger.warn('Font diagnostic (fc-match) failed:', diagErr.message);
                    }
                }

                // Ensure a unique user installation to avoid lock conflicts in concurrent environments
                const userInstallDir = path.join(os.tmpdir(), `soffice_user_${Date.now()}_${Math.floor(Math.random() * 1000)}`);
                // Build a VALID file URI for -env:UserInstallation. On Windows the path is `C:/...`
                // (no leading slash) and needs THREE slashes (file:///C:/...); two slashes makes
                // LibreOffice read `C:` as the URL host and silently fail (exit!=0 / no PDF / hang) —
                // this was a primary cause of PDF generation failing. On POSIX the path starts with
                // `/`, so `file://` + `/tmp` already yields the correct `file:///tmp`.
                const __slashed = userInstallDir.replace(/\\/g, '/');
                const userInstallUrl = __slashed.startsWith('/') ? `file://${__slashed}` : `file:///${__slashed}`;
                
                await execFileAsync(
                    command,
                    [
                        '--headless',
                        '--norestore',
                        '--nolockcheck',
                        '--nodefault',
                        `-env:UserInstallation=${userInstallUrl}`,
                        '--convert-to', 'pdf:writer_pdf_Export',
                        '--outdir', outputDir,
                        absoluteDocxPath
                    ],
                    { windowsHide: true, timeout: 180000 }
                );
                
                // Cleanup temp profile after conversion if it was created
                try {
                    if (fs.existsSync(userInstallDir)) {
                        fs.rmSync(userInstallDir, { recursive: true, force: true });
                    }
                } catch (cleanupErr) {
                    logger.warn('LibreOffice temp profile cleanup failed:', cleanupErr.message);
                }

                if (fs.existsSync(outputPdfPath)) {
                    // [DIAGNOSTIC] Check embedded fonts in generated PDF
                    if (process.platform !== 'win32') {
                        try {
                            const { stdout } = await execFileAsync('pdffonts', [outputPdfPath]);
                            logger.info(`[PDF FONT CHECK] Generated PDF Fonts:\n${stdout}`);
                        } catch (diagErr) {
                            logger.warn('PDF font check (pdffonts) failed:', diagErr.message);
                        }
                    }
                    return outputPdfPath;
                }
            } catch (error) {
                lastError = error;
            }
        }

        throw new Error(`LibreOffice conversion failed${lastError?.message ? `: ${lastError.message}` : ''}`);
    }

    /**
     * Generate high-fidelity PNG images for each page of a PDF using pdftoppm
     * This provides a reliable fallback/preview when PDF.js rendering has font issues
     */
    async generatePageImages(pdfPath, requestId = 'fallback') {
        const absolutePdfPath = path.resolve(String(pdfPath || ''));
        if (!absolutePdfPath || !fs.existsSync(absolutePdfPath)) {
            throw new Error('PDF file not found for image generation');
        }

        const safeRequestId = String(requestId).replace(/[^a-zA-Z0-9_-]/g, '_');
        const outputDir = path.join(__dirname, '../../uploads/page-images', safeRequestId);
        
        try {
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            const baseName = 'page';
            const outputPrefix = path.join(outputDir, baseName);

            logger.info(`Generating page images for PDF: ${path.basename(absolutePdfPath)}`);
            
            // pdftoppm -png -r 150: 150 DPI is a good balance for quality/speed
            // -sep "": avoid extra dash if possible, but default is prefix-1.png
            await execFileAsync('pdftoppm', ['-png', '-r', '150', absolutePdfPath, outputPrefix]);

            const files = fs.readdirSync(outputDir)
                .filter(f => f.startsWith(baseName) && f.endsWith('.png'))
                .sort((a, b) => {
                    const aMatch = a.match(/-(\d+)\.png$/);
                    const bMatch = b.match(/-(\d+)\.png$/);
                    return (parseInt(aMatch?.[1] || '0')) - (parseInt(bMatch?.[1] || '0'));
                });

            // Return relative URLs for frontend
            return files.map(f => `/uploads/page-images/${safeRequestId}/${f}`);
        } catch (error) {
            logger.error('pdftoppm image generation failed:', error);
            // Non-fatal: if images fail, we still have the PDF
            return [];
        }
    }
}

module.exports = new DocxService();
