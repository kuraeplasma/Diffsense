const diff = require('diff');
const stringSimilarity = require('string-similarity');
const logger = require('../utils/logger');

class DiffService {
    /**
     * Compare two structured documents
     * @param {Array} oldArticles 
     * @param {Array} newArticles 
     */
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

                // Use normalized text for comparison to ignore layout noise
                const oldContent = this._normalizeText(oldArt.full_text || '');
                const newContent = this._normalizeText(newArt.full_text || '');

                if (oldContent !== newContent) {
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

    /**
     * Normalize text for comparison by collapsing whitespace and line breaks
     */
    _normalizeText(text) {
        return String(text || '')
            .replace(/[ \t\r　]+/g, '') // Remove all horizontal whitespace including full-width space
            .replace(/\n+/g, '')       // Remove all line breaks for the most robust comparison
            .trim();
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
