const axios = require('axios');
const logger = require('../utils/logger');

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
    const firstOpen = cleanText.indexOf('{');
    const lastClose = cleanText.lastIndexOf('}');
    if (firstOpen === -1 || lastClose === -1 || lastClose <= firstOpen) {
        throw new Error('Gemini response is not valid JSON');
    }
    return cleanText.substring(firstOpen, lastClose + 1);
}

function normalizeAnalyzeResult(parsed) {
    const riskLevelNum = Number(parsed?.riskLevel);
    return {
        changes: Array.isArray(parsed?.changes) ? parsed.changes : [],
        riskLevel: [1, 2, 3].includes(riskLevelNum) ? riskLevelNum : 1,
        riskReason: typeof parsed?.riskReason === 'string' ? parsed.riskReason : '',
        summary: typeof parsed?.summary === 'string' ? parsed.summary : '解析完了'
    };
}

class GeminiService {
    constructor() {
        if (!GEMINI_API_KEY) {
            logger.warn('GEMINI_API_KEY is not set. AI analysis will fail.');
        }
    }

    async analyzeContract(contractText, previousVersion = null) {
        if (!GEMINI_API_KEY) {
            throw new Error('Gemini API key is not configured');
        }

        const currentText = typeof contractText === 'string'
            ? contractText
            : JSON.stringify(contractText || '');
        const previousText = (previousVersion === null || previousVersion === undefined)
            ? null
            : (typeof previousVersion === 'string' ? previousVersion : JSON.stringify(previousVersion));

        const prompt = this.buildPrompt(currentText, previousText);
        logger.info('Starting Gemini analyzeContract request');

        try {
            const primary = await this.requestGeminiJson(prompt, true);
            return normalizeAnalyzeResult(primary);
        } catch (error) {
            logger.warn('Gemini analyzeContract primary request failed, retrying without JSON mime type:', error.message);
            try {
                const fallback = await this.requestGeminiJson(prompt, false);
                return normalizeAnalyzeResult(fallback);
            } catch (retryError) {
                logger.error('Gemini analyzeContract failed:', retryError);
            }
            return {
                changes: [],
                riskLevel: 1,
                riskReason: 'AIサービスとの通信に失敗しました',
                summary: 'AI解析に失敗しました'
            };
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
    }

    /**
     * Analyze a structured set of changes (Article-based)
     * @param {Array} changes - Array from DiffService.compare
     */
    async analyzeStructuredDiff(changes) {
        if (!GEMINI_API_KEY) {
            throw new Error('Gemini API key is not configured');
        }

        const modifiedChanges = changes.filter(c => c.type !== 'UNTOUCHED').slice(0, 15); // limit to prioritized changes
        const prompt = this.buildStructuredDiffPrompt(modifiedChanges);

        logger.info(`Analyzing structured diff with ${modifiedChanges.length} prioritized changes`);

        try {
            const response = await axios.post(
                `${GEMINI_ENDPOINT}?key=${GEMINI_API_KEY}`,
                {
                    contents: [{
                        parts: [{ text: prompt }]
                    }],
                    generationConfig: {
                        temperature: 0.1,
                        maxOutputTokens: 2048,
                        responseMimeType: 'application/json'
                    }
                },
                {
                    timeout: 60000,
                    headers: {
                        'Content-Type': 'application/json',
                        'Referer': 'https://diffsense.spacegleam.co.jp'
                    }
                }
            );

            const aiText = response.data.candidates[0].content.parts[0].text;
            let cleanText = aiText.replace(/```json/g, '').replace(/```/g, '');
            const firstOpen = cleanText.indexOf('{');
            const lastClose = cleanText.lastIndexOf('}');
            const jsonStr = cleanText.substring(firstOpen, lastClose + 1);

            const result = JSON.parse(jsonStr);

            // Merge AI insights back into changes
            const analyzerMap = {};
            if (result.insights) {
                result.insights.forEach(ins => {
                    analyzerMap[ins.sectionId] = ins;
                });
            }

            return {
                summary: result.summary || '解析完了',
                riskLevel: result.riskLevel || 1,
                riskReason: result.riskReason || '',
                insights: analyzerMap
            };
        } catch (error) {
            logger.error('Structured AI analysis failed:', error);
            return {
                summary: 'AI分析に失敗しました',
                riskLevel: 1,
                riskReason: 'AIサービスとの通信に失敗しました',
                insights: {}
            };
        }
    }

    buildStructuredDiffPrompt(changes) {
        const changesText = changes.map((c, i) => {
            return `---
Change ID: CHG-${i}
Section: ${c.section}
Type: ${c.type}
Old Content: ${c.old}
New Content: ${c.new}
---`;
        }).join('\n');

        return `あなたは契約書の専門家です。以下の契約書の変更リストを解析し、法的なリスクと要約を提示してください。

${changesText}

以下のJSON形式で回答してください:
{
  "summary": "契約全体の変更概要（3行以内）",
  "riskLevel": 3,
  "riskReason": "最も高いリスクの根拠",
  "insights": [
    {
      "sectionId": "CHG-0",
      "impact": "この変更の法的影響（50文字以内）",
      "concern": "具体的な懸念点やリスク（ない場合は'特になし'）",
      "recommendation": "推奨される対応"
    }
  ]
}

重要:
- riskLevelは1-3。
- 各変更点に対して、専門的な視点でimpactとconcernを詳しく説明してください。`;
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
