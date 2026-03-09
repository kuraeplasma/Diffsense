const diff = require('diff');
const stringSimilarity = require('string-similarity');
const logger = require('../utils/logger');

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

                if (bestMatch.similarity < 1.0) {
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

            // 3. Content similarity
            const contentSim = stringSimilarity.compareTwoStrings(oldArt.full_text || '', newArt.full_text || '');
            score = Math.max(score, contentSim);

            if (score > bestScore && score > 0.4) { // Threshold for a "match"
                bestScore = score;
                bestIndex = i;
            }
        }

        return { index: bestIndex, similarity: Math.min(1.0, bestScore) };
    }

    /**
     * Generate inline character-level diffs
     */
    _generateCharDiff(oldStr, newStr) {
        const changes = diff.diffChars(oldStr, newStr);
        return changes.map(part => {
            if (part.added) return `<span class="diff-add">${part.value}</span>`;
            if (part.removed) return `<span class="diff-del">${part.value}</span>`;
            return part.value;
        }).join('');
    }
}

module.exports = new DiffService();
