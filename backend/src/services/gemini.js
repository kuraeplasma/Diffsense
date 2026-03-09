const axios = require('axios');
const logger = require('../utils/logger');
const Diff = require('diff');

// Gemini API Configuration
// NOTE: We use gemini-2.0-flash on the v1beta endpoint as gemini-1.5-flash is retired for this key.
// Do not revert to v1 or 1.5-flash without verifying account model availability.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

function extractCandidateText(payload) {
    const candidate = payload?.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (Array.isArray(parts)) {
        const text = parts
            .map((part) => (typeof part?.text === 'string' ? part.text : ''))
            .filter(Boolean)
            .join('\n')
            .trim();
        if (text) return text;
    }

    const promptFeedback = payload?.promptFeedback?.blockReason;
    const finishReason = candidate?.finishReason;
    if (promptFeedback || finishReason) {
        throw new Error(`Gemini returned no text (${promptFeedback || finishReason})`);
    }

    throw new Error('Gemini response text is empty');
}

function extractJsonText(rawText) {
    const cleanText = String(rawText || '')
        .replace(/^\uFEFF/, '')
        .replace(/```json/gi, '```')
        .replace(/```/g, '')
        .trim();
    const candidates = [
        [cleanText.indexOf('{'), cleanText.lastIndexOf('}')],
        [cleanText.indexOf('['), cleanText.lastIndexOf(']')]
    ];

    for (const [start, end] of candidates) {
        if (start !== -1 && end !== -1 && end > start) {
            return cleanText.substring(start, end + 1);
        }
    }

    throw new Error('Gemini response is not valid JSON');
}

function normalizeAnalyzeResult(parsed) {
    const riskLevelNum = Number(parsed?.riskLevel);
    return {
        changes: Array.isArray(parsed?.changes) ? parsed.changes : [],
        riskLevel: [1, 2, 3].includes(riskLevelNum) ? riskLevelNum : 1,
        riskReason: typeof parsed?.riskReason === 'string' ? parsed.riskReason : '',
        summary: typeof parsed?.summary === 'string' ? parsed.summary : '解析完了',
        isFallback: parsed?.isFallback === true
    };
}

function shouldUseLocalAiFallback() {
    return process.env.LOCAL_FAKE_AI === 'true' || process.env.LOCAL_AI_ONLY === 'true';
}

function extractSectionLabel(text) {
    const src = String(text || '').trim();
    if (!src) return '本文';
    const article = src.match(/^第\s*[0-9０-９一二三四五六七八九十百]+\s*条(?:\s*[（(【][^）)】]+[）)】]|\s+\S+)?/m);
    if (article) return article[0].trim();
    const firstLine = src.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return firstLine ? firstLine.slice(0, 40) : '本文';
}

function buildLocalSingleAnalysis(contractText) {
    const text = String(contractText || '').trim();
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const sections = lines.filter((line) => /^第\s*[0-9０-９一二三四五六七八九十百]+\s*条/.test(line));
    const preview = lines.slice(0, 3).join(' / ').slice(0, 160);
    return {
        changes: sections.slice(0, 5).map((section) => ({
            section,
            type: 'risk',
            old: section,
            new: '当該条項の文言を確認してください。',
            impact: '条項の要点を抽出しました',
            concern: '詳細なAI評価を取得できなかったため確認が必要です'
        })),
        riskLevel: 1,
        riskReason: 'AI評価を取得できなかったため補完要約を表示しています',
        summary: preview ? `補完要約: ${preview}` : '補完要約を表示しています',
        isFallback: true
    };
}

function buildLocalDiffAnalysis(currentText, previousText) {
    const lhs = String(previousText || '').trim();
    const rhs = String(currentText || '').trim();
    const section = extractSectionLabel(rhs || lhs);
    const chunks = Diff.diffWordsWithSpace(lhs, rhs);
    const added = chunks.filter((part) => part.added).map((part) => part.value).join('').trim();
    const removed = chunks.filter((part) => part.removed).map((part) => part.value).join('').trim();
    const summary = added || removed
        ? `${section} を含む差分を検出しました。変更点を確認してください。`
        : '目立つ変更は検出されませんでした。';

    return {
        changes: [{
            section,
            type: 'modification',
            old: removed || lhs.slice(0, 240),
            new: added || rhs.slice(0, 240),
            impact: '差分のある条項を抽出しました',
            concern: '要点の最終確認を推奨します'
        }],
        riskLevel: 1,
        riskReason: 'AI評価を取得できなかったため補完差分を表示しています',
        summary,
        isFallback: true
    };
}

function buildHeuristicFallbackAnalysis(currentText, previousText = null) {
    const base = previousText
        ? buildLocalDiffAnalysis(currentText, previousText)
        : buildLocalSingleAnalysis(currentText);
    return {
        ...base,
        riskReason: 'AI評価を一部補完表示しています',
        summary: String(base.summary || '補完解析を返しました')
            .replace(/^ローカル差分要約:/, '補完差分要約:')
            .replace(/^ローカル要約:/, '補完要約:'),
        isFallback: true
    };
}

function normalizeRiskLevelValue(value) {
    const numeric = Number(value);
    if ([1, 2, 3].includes(numeric)) return numeric;
    const label = String(value || '').trim().toUpperCase();
    if (label === 'HIGH') return 3;
    if (label === 'MEDIUM') return 2;
    if (label === 'LOW') return 1;
    return 1;
}

function normalizeStructuredChangeType(value, fallbackType = 'MODIFY') {
    const raw = String(value || '').trim().toUpperCase();
    if (raw === 'ADD' || raw === '追加') return 'ADD';
    if (raw === 'DELETE' || raw === '削除') return 'DELETE';
    if (raw === 'MODIFY' || raw === 'CHANGE' || raw === '修正' || raw === '変更') return 'MODIFY';
    return normalizeStructuredChangeType(fallbackType || 'MODIFY', 'MODIFY');
}

function truncateStructuredClauseText(text, maxLength = 2200) {
    const normalized = String(text || '').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}\n...[省略]`;
}

function normalizeStructuredDiffResult(parsed) {
    const rawResults = Array.isArray(parsed?.results)
        ? parsed.results
        : (Array.isArray(parsed?.changes) ? parsed.changes : []);
    const results = rawResults.map((item, index) => ({
        sectionId: String(item?.sectionId || item?.id || `CHG-${index}`).trim(),
        change: item?.change === true || String(item?.change || '').trim().toLowerCase() === 'true',
        summary: typeof item?.summary === 'string' ? item.summary.trim() : '',
        changeType: normalizeStructuredChangeType(item?.change_type || item?.changeType || item?.type),
        riskLevel: normalizeRiskLevelValue(item?.risk_level || item?.riskLevel),
        reason: typeof item?.reason === 'string' ? item.reason.trim() : ''
    })).filter((item) => item.sectionId);

    return {
        summary: typeof parsed?.summary === 'string' ? parsed.summary : '解析完了',
        riskLevel: normalizeRiskLevelValue(parsed?.riskLevel || parsed?.risk_level),
        riskReason: typeof parsed?.riskReason === 'string'
            ? parsed.riskReason
            : (typeof parsed?.reason === 'string' ? parsed.reason : ''),
        results
    };
}

function shouldRetryGeminiRequest(error) {
    const status = Number(error?.response?.status || 0);
    if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
    const message = String(error?.message || '');
    return /timeout|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(message);
}
class GeminiService {
    constructor() {
        if (!GEMINI_API_KEY) {
            logger.warn('GEMINI_API_KEY is not set. AI analysis will fail.');
        }
    }

    async analyzeContract(contractText, previousVersion = null) {
        const currentText = typeof contractText === 'string'
            ? contractText
            : JSON.stringify(contractText || '');
        const previousText = (previousVersion === null || previousVersion === undefined)
            ? null
            : (typeof previousVersion === 'string' ? previousVersion : JSON.stringify(previousVersion));

        if (shouldUseLocalAiFallback()) {
            if (!GEMINI_API_KEY || process.env.LOCAL_AI_ONLY === 'true') {
                logger.info('Using local AI fallback analysis');
                return previousText
                    ? buildLocalDiffAnalysis(currentText, previousText)
                    : buildLocalSingleAnalysis(currentText);
            }
        }

        if (!GEMINI_API_KEY) {
            throw new Error('Gemini API key is not configured');
        }

        const prompt = this.buildPrompt(currentText, previousText);
        logger.info('Starting Gemini analyzeContract request');

        try {
            const primary = await this.requestGeminiJson(prompt, true);
            return {
                ...normalizeAnalyzeResult(primary),
                isFallback: false
            };
        } catch (error) {
            logger.warn('Gemini analyzeContract primary request failed, retrying without JSON mime type:', error.message);
            try {
                const fallback = await this.requestGeminiJson(prompt, false);
                return {
                    ...normalizeAnalyzeResult(fallback),
                    isFallback: false
                };
            } catch (retryError) {
                logger.error('Gemini analyzeContract failed:', retryError);
            }
            if (shouldUseLocalAiFallback()) {
                logger.warn('Falling back to local AI analysis');
                return previousText
                    ? buildLocalDiffAnalysis(currentText, previousText)
                    : buildLocalSingleAnalysis(currentText);
            }
            logger.warn('Returning heuristic fallback analysis instead of AI failure');
            return buildHeuristicFallbackAnalysis(currentText, previousText);
        }
    }

    async requestGeminiJson(prompt, enforceJsonMime = true) {
        const body = {
            contents: [{
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 2048
            }
        };

        if (enforceJsonMime) {
            body.generationConfig.responseMimeType = 'application/json';
        }

        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const response = await axios.post(
                    `${GEMINI_ENDPOINT}?key=${GEMINI_API_KEY}`,
                    body,
                    {
                        timeout: 90000,
                        headers: {
                            'Content-Type': 'application/json',
                            'Referer': 'https://diffsense.spacegleam.co.jp'
                        }
                    }
                );

                const aiText = extractCandidateText(response?.data);
                const jsonText = extractJsonText(aiText);
                return JSON.parse(jsonText);
            } catch (error) {
                lastError = error;
                if (attempt >= 2 || !shouldRetryGeminiRequest(error)) {
                    break;
                }
                const waitMs = 1200 * (attempt + 1);
                logger.warn(`Gemini request retry ${attempt + 1}/2 after ${waitMs}ms: ${error.message}`);
                await new Promise((resolve) => setTimeout(resolve, waitMs));
            }
        }

        throw lastError || new Error('Gemini request failed');
    }

    /**
     * Analyze a structured set of changes (Article-based)
     * @param {Array} changes - Array from DiffService.compare
     */
    async analyzeStructuredDiff(changes) {
        if (shouldUseLocalAiFallback() && (!GEMINI_API_KEY || process.env.LOCAL_AI_ONLY === 'true')) {
            return {
                summary: 'AI差分要約を取得できませんでした。再解析を実行してください。',
                riskLevel: 1,
                riskReason: 'AI差分要約未取得',
                results: [],
                isFallback: true
            };
        }
        if (!GEMINI_API_KEY) {
            throw new Error('Gemini API key is not configured');
        }

        const modifiedChanges = changes.filter(c => c.type !== 'UNTOUCHED').slice(0, 15); // limit to prioritized changes
        const prompt = this.buildStructuredDiffPrompt(modifiedChanges);

        logger.info(`Analyzing structured diff with ${modifiedChanges.length} prioritized changes`);

        try {
            const primary = await this.requestGeminiJson(prompt, true);
            const result = normalizeStructuredDiffResult(primary);

            return {
                summary: result.summary || '解析完了',
                riskLevel: result.riskLevel || 1,
                riskReason: result.riskReason || '',
                results: result.results,
                isFallback: false
            };
        } catch (error) {
            logger.warn('Structured AI analysis primary request failed, retrying without JSON mime type:', error.message);
            try {
                const fallback = await this.requestGeminiJson(prompt, false);
                const result = normalizeStructuredDiffResult(fallback);
                return {
                    summary: result.summary || '解析完了',
                    riskLevel: result.riskLevel || 1,
                    riskReason: result.riskReason || '',
                    results: result.results,
                    isFallback: false
                };
            } catch (retryError) {
                logger.error('Structured AI analysis failed:', retryError);
            }
            if (shouldUseLocalAiFallback()) {
                return {
                    summary: 'AI差分要約を取得できませんでした。再解析を実行してください。',
                    riskLevel: 1,
                    riskReason: 'AI差分要約未取得',
                    results: [],
                    isFallback: true
                };
            }
            return {
                summary: 'AI差分要約を取得できませんでした。再解析を実行してください。',
                riskLevel: 1,
                riskReason: 'AI差分要約未取得',
                results: [],
                isFallback: true
            };
        }
    }

    buildStructuredDiffPrompt(changes) {
        const changesText = changes.map((c, i) => {
            return `---
Change ID: CHG-${i}
条文名: ${c.section}
旧条文:
${truncateStructuredClauseText(c.old)}

新条文:
${truncateStructuredClauseText(c.new)}
---`;
        }).join('\n');

        return `あなたは契約書レビュー専門AIです。

以下の旧契約条文と新契約条文のペアごとに、契約内容に実質的な変更があるかを評価してください。

重要
- 文字差分ではなく「契約上の意味差分」を評価してください。
- 旧条文と新条文の意味が同じ場合、差分が存在しても "change": false と判定してください。
- 誤字修正、表記揺れ、日付変更のみ、バージョン番号変更、改行、スペース、句読点変更、同義語変更、条文番号変更のみ、タイトル変更のみは変更として扱わないでください。
- 権利義務の変更、金額変更、支払条件変更、責任範囲変更、契約解除条件変更、再委託条件変更、知的財産権変更、競業避止変更、保証範囲変更、損害賠償条件変更、納期変更、数量変更は変更として扱ってください。

各条文について次の手順で評価してください。
1. 旧条文の意味を要約
2. 新条文の意味を要約
3. 両者の意味を比較
4. 契約上の法的効果が変わるか判断

${changesText}

以下のJSON形式で回答してください。JSON以外は出力しないでください。
{
  "summary": "契約全体で実質的に変わった内容を2-3文で要約。実質変更がない場合は『実質的な契約変更は検出されませんでした。』",
  "riskLevel": 1,
  "riskReason": "契約全体への影響を簡潔に記載。実質変更がない場合は『契約上の意味変更はありません。』",
  "results": [
    {
      "sectionId": "CHG-0",
      "change": true,
      "summary": "変更内容の要約",
      "change_type": "追加",
      "risk_level": "HIGH",
      "reason": "契約上の影響"
    },
    {
      "sectionId": "CHG-1",
      "change": false
    }
  ]
}

重要:
- riskLevel は 1-3 で返してください。
- change_type は 追加 / 削除 / 修正 のいずれかにしてください。
- risk_level は HIGH / MEDIUM / LOW のいずれかにしてください。
- 実質変更がない条文は "change": false のみ返してください。
- Markdownコードブロック、説明文、前置きは禁止です。`;
    }

    buildPrompt(contractText, previousVersion) {
        // Truncate text if too long (Gemini has token limits)
        const maxLength = 30000;
        const truncatedText = contractText.length > maxLength
            ? contractText.substring(0, maxLength) + '\n\n[...テキストが長すぎるため省略されました]'
            : contractText;

        if (previousVersion) {
            const truncatedPrev = previousVersion.length > maxLength
                ? previousVersion.substring(0, maxLength) + '\n\n[...テキストが長すぎるため省略されました]'
                : previousVersion;

            return `あなたは契約書の差分解析の専門家です。以下の2つの契約書を比較し、変更点を抽出してください。

【旧バージョン】
${truncatedPrev}

【新バージョン】
${truncatedText}

以下のJSON形式で回答してください（JSONのみを出力し、説明文は不要です）:
{
  "changes": [
    {
      "section": "条項名",
      "type": "modification",
      "old": "変更前の文言",
      "new": "変更後の文言",
      "impact": "この変更による法的な影響や拘束力の変化（50文字以内）",
      "concern": "この変更におけるリスクや注意点（ない場合は'特になし'）"
    }
  ],
  "riskLevel": 3,
  "riskReason": "リスク判定の理由を簡潔に（100文字以内）",
  "summary": "変更の要約を3行以内で"
}

重要: Markdownのコードブロック（\`\`\`jsonなど）は絶対に含めず、純粋なJSONテキストのみを出力してください。コメントや解説も不要です。
riskLevelは1（低リスク）、2（中リスク）、3（高リスク）のいずれかを設定してください。`;
        } else {
            return `あなたは契約書の解析の専門家です。以下の契約書を解析し、重要なリスク要因や注意すべき条項を抽出してください。

【契約書】
${truncatedText}

以下のJSON形式で回答してください（JSONのみを出力し、説明文は不要です）:
{
  "changes": [
    {
      "section": "該当する条項名",
      "type": "risk",
      "old": "注意すべき条文（原文を引用）",
      "new": "リスクの内容や推奨される修正案",
      "impact": "この条項による法的な影響（50文字以内）",
      "concern": "この条項におけるリスクや注意点"
    }
  ],
  "riskLevel": 2,
  "riskReason": "リスク判定の理由を簡潔に（100文字以内）",
  "summary": "契約書の要約とリスク概要を3行以内で"
}

重要:
- changesには、リスクが高い条項や注意すべき条項を最大5つまで抽出してください。リスクがない場合は空配列にしてください。
- riskLevelは1（低リスク）、2（中リスク）、3（高リスク）のいずれかを設定してください。`;
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = new GeminiService();
