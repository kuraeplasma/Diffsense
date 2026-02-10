const axios = require('axios');
const cheerio = require('cheerio');
const pdf = require('pdf-parse');
const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Service to handle crawling of URLs (HTML/PDF) and change detection
 */
class CrawlService {
    /**
     * Fetch content from URL and extract text
     * @param {string} url 
     * @returns {Promise<Object>} { text: string, hash: string }
     */
    async fetchAndExtract(url) {
        try {
            logger.info(`Crawling URL: ${url}`);
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });

            const contentType = response.headers['content-type'] || '';
            let text = '';

            if (contentType.includes('application/pdf')) {
                const data = await pdf(response.data);
                text = data.text;
            } else {
                // Assume HTML
                const html = response.data.toString('utf-8');
                const $ = cheerio.load(html);

                // Remove scripts, styles, and other non-content elements
                $('script, style, nav, footer, header, noscript').remove();

                text = $('body').text();
            }

            // Normalize text: remove extra whitespace, normalize line breaks
            const normalizedText = text
                .replace(/\s+/g, ' ')
                .trim();

            const hash = crypto.createHash('sha256').update(normalizedText).digest('hex');

            return {
                text: normalizedText,
                hash: hash
            };
        } catch (error) {
            logger.error(`Crawl Error for ${url}:`, error.message);
            throw error;
        }
    }

    /**
     * Compare new hash with old hash
     * @param {string} newHash 
     * @param {string} oldHash 
     * @returns {boolean} True if changed
     */
    hasChanged(newHash, oldHash) {
        if (!oldHash) return true; // First time crawling
        return newHash !== oldHash;
    }
}

module.exports = new CrawlService();
