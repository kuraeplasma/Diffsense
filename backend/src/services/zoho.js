const axios = require('axios');
const logger = require('../utils/logger');
const path = require('path');

/**
 * ZohoSignService - Handles integration with Zoho Sign API
 * Focused on "Embedded" signing flow.
 */
class ZohoSignService {
    constructor() {
        // Data Center specific API endpoints
        // DC: jp (https://sign.zoho.jp), com (https://sign.zoho.com), etc.
        const dc = process.env.ZOHO_DC || 'com';
        this.apiBase = `https://sign.zoho.${dc}/api/v1`;
        this.accountsBase = `https://accounts.zoho.${dc}/oauth/v2/token`;
        
        this.clientId = process.env.ZOHO_CLIENT_ID;
        this.clientSecret = process.env.ZOHO_CLIENT_SECRET;
        this.refreshToken = process.env.ZOHO_REFRESH_TOKEN;
        
        this.accessToken = null;
        this.tokenExpiry = 0;
    }

    getSignHost() {
        return `https://sign.zoho.${process.env.ZOHO_DC || 'com'}`;
    }

    isLocalMockMode() {
        const noCredentials = !this.clientId || !this.clientSecret || !this.refreshToken;
        return noCredentials && (process.env.NODE_ENV === 'development' || process.env.AUTH_BYPASS === 'true');
    }

    /**
     * Ensures we have a valid access token
     */
    async ensureToken() {
        if (this.accessToken && Date.now() < this.tokenExpiry) {
            return this.accessToken;
        }

        if (!this.clientId || !this.clientSecret || !this.refreshToken) {
            logger.error('ZohoSign: Missing API credentials in .env');
            throw new Error('Zoho Sign credentials not configured');
        }

        try {
            logger.info('ZohoSign: Refreshing access token...');
            const response = await axios.post(this.accountsBase, null, {
                params: {
                    refresh_token: this.refreshToken,
                    client_id: this.clientId,
                    client_secret: this.clientSecret,
                    grant_type: 'refresh_token'
                }
            });

            if (response.data.access_token) {
                this.accessToken = response.data.access_token;
                // Expiry is usually 3600s, we'll refresh 5 mins early
                this.tokenExpiry = Date.now() + (response.data.expires_in - 300) * 1000;
                logger.info('ZohoSign: Token refreshed successfully');
                return this.accessToken;
            } else {
                throw new Error('Failed to get access token from Zoho');
            }
        } catch (error) {
            logger.error('ZohoSign Token Refresh Error:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Create a signature request for a document
     * @param {Buffer} fileBuffer - The PDF/Docx file content
     * @param {string} fileName - Name of the file
     * @param {Array} recipients - Array of { name, email, role }
     */
    async createSignRequest(fileBuffer, fileName, recipients) {
        if (this.isLocalMockMode()) {
            logger.warn('ZohoSign: Running in local mock mode for createSignRequest');
            const mockRequestId = `ZOHO_${Date.now()}`;
            const mockActions = recipients.map((r, i) => ({
                action_id: `ACT_${mockRequestId}_${i}`,
                recipient_email: r.email,
                recipient_name: r.name
            }));

            return {
                request_id: mockRequestId,
                actions: mockActions
            };
        }

        const token = await this.ensureToken();

        try {
            // 1. Upload Document
            // Note: In Zoho Sign, you upload the file as a part of the "requests" payload or as a multi-part
            // For brevity in structural implementation, we'll follow the multi-part upload for "requests"
            
            // ... Actual multi-part logic would go here ...
            // Mocking the creation for now but following the API structure
            
            logger.info(`ZohoSign: Creating request for ${fileName} with ${recipients.length} recipients`);
            
            // --- ACTUAL IMPLEMENTATION STEPS ---
            // const formData = new FormData();
            // formData.append('file', fileBuffer, fileName);
            // formData.append('data', JSON.stringify({
            //     requests: {
            //         request_name: fileName,
            //         actions: recipients.map(r => ({
            //             recipient_name: r.name,
            //             recipient_email: r.email,
            //             action_type: 'SIGN',
            //             signing_order: 1
            //         }))
            //     }
            // }));
            
            // const response = await axios.post(`${this.apiBase}/requests`, formData, { ... });
            
            // Temporary Structural Mock
            const mockRequestId = `ZOHO_${Date.now()}`;
            const mockActions = recipients.map((r, i) => ({
                action_id: `ACT_${mockRequestId}_${i}`,
                recipient_email: r.email,
                recipient_name: r.name
            }));

            return {
                request_id: mockRequestId,
                actions: mockActions
            };

        } catch (error) {
            logger.error('ZohoSign Create Request Error:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Get the embedded signing URL for a recipient
     * @param {string} requestId - The Zoho Request ID
     * @param {string} actionId - The specific action ID for the recipient
     */
    async getEmbeddedUrl(requestId, actionId) {
        if (this.isLocalMockMode()) {
            logger.warn('ZohoSign: Running in local mock mode for getEmbeddedUrl');
            return `http://localhost:3000/dashboard.html#sign-recipient/${encodeURIComponent(requestId)}?actionId=${encodeURIComponent(actionId)}`;
        }

        const token = await this.ensureToken();

        try {
            logger.info(`ZohoSign: Fetching embedded URL for requestId: ${requestId}, actionId: ${actionId}`);
            
            const response = await axios.post(`${this.apiBase}/requests/${requestId}/actions/${actionId}/embedtoken`, null, {
                headers: { 'Authorization': `Zoho-oauthtoken ${token}` }
            });

            if (response.data && response.data.embedded_token) {
                // In Zoho Sign, the embedded URL is constructed using the token
                return `https://sign.zoho.${process.env.ZOHO_DC || 'com'}/zs/embedded/${response.data.embedded_token}`;
            }
            
            throw new Error('No embedded token returned from Zoho');
        } catch (error) {
            logger.error('ZohoSign Embedded URL Error:', error.response?.data || error.message);
            throw error;
        }
    }

    async downloadCompletedDocument(requestId) {
        if (this.isLocalMockMode()) {
            logger.warn('ZohoSign: Skipping completed document download in local mock mode');
            return null;
        }

        const token = await this.ensureToken();

        try {
            const response = await axios.get(`${this.apiBase}/requests/${requestId}/pdf`, {
                headers: { 'Authorization': `Zoho-oauthtoken ${token}` },
                responseType: 'arraybuffer'
            });

            const contentDisposition = response.headers['content-disposition'] || '';
            const fileNameMatch = contentDisposition.match(/filename="?([^"]+)"?/i);
            const fileName = fileNameMatch?.[1] || `${requestId}-signed.pdf`;

            return {
                buffer: Buffer.from(response.data),
                fileName: path.basename(fileName),
                mimeType: response.headers['content-type'] || 'application/pdf'
            };
        } catch (error) {
            logger.error('ZohoSign Completed Document Download Error:', error.response?.data || error.message);
            throw error;
        }
    }

    async downloadCompletionCertificate(requestId) {
        if (this.isLocalMockMode()) {
            logger.warn('ZohoSign: Skipping completion certificate download in local mock mode');
            return null;
        }

        const token = await this.ensureToken();

        try {
            const response = await axios.get(`${this.apiBase}/requests/${requestId}/completioncertificate`, {
                headers: { 'Authorization': `Zoho-oauthtoken ${token}` },
                responseType: 'arraybuffer'
            });

            return {
                buffer: Buffer.from(response.data),
                fileName: `${requestId}-completion-certificate.pdf`,
                mimeType: response.headers['content-type'] || 'application/pdf'
            };
        } catch (error) {
            logger.error('ZohoSign Completion Certificate Download Error:', error.response?.data || error.message);
            throw error;
        }
    }
}

module.exports = new ZohoSignService();
