const diff = require('diff');
const stringSimilarity = require('string-similarity');
const logger = require('../utils/logger');

/**
 * Super Normalizer to unify CJK character widths and eliminate layout noise
 */
function superNormalize(str) {
    if (!str) return '';
    return String(str)
        .replace(/[！-～]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)) // Full-width to Half-width
        .replace(/　/g, ' ') // Full-width space to half-width
        .replace(/[（【［]/g, '(')
        .replace(/[）】］]/g, ')')
        .replace(/[「『]/g, '"')
        .replace(/[」』]/g, '"')
        .replace(/[―ー—－]/g, '-')
        .replace(/[\s\n\r\t]+/g, '') // Remove all whitespace for the comparison check
        .trim();
}

class DiffService {
    /**
     * Compare two structured documents
     * @param {Array} oldArticles 
     * @param {Array} newArticles 
     */
    compare(oldArticles, newArticles) {
        const changes = [];
        const matchedNewIndices = new Set();

        for (const oldArt of oldArticles) {
            // Find best match in newArticles
            let bestMatch = this._findBestMatch(oldArt, newArticles, matchedNewIndices);

            if (bestMatch.index !== -1) {
                const newArt = newArticles[bestMatch.index];
                matchedNewIndices.add(bestMatch.index);

                // Use super normalization for comparison to ignore character width and layout noise
                const oldContent = superNormalize(oldArt.full_text || '');
                const newContent = superNormalize(newArt.full_text || '');

                // Only consider it a "change" if it's more than just noise.
                // For long texts, we permit a tiny difference (e.g. 1-2 phantom chars from PDF extraction)
                const isSignificantlyDifferent = (() => {
                    if (oldContent === newContent) return false;
                    
                    const sim = stringSimilarity.compareTwoStrings(oldContent, newContent);
                    if (sim > 0.998) {
                        // If it's 99.8% similar, check if actual "material" words changed.
                        // If only isolated numbers or symbols changed, it's likely noise.
                        return false; 
                    }
                    return true;
                })();

                if (isSignificantlyDifferent) {
                    // Content changed
                    changes.push({
                        type: 'MODIFY',
                        section: newArt.title ? `${newArt.article}（${newArt.title}）` : `${newArt.article}`,
                        old: oldArt.full_text || '',
                        new: newArt.full_text || '',
                        articleNumber: newArt.article_number,
                        oldArticleNumber: oldArt.article_number,
                        similarity: bestMatch.similarity,
                        charDiff: this._generateCharDiff(oldArt.full_text || '', newArt.full_text || '')
                    });
                }
            } else {
                // Article was deleted
                changes.push({
                    type: 'DELETE',
                    section: oldArt.title ? `${oldArt.article}（${oldArt.title}）` : `${oldArt.article}`,
                    old: oldArt.full_text || '',
                    new: '',
                    articleNumber: null,
                    oldArticleNumber: oldArt.article_number
                });
            }
        }

        // Identify added articles
        newArticles.forEach((newArt, index) => {
            if (!matchedNewIndices.has(index)) {
                changes.push({
                    type: 'ADD',
                    section: newArt.title ? `${newArt.article}（${newArt.title}）` : `${newArt.article}`,
                    old: '',
                    new: newArt.full_text || '',
                    articleNumber: newArt.article_number,
                    oldArticleNumber: null
                });
            }
        });

        // Sort changes by new article number (effectively)
        return changes.sort((a, b) => (a.articleNumber || 999) - (b.articleNumber || 999));
    }

    /**
     * Compress article-level changes down to minimal +/- line snippets for MCP use.
     * This keeps only changed lines, not full unchanged clause bodies.
     * @param {Array} changes
     * @param {object} options
     */
    compressChangesForMcp(changes, options = {}) {
        const perSideLineLimit = Number(options.perSideLineLimit || 4);
        return (Array.isArray(changes) ? changes : [])
            .map((change) => {
                const compact = this._buildCompactDiffForMcp(change, perSideLineLimit);
                return {
                    ...change,
                    old: compact.old,
                    new: compact.new,
                    diffText: compact.diffText
                };
            })
            .filter((change) => String(change.diffText || change.old || change.new || '').trim());
    }

    /**
     * Find the most likely match for an old article in the new set
     */
    _findBestMatch(oldArt, newArticles, matchedIndices) {
        let bestScore = -1;
        let bestIndex = -1;

        const oldClean = this._normalizeText(oldArt.full_text || '');

        for (let i = 0; i < newArticles.length; i++) {
            if (matchedIndices.has(i)) continue;

            const newArt = newArticles[i];
            let score = 0;

            // 1. Exact match (Number & Title)
            if (oldArt.article_number === newArt.article_number && oldArt.article_title === newArt.article_title) {
                score = 1.1; // Bonus for exact structural match
            }

            // 2. Title match (Potential renumbering)
            if (oldArt.title && oldArt.title === newArt.title) {
                score = Math.max(score, 0.9);
            }

            // 3. Content similarity (Normalized)
            const newClean = this._normalizeText(newArt.full_text || '');
            const contentSim = stringSimilarity.compareTwoStrings(oldClean, newClean);
            score = Math.max(score, contentSim);

            if (score > bestScore && score > 0.4) { // Threshold for a "match"
                bestScore = score;
                bestIndex = i;
            }
        }

        return { index: bestIndex, similarity: Math.min(1.0, bestScore) };
    }

    _buildCompactDiffForMcp(change, perSideLineLimit = 4) {
        const type = String(change?.type || 'MODIFY').toUpperCase();
        if (type === 'ADD') {
            return this._formatCompactDiff([], this._extractMeaningfulLines(change?.new || ''), perSideLineLimit);
        }
        if (type === 'DELETE') {
            return this._formatCompactDiff(this._extractMeaningfulLines(change?.old || ''), [], perSideLineLimit);
        }
        return this._buildCompactModifyDiff(change?.old || '', change?.new || '', perSideLineLimit);
    }

    _buildCompactModifyDiff(oldText, newText, perSideLineLimit = 4) {
        const removedLines = [];
        const addedLines = [];
        const chunks = diff.diffLines(String(oldText || ''), String(newText || ''), { ignoreWhitespace: false });

        chunks.forEach((part) => {
            const lines = this._extractMeaningfulLines(part.value || '');
            if (part.removed) {
                removedLines.push(...lines);
            } else if (part.added) {
                addedLines.push(...lines);
            }
        });

        if (removedLines.length === 0 && addedLines.length === 0 && String(oldText || '').trim() !== String(newText || '').trim()) {
            const oldFallback = String(oldText || '').replace(/\s+/g, ' ').trim();
            const newFallback = String(newText || '').replace(/\s+/g, ' ').trim();
            return this._formatCompactDiff(
                oldFallback ? [oldFallback] : [],
                newFallback ? [newFallback] : [],
                perSideLineLimit
            );
        }

        return this._formatCompactDiff(removedLines, addedLines, perSideLineLimit);
    }

    _extractMeaningfulLines(text) {
        return String(text || '')
            .split(/\r?\n/)
            .map((line) => line.replace(/\s+/g, ' ').trim())
            .filter(Boolean);
    }

    _limitCompactLines(lines, limit) {
        const normalized = Array.from(new Set((Array.isArray(lines) ? lines : []).filter(Boolean)));
        if (normalized.length <= limit) return normalized;
        return [
            ...normalized.slice(0, limit),
            `...[他${normalized.length - limit}行]`
        ];
    }

    _formatCompactDiff(removedLines, addedLines, perSideLineLimit = 4) {
        const limitedRemoved = this._limitCompactLines(removedLines, perSideLineLimit);
        const limitedAdded = this._limitCompactLines(addedLines, perSideLineLimit);
        const oldText = limitedRemoved.map((line) => `- ${line}`).join('\n');
        const newText = limitedAdded.map((line) => `+ ${line}`).join('\n');
        return {
            old: oldText,
            new: newText,
            diffText: [oldText, newText].filter(Boolean).join('\n')
        };
    }

    /**
     * Normalize text for comparison (internal helper using superNormalize)
     */
    _normalizeText(text) {
        return superNormalize(text);
    }

    /**
     * Generate inline character-level diffs using a robust token-based approach
     */
    _generateCharDiff(oldStr, newStr) {
        // Step 1: Normalize layout for comparison
        // We trim every line and collapse horizontal whitespace, but keep single newlines as placeholders
        const visualNormalize = (s) => String(s || '')
            .split('\n')
            .map(line => line.replace(/[ \t\r　]+/g, '').trim())
            .filter(line => line.length > 0)
            .join(' \n '); // Add spaces around \n to treat it as a token

        const vOld = visualNormalize(oldStr);
        const vNew = visualNormalize(newStr);

        // Step 2: "Space Injection" for Japanese/CJK text
        // We insert a zero-width space or regular space between every character 
        // to force the word-diff engine to treat each character as a stable token.
        // This is much more robust for long strings than character-diff.
        const inject = (s) => s.split('').join(' ');
        const iOld = inject(vOld);
        const iNew = inject(vNew);

        // Step 3: Perform word-level diff on the space-injected strings
        const changes = diff.diffWords(iOld, iNew);

        // Step 4: Reconstruct the diffed HTML, removing the injected spaces
        return changes.map(part => {
            let val = part.value.replace(/ /g, '');
            
            // Step 5: Noise suppression
            // If the change is ONLY whitespace/newlines, we don't want to highlight it
            if (!val.trim() && val.length > 0) {
                return val;
            }

            if (part.added) return `<span class="diff-add">${val}</span>`;
            if (part.removed) return `<span class="diff-del">${val}</span>`;
            return val;
        }).join('');
    }
}

module.exports = new DiffService();
