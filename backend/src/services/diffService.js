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
     * Generate inline character-level diffs
     */
    _generateCharDiff(oldStr, newStr) {
        // For the visual diff, we want to keep some layout but normalize it to avoid noise
        const visualNormalize = (s) => String(s || '')
            .split('\n')
            .map(line => line.replace(/[ \t\r　]+/g, ' ').trim())
            .filter(line => line.length > 0)
            .join('\n');

        const vOld = visualNormalize(oldStr);
        const vNew = visualNormalize(newStr);

        const changes = diff.diffChars(vOld, vNew);
        return changes.map(part => {
            if (part.added) return `<span class="diff-add">${part.value}</span>`;
            if (part.removed) return `<span class="diff-del">${part.value}</span>`;
            return part.value;
        }).join('');
    }
}

module.exports = new DiffService();
