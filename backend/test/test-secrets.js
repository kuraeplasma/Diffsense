'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { getSecret } = require('../src/utils/secrets');

async function test() {
    console.log('Testing Secret Manager integration...');
    console.log('Current GEMINI_API_KEY exists:', !!process.env.GEMINI_API_KEY);
    
    // This will fail in local environment unless GOOGLE_APPLICATION_CREDENTIALS is set,
    // which is the expected behavior (it should fall back to .env).
    const secret = await getSecret('GEMINI_API_KEY');
    
    if (secret) {
        console.log('Successfully fetched secret from Secret Manager.');
    } else {
        console.log('Secret Manager fetch failed or skipped (expected in local dev without GCP auth).');
    }
    
    console.log('Final GEMINI_API_KEY exists:', !!process.env.GEMINI_API_KEY);
}

test().catch(console.error);
