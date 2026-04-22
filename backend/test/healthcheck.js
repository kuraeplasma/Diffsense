const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * DIFFsense Backend Health Check
 * 既存APIと新規非同期APIの動作を検証する
 */

// 設定（環境変数またはデフォルト）
const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const ID_TOKEN = process.env.ID_TOKEN;

async function runTests() {
    console.log(`Starting health check for: ${API_BASE}`);
    
    if (!ID_TOKEN) {
        console.warn('Warning: ID_TOKEN is not set. Tests may fail if auth is required.');
    }

    const headers = {
        'Authorization': ID_TOKEN ? `Bearer ${ID_TOKEN}` : '',
        'Content-Type': 'application/json'
    };

    try {
        // 1. GET /api/contracts の検証
        console.log('Test 1: GET /api/contracts ...');
        const resContracts = await axios.get(`${API_BASE}/api/contracts`, { headers });
        
        if (resContracts.status !== 200) {
            throw new Error(`GET /api/contracts failed with status ${resContracts.status}`);
        }
        
        if (!resContracts.data || !resContracts.data.success) {
            throw new Error('GET /api/contracts response success flag is false');
        }
        
        if (!Array.isArray(resContracts.data.data)) {
            throw new Error('GET /api/contracts response data is not an array');
        }
        console.log('Test 1: PASS');

        // 2. POST /api/docx/upload-async の検証
        console.log('Test 2: POST /api/docx/upload-async ...');
        
        // ダミーのDOCXファイルデータを作成（Magic Bytes: PK\x03\x04）
        const dummyBuffer = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
        
        const FormData = require('form-data');
        const form = new FormData();
        form.append('file', dummyBuffer, {
            filename: 'healthcheck_test.docx',
            contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        });
        form.append('contractId', '12345'); // ダミーID
        form.append('skipAI', 'true');      // テスト時はAI解析をスキップ

        const resAsync = await axios.post(`${API_BASE}/api/docx/upload-async`, form, {
            headers: {
                ...headers,
                ...form.getHeaders()
            }
        });

        if (resAsync.status !== 200) {
            throw new Error(`POST /api/docx/upload-async failed with status ${resAsync.status}`);
        }

        if (resAsync.data.status !== 'processing') {
            throw new Error(`Expected status "processing", but got "${resAsync.data.status}"`);
        }
        
        if (!resAsync.data.contractId) {
            throw new Error('Response missing contractId');
        }
        console.log('Test 2: PASS');

        console.log('\n=============================');
        console.log('       ALL PASS');
        console.log('=============================');
        process.exit(0);

    } catch (error) {
        console.error('\n=============================');
        console.error('       TEST FAILED');
        console.error('=============================');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('Error:', error.message);
        }
        process.exit(1);
    }
}

// form-data が必要（axiosだけでは不十分な場合があるため）
try {
    require.resolve('form-data');
} catch (e) {
    console.error('Error: "form-data" package is required for this test.');
    console.log('Please run: npm install --save-dev form-data');
    process.exit(1);
}

runTests();
