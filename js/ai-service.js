import { getIdToken } from './auth.js';
import { getApiBaseUrl } from './api-base.js';

const ACTIVE_CONTRACT_POLLS = new Map();

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function joinApiUrl(apiBase, endpointPath) {
    try {
        return new URL(endpointPath, `${String(apiBase || '').replace(/\/$/, '')}/`).toString();
    } catch {
        const normalizedBase = String(apiBase || '').replace(/\/$/, '');
        const normalizedPath = String(endpointPath || '').startsWith('/')
            ? endpointPath
            : `/${endpointPath}`;
        return `${normalizedBase}${normalizedPath}`;
    }
}

async function base64ToDocxBlob(base64Source) {
    const normalized = String(base64Source || '').split(',').pop() || '';
    const byteCharacters = atob(normalized);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
}

function normalizeDocxPreviousVersionForForm(previousVersion) {
    const raw = previousVersion == null ? '' : String(previousVersion);
    if (!raw) return '';

    // data:*;base64 は巨大化しやすく multipart field 上限を超えるため送らない
    if (/^data:.*;base64,/i.test(raw)) {
        console.warn('AI Service: Omit base64 previousVersion for DOCX multipart upload');
        return '';
    }

    // 大きすぎるテキストを送ると multipart 解析エラーの原因になるため抑制
    const MAX_PREVIOUS_TEXT_LENGTH = 200000;
    if (raw.length > MAX_PREVIOUS_TEXT_LENGTH) {
        console.warn(`AI Service: Truncate previousVersion for DOCX upload (${raw.length} -> ${MAX_PREVIOUS_TEXT_LENGTH})`);
        return raw.slice(0, MAX_PREVIOUS_TEXT_LENGTH);
    }

    return raw;
}

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
            const API_BASE = this.getApiBase();
            console.log("API_BASE:", API_BASE);
            const token = await getIdToken();
            console.log("AI Service: Token retrieval status:", token ? "Success" : "Failed");
            const normalizedPreviousVersion = method === 'docx'
                ? previousVersion
                : this.normalizePreviousVersion(previousVersion);
            const body = {
                contractId,
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
                ? joinApiUrl(API_BASE, '/api/docx/upload-async')
                : joinApiUrl(API_BASE, '/api/contracts/analyze');

            let fetchOptions = {
                method: 'POST',
                headers: {
                    'Authorization': token ? `Bearer ${token}` : ''
                }
            };

            if (method === 'docx') {
                const formData = new FormData();
                const safePreviousVersion = normalizeDocxPreviousVersionForForm(normalizedPreviousVersion);
                formData.append('contractId', contractId);
                formData.append('method', method);
                formData.append('previousVersion', safePreviousVersion);
                if (options.skipAI) formData.append('skipAI', 'true');

                // sourceがBase64文字列ならBlobに変換してファイルとして追加
                if (typeof source === 'string' && source.length > 0) {
                    try {
                        const blob = await base64ToDocxBlob(source);
                        formData.append('file', blob, 'document.docx');
                    } catch (e) {
                        console.error("AI Service: Failed to convert Base64 to Blob", e);
                        // 変換に失敗した場合はJSONフォールバックを試みるために既存のbodyに戻るか、エラーを投げる
                        throw new Error("ファイルの準備に失敗しました。");
                    }
                } else if (source instanceof File || source instanceof Blob) {
                    formData.append('file', source);
                }

                fetchOptions.body = formData;
            } else {
                fetchOptions.headers['Content-Type'] = 'application/json';
                fetchOptions.body = JSON.stringify(body);
            }

            // FormData送信時はブラウザにContent-Type（multipart boundary付き）を設定させる
            if (method === 'docx') {
                delete fetchOptions.headers['Content-Type'];
            }

            const response = await fetch(endpoint, fetchOptions);

            let result = null;
            try {
                result = await response.json();
            } catch {
                throw new Error(`APIレスポンスの解析に失敗しました (HTTP ${response.status})`);
            }

            if (!response.ok) {
                const apiError = new Error(result.error || result.message || `HTTP error! status: ${response.status}`);
                if (result.code) apiError.code = result.code;
                if (result.currentUsage !== undefined) apiError.currentUsage = result.currentUsage;
                if (result.limit !== undefined) apiError.limit = result.limit;
                if (result.plan !== undefined) apiError.plan = result.plan;
                if (result.nextPlan !== undefined) apiError.nextPlan = result.nextPlan;
                throw apiError;
            }

            if (result?.status === 'processing') {
                console.log("AI Service: Asynchronous processing started, polling for result...");
                return await this._pollContractStatusOnce(contractId, token);
            }

            // Normalize DOCX full-analysis response shape.
            // /contracts/upload-docx returns `articles`, while the app expects `extractedText`.
            if (result?.success && result?.data) {
                if (result.data.extractedText === undefined && Array.isArray(result.data.articles)) {
                    result.data.extractedText = result.data.articles;
                }
                if (result.data.extractedText === undefined && result.data.structuredContract !== undefined) {
                    result.data.extractedText = result.data.structuredContract;
                }
                // Unify summary key
                if (result.data.summary === undefined && result.data.changeSummary !== undefined) {
                    result.data.summary = result.data.changeSummary;
                }
            }
            if (method === 'docx' && result?.success && result?.data) {
                if (!result.data.sourceType) {
                    result.data.sourceType = 'DOCX';
                }
            }

            // Debug logs
            console.log("AI RESULT:", result);
            if (result?.data) {
                console.log("SUMMARY:", result.data.summary);
                console.log("SUCCESS:", result.success);
                console.log("LIMITED:", result.data.isLimited);
            }

            return result;

        } catch (error) {
            console.error('AI Service Error:', error);

            // ネットワークエラー・タイムアウトの場合
            if (error.message.includes('Failed to fetch') || error.message.includes('timeout') || error.message.includes('Timeout')) {
                throw new Error('取り込みに時間がかかりすぎました。もう一度お試しください。');
            }

            throw error;
        }
    },

    /**
     * Poll contract status until completion (Private)
     */
    async _pollContractStatusOnce(contractId, token) {
        const key = String(contractId);
        if (ACTIVE_CONTRACT_POLLS.has(key)) {
            return ACTIVE_CONTRACT_POLLS.get(key);
        }
        const pollPromise = this._pollContractStatus(contractId, token)
            .finally(() => ACTIVE_CONTRACT_POLLS.delete(key));
        ACTIVE_CONTRACT_POLLS.set(key, pollPromise);
        return pollPromise;
    },

    async _pollContractStatus(contractId, token, options = {}) {
        const apiBase = this.getApiBase();
        const pollOptions = {
            maxChecks: Number.isFinite(options.maxChecks) ? options.maxChecks : 40,
            initialDelayMs: Number.isFinite(options.initialDelayMs) ? options.initialDelayMs : 1500,
            maxDelayMs: Number.isFinite(options.maxDelayMs) ? options.maxDelayMs : 8000,
            maxConsecutiveErrors: Number.isFinite(options.maxConsecutiveErrors) ? options.maxConsecutiveErrors : 5,
            perRequestTimeoutMs: Number.isFinite(options.perRequestTimeoutMs) ? options.perRequestTimeoutMs : 12000
        };
        let checkCount = 0;
        let waitMs = pollOptions.initialDelayMs;
        let consecutiveErrors = 0;

        while (checkCount < pollOptions.maxChecks) {
            checkCount++;
            // Update loading UI if present in DOM
            const loadingMsg = document.getElementById('reg-loading');
            if (loadingMsg) {
                const subText = loadingMsg.querySelector('span');
                if (subText) {
                    const progress = Math.min(Math.floor((checkCount / pollOptions.maxChecks) * 95), 95);
                    subText.textContent = `AI解析を実行中... (${progress}%)`;
                }
            }

            await sleep(waitMs);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), pollOptions.perRequestTimeoutMs);
            try {
                const response = await fetch(joinApiUrl(apiBase, `/api/contracts/${contractId}`), {
                    headers: { 'Authorization': token ? `Bearer ${token}` : '' },
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (response.status === 401 || response.status === 403) {
                    const authError = new Error('認証の有効期限が切れました。再ログインしてください。');
                    authError.isTerminal = true;
                    throw authError;
                }

                if (response.ok) {
                    consecutiveErrors = 0;
                    const polled = await response.json();
                    const contract = polled.data;
                    if (contract) {
                        if (contract.status === 'completed') {
                            console.log("AI Service: Async analysis completed!");
                            // Return expected result shape
                            return {
                                success: true,
                                data: {
                                    summary: contract.ai_summary,
                                    riskLevel: contract.risk_level === 'High' ? 3 : (contract.risk_level === 'Medium' ? 2 : 1),
                                    riskReason: contract.ai_risk_reason,
                                    changes: contract.ai_changes,
                                    isFallback: contract.ai_is_fallback === true,
                                    extractedText: contract.sections,
                                    rawExtractedText: contract.original_content,
                                    doc: contract.doc || null,
                                    sourceType: 'DOCX',
                                    isLimited: contract.ai_limited === true
                                }
                            };
                        }
                        if (contract.status === 'error') {
                            const processingError = new Error(contract.errorMessage || 'AI解析中にエラーが発生しました');
                            processingError.isTerminal = true;
                            throw processingError;
                        }
                    }
                } else {
                    consecutiveErrors++;
                    console.warn(`Polling HTTP error ${response.status} (attempt ${checkCount})`);
                }
            } catch (e) {
                clearTimeout(timeoutId);
                if (e?.isTerminal) throw e;
                consecutiveErrors++;
                console.warn(`Polling error (attempt ${checkCount}):`, e);
            }

            if (consecutiveErrors >= pollOptions.maxConsecutiveErrors) {
                throw new Error('ステータス確認に連続で失敗しました。通信環境を確認して再試行してください。');
            }

            waitMs = Math.min(
                pollOptions.maxDelayMs,
                Math.round(waitMs * 1.45)
            );
        }
        throw new Error('解析の待ち時間がタイムアウトしました。しばらく待って再読み込みしてください。');
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
