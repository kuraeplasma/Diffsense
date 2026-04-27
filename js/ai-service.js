import { getIdToken } from './auth.js';
import { getApiBaseUrl } from './api-base.js';

/**
 * AI Service - Backend API Communication
 * バックエンドAPIとの通信を担当
 */
export const aiService = {
    // Backward compatibility: existing code still references aiService.API_BASE.
    get API_BASE() {
        return this.getApiBase();
    },

    // API Base URL (Local vs Cloud). localhostでも本番APIを明示指定できる。
    getApiBase() {
        return getApiBaseUrl();
    },

    /**
     * 契約書を解析
     * @param {number} contractId - 契約ID
     * @param {string} method - 'pdf' or 'url'
     * @param {string} source - Base64 PDF data or URL
     * @param {string|null} previousVersion - 旧バージョンのテキスト（オプション）
     * @returns {Promise<Object>} 解析結果
     */
    async analyzeContract(contractId, method, source, previousVersion = null, options = {}) {
        console.info('AI_CLICK', { contractId, options });
        try {
            if (options.userTriggered !== true) {
                const blockedError = new Error('AI execution blocked: userTriggered flag is required');
                blockedError.code = 'USER_TRIGGER_REQUIRED';
                console.warn('AI execution blocked', {
                    type: 'ai_execution_blocked',
                    contractId,
                    method,
                    reason: 'missing_userTriggered',
                    timestamp: Date.now()
                });
                throw blockedError;
            }
            console.info('AI execution started', {
                type: 'ai_execution_started',
                contractId,
                method,
                skipAI: options.skipAI === true,
                timestamp: Date.now()
            });
            const apiBase = this.getApiBase();
            const token = await getIdToken();
            console.log("AI Service: Token retrieval status:", token ? "Success" : "Failed");
            const normalizedPreviousVersion = method === 'docx'
                ? previousVersion
                : this.normalizePreviousVersion(previousVersion);
            const body = {
                contractId: Number(contractId),
                method,
                source,
                previousVersion: normalizedPreviousVersion
            };
            if (options.skipAI) {
                body.skipAI = true;
            }
            // Word解析は常に専用エンドポイントを使用
            // 一部環境の /contracts/analyze バリデーションでは docx が未許可のため
            const endpoint = (method === 'docx')
                ? `${apiBase}/contracts/upload-docx`
                : `${apiBase}/contracts/analyze`;

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': token ? `Bearer ${token}` : ''
                },
                body: JSON.stringify(body)
            });

            const data = await response.json();

            if (!response.ok || !data.success) {
                const apiError = new Error(data?.error || data?.message || `解析失敗 (HTTP ${response.status})`);
                if (data?.code) apiError.code = data.code;
                throw apiError;
            }

            const result = data.data;
            
            // Normalize DOCX full-analysis response shape.
            if (result) {
                if (result.extractedText === undefined && Array.isArray(result.articles)) {
                    result.extractedText = result.articles;
                }
                if (result.extractedText === undefined && result.structuredContract !== undefined) {
                    result.extractedText = result.structuredContract;
                }
                if (result.summary === undefined && result.changeSummary !== undefined) {
                    result.summary = result.changeSummary;
                }
                if (method === 'docx' && !result.sourceType) {
                    result.sourceType = 'DOCX';
                }
            }

            console.log("AI RESULT:", result);
            return { success: true, data: result };

        } catch (error) {
            console.error('AI Service Error:', error);

            // ネットワークエラー・タイムアウトの場合
            if (error.message.includes('Failed to fetch') || error.message.includes('timeout') || error.message.includes('Timeout')) {
                throw new Error('取り込みに時間がかかりすぎました。もう一度お試しください。');
            }

            throw error;
        }
    },

    normalizePreviousVersion(previousVersion) {
        if (previousVersion === null || previousVersion === undefined || previousVersion === '') {
            return null;
        }
        if (typeof previousVersion === 'string') {
            return previousVersion;
        }
        if (Array.isArray(previousVersion)) {
            return previousVersion;
        }
        if (typeof previousVersion === 'object') {
            return previousVersion;
        }
        return String(previousVersion);
    },

    /**
     * 招待メールを送信
     * @param {string} email - 招待先メールアドレス
     * @param {string} name - 招待先名前
     * @param {string} role - 権限
     * @returns {Promise<Object>} 送信結果
     */
    async sendInvite(email, name, role) {
        try {
            const apiBase = this.getApiBase();
            const token = await getIdToken();
            const response = await fetch(`${apiBase}/invite`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': token ? `Bearer ${token}` : ''
                },
                body: JSON.stringify({
                    email,
                    name,
                    role
                })
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || `HTTP error! status: ${response.status}`);
            }

            return result;
        } catch (error) {
            console.error('Invite Error:', error);
            throw error;
        }
    },

    /**
     * ヘルスチェック
     * @returns {Promise<Object>} サーバーステータス
     */
    async healthCheck() {
        try {
            const apiBase = this.getApiBase();
            const response = await fetch(`${apiBase}/health`);
            return await response.json();
        } catch (error) {
            console.error('Health check failed:', error);
            return { status: 'error', error: error.message };
        }
    },

    /**
     * ファイルをBase64に変換
     * @param {File} file - PDFファイル
     * @returns {Promise<string>} Base64エンコードされたデータ
     */
    convertFileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                let result = reader.result;
                const fileName = file.name.toLowerCase();

                // .docx ファイルが application/octet-stream として認識される場合の補正
                if (fileName.endsWith('.docx') && result.startsWith('data:application/octet-stream;')) {
                    result = result.replace('data:application/octet-stream;', 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;');
                }

                // Base64の部分のみ抽出して返す
                const base64 = result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }
};
