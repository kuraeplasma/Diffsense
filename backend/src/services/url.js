const axios = require('axios');
const logger = require('../utils/logger');

class URLService {
    async extractText(url) {
        try {
            // Validate URL format
            const urlPattern = /^https?:\/\/.+/i;
            if (!urlPattern.test(url)) {
                throw new Error('Invalid URL format. URL must start with http:// or https://');
            }

            logger.info(`Fetching content from URL: ${url}`);

            const response = await axios.get(url, {
                timeout: 15000,
                maxContentLength: 10 * 1024 * 1024, // 10MB max
                headers: {
                    'User-Agent': 'DIFFsense-Bot/1.0'
                }
            });

            const html = response.data;
            const text = this.extractTextFromHTML(html);

            if (!text || text.trim().length === 0) {
                throw new Error('No text content could be extracted from the URL');
            }

            logger.info(`Successfully extracted ${text.length} characters from URL`);
            return text;

        } catch (error) {
            logger.error('URL extraction error:', error);

            if (error.code === 'ENOTFOUND') {
                throw new Error('URL not found or unreachable');
            } else if (error.code === 'ECONNABORTED') {
                throw new Error('URL request timeout');
            }

            throw new Error(`URL extraction failed: ${error.message}`);
        }
    }

    extractTextFromHTML(html) {
        // Remove script and style tags content first
        let text = html
            .replace(/<script[^>]*>.*?<\/script>/gis, '')
            .replace(/<style[^>]*>.*?<\/style>/gis, '')
            .replace(/<!--.*?-->/gis, '');

        // Replace block tags with newlines to preserve structure
        const blockTags = ['p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr'];
        blockTags.forEach(tag => {
            const regex = new RegExp(`</${tag}>`, 'gi');
            text = text.replace(regex, '\n');
            if (tag === 'br') text = text.replace(/<br\s*\/?>/gi, '\n');
        });

        // Strip remaining tags
        text = text
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");

        // Normalize whitespace (condense multiple spaces/newlines) using specific rules
        // 1. Remove leading/trailing whitespace per line
        text = text.split('\n').map(line => line.trim()).join('\n');
        // 2. Remove multiple empty lines (max 2)
        text = text.replace(/\n{3,}/g, '\n\n');

        return text.trim();
    }
}

module.exports = new URLService();
