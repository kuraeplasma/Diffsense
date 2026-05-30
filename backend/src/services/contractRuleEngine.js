const logger = require('../utils/logger');

/**
 * Contract-specific Rule Engine for structural analysis.
 * Follows strict rules to prevent loss of clauses and structure.
 */
class ContractRuleEngine {
    /**
     * Parse raw contract text into structured blocks.
     * @param {string} rawText 
     * @returns {Array} List of structured blocks
     */
    parse(rawText) {
        if (!rawText) return [];

        // STEP 1: Line Extraction
        const lines = rawText.split(/\r?\n/);
        const blocks = [];
        let currentBlock = null;

        // Robust Regex for clause detection
        // Supports: 第1条, 第１条, 第一条, 第十条, 第◯条, 第〇条, 第○条, 【第1条】, [第1条] etc.
        const CLAUSE_REGEX = /^[【［\[]?\s*第\s*([0-9０-９一二三四五六七八九十百千〇○◯]+)\s*[条章節]\s*[】］\]]?(.*)/;
        
        // Regex for title candidate (brackets, short standalone, or common keywords)
        const TITLE_BRACKET_REGEX = /^\s*([（(【［\[][^）)】］］\]]+[）)】］］\]]|記|以上|附則|別紙|別表)\s*$/;

        for (let i = 0; i < lines.length; i++) {
            const rawLine = lines[i].trimEnd();
            const line = rawLine.trim();
            
            // LOSSLESS: Do NOT skip blank lines. They are part of the original document structure.
            if (!line) {
                if (currentBlock) {
                    currentBlock.rawLines.push('');
                } else if (blocks.length > 0 && blocks[blocks.length - 1].type === 'preamble') {
                    blocks[blocks.length - 1].rawLines.push('');
                }
                continue;
            }

            const clauseMatch = line.match(CLAUSE_REGEX);
            if (clauseMatch) {
                // STEP 2: Context Analysis & STEP 3: Block Generation
                const numStr = clauseMatch[1];
                const clauseNumber = `第${numStr}条`;
                let title = (clauseMatch[2] || '').trim();
                let consumedNextLine = false;

                // OCR robustness: If title is empty on the same line, check the next line
                if (!title) {
                    const nextLine = (lines[i + 1] || '').trim();
                    const nextTitleMatch = nextLine.match(TITLE_BRACKET_REGEX);
                    
                    if (nextTitleMatch) {
                        title = (nextTitleMatch[1] || nextTitleMatch[0]).trim(); // Support both matched group and full line for keywords
                        consumedNextLine = true;
                        
                        console.log('[CLAUSE MERGE]', {
                            clauseNumber,
                            title
                        });
                    }
                } else {
                    // Title was on the same line, e.g., "第3条（賃料）"
                    const inlineTitleMatch = title.match(TITLE_BRACKET_REGEX);
                    if (inlineTitleMatch) {
                        title = (inlineTitleMatch[1] || inlineTitleMatch[0]).trim();
                    }
                }

                console.log('[CLAUSE DETECT]', {
                    lineIndex: i,
                    line,
                    nextLine: consumedNextLine ? (lines[i + 1] || '').trim() : (lines[i+1] ? lines[i+1].trim() : null),
                    detected: true
                });

                currentBlock = {
                    type: 'clause',
                    clauseNumber,
                    title: title || '',
                    rawLines: []
                };
                blocks.push(currentBlock);

                if (consumedNextLine) {
                    i++; // Skip the next line as it was merged into title
                }
                continue;
            }

            // STEP 4: Content Connection
            if (currentBlock) {
                currentBlock.rawLines.push(rawLine);
            } else {
                // Preamble or header before the first clause
                if (line) {
                    if (!blocks[0] || blocks[0].type !== 'preamble') {
                        blocks.push({
                            type: 'preamble',
                            clauseNumber: '前文',
                            title: '前文',
                            rawLines: [rawLine]
                        });
                    } else {
                        blocks[0].rawLines.push(rawLine);
                    }
                }
            }
        }

        // Finalize blocks
        this._lossCheck(rawText, blocks);

        return blocks;
    }

    /**
     * Convert internal blocks to the legacy "Article" format used by the app.
     */
    toLegacyFormat(blocks) {
        return blocks.map((block, index) => {
            const numStr = block.clauseNumber === '前文' ? '' : (block.clauseNumber.match(/第(.+?)条/) || [])[1];
            const numeric = this._parseJapaneseNumber(numStr);
            
            return {
                article: block.clauseNumber,
                title: block.title,
                article_number: numeric || index,
                paragraphs: block.rawLines.filter(p => p !== null),
                full_text: `${block.clauseNumber}${block.title ? `（${block.title}）` : ''}\n${block.rawLines.join('\n')}`.trim()
            };
        });
    }

    _parseJapaneseNumber(str) {
        if (!str) return 0;
        const normalized = str.replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));
        if (/^\d+$/.test(normalized)) return parseInt(normalized, 10);

        const kanji = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '百': 100, '千': 1000, '〇': 0, '○': 0, '◯': 0 };
        if (kanji[str]) return kanji[str];

        // Basic kanji number parsing (simplified for common article numbers)
        let total = 0;
        let tmp = 0;
        for (let i = 0; i < str.length; i++) {
            const c = str[i];
            if (kanji[c] !== undefined) {
                const v = kanji[c];
                if (v === 10 || v === 100) {
                    total += (tmp || 1) * v;
                    tmp = 0;
                } else {
                    tmp = v;
                }
            }
        }
        return total + tmp;
    }

    /**
     * Vertical list detection (for table-like structures)
     */
    _isTableLikeContext(lines, index) {
        // Look at surrounding lines to see if it's a vertical list
        const prev = (lines[index - 1] || '').trim();
        const next = (lines[index + 1] || '').trim();
        
        if (prev && next && prev.length < 20 && next.length < 20) {
            return true;
        }
        return false;
    }

    /**
     * Ensure no clauses were lost during parsing.
     */
    _lossCheck(rawText, blocks) {
        const originalClauses = rawText.match(/第\s*[0-9０-９一二三四五六七八九十百千〇○◯]+\s*条/g) || [];
        const parsedClauses = blocks
            .filter(b => b.type === 'clause')
            .map(b => b.clauseNumber);

        const missing = originalClauses.filter(oc => {
            const norm = oc.replace(/\s+/g, '');
            return !parsedClauses.some(pc => pc.replace(/\s+/g, '') === norm);
        });

        if (missing.length > 0) {
            missing.forEach(m => console.error('[CLAUSE LOST]', m));
        }

        console.log('[CLAUSE LOSS CHECK]', {
            originalCount: originalClauses.length,
            parsedCount: parsedClauses.length,
            missing: missing
        });
    }
}

module.exports = new ContractRuleEngine();
