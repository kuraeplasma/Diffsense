import { getIdToken } from './auth.js';

/**
 * AI Service - Backend API Communication
 * バックエンドAPIとの通信を担当
 */
export const aiService = {
    // API Base URL (Local vs Cloud)
    API_BASE: (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
        ? 'http://localhost:3001'
        : 'https://api-qf37m5ba2q-an.a.run.app',

    /**
     * 契約書を解析
     * @param {number} contractId - 契約ID
     * @param {string} method - 'pdf' or 'url'
     * @param {string} source - Base64 PDF data or URL
     * @param {string|null} previousVersion - 旧バージョンのテキスト（オプション）
     * @returns {Promise<Object>} 解析結果
     */
    async analyzeContract(contractId, method, source, previousVersion = null) {
        try {
            const token = await getIdToken();
            console.log("AI Service: Token retrieval status:", token ? "Success" : "Failed");
            const response = await fetch(`${this.API_BASE}/contracts/analyze`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': token ? `Bearer ${token}` : ''
                },
                body: JSON.stringify({
                    contractId,
                    method,
                    source,
                    previousVersion
                })
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || `HTTP error! status: ${response.status}`);
            }

            return result;

        } catch (error) {
            console.error('AI Service Error:', error);

            // ネットワークエラーの場合
            if (error.message.includes('Failed to fetch')) {
                throw new Error('バックエンドAPIに接続できません。サーバーが起動しているか確認してください。');
            }

            throw error;
        }
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
            const token = await getIdToken();
            const response = await fetch(`${this.API_BASE}/invite`, {
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
            const response = await fetch(`${this.API_BASE}/health`);
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
                // data:application/pdf;base64, の部分を除去
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }
};
