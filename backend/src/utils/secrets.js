'use strict';

const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const logger = require('./logger');

const client = new SecretManagerServiceClient();

/**
 * Accesses a secret from Google Cloud Secret Manager and populates process.env.
 * @param {string} name The name of the secret (e.g. 'GEMINI_API_KEY')
 * @returns {Promise<string|null>} The secret value or null if failed
 */
async function getSecret(name) {
    // Only attempt if we have a project ID or are likely in a GCP environment
    const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || 'diffsense-9a718';
    
    try {
        logger.info(`Fetching secret ${name} from Secret Manager (project: ${projectId})...`);
        const [version] = await client.accessSecretVersion({
            name: `projects/${projectId}/secrets/${name}/versions/latest`,
        });

        const payload = version.payload.data.toString();
        if (payload) {
            process.env[name] = payload;
            return payload;
        }
        return null;
    } catch (error) {
        // We log as info/warn because it might just be missing in the environment, 
        // which is handled by the caller falling back to .env
        logger.warn(`Secret Manager access failed for ${name}: ${error.message}`);
        return null;
    }
}

module.exports = { getSecret };
