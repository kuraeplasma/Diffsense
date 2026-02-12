const axios = require('axios');
const logger = require('../utils/logger');

// Gemini API Configuration
// NOTE: We use gemini-2.0-flash on the v1beta endpoint as gemini-1.5-flash is retired for this key.
// Do not revert to v1 or 1.5-flash without verifying account model availability.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

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

        const prompt = this.buildPrompt(contractText, previousVersion);

        logger.info(`Analyzing contract text (length: ${contractText.length}): ${contractText.substring(0, 100)}...`);
        if (previousVersion) {
            logger.info(`Comparing with previous version (length: ${previousVersion.length}): ${previousVersion.substring(0, 100)}...`);
        }

        try {
            logger.info('Calling Gemini API for contract analysis');

            const response = await axios.post(
                `${GEMINI_ENDPOINT}?key=${GEMINI_API_KEY}`,
                {
                    contents: [{
                        parts: [{ text: prompt }]
                    }],
                    generationConfig: {
                        temperature: 0.2,
                        maxOutputTokens: 2048,
                        topP: 0.8,
                        topK: 40,
                        responseMimeType: 'application/json'
                    },
                    safetySettings: [
                        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
                    ]
                },
                {
                    timeout: 120000, // Keep increased timeout (120s)
                    headers: { 'Content-Type': 'application/json' }
                }
            );

            if (!response.data.candidates || response.data.candidates.length === 0) {
                throw new Error('No response from Gemini API');
            }

            const aiText = response.data.candidates[0].content.parts[0].text;
            logger.debug('Gemini API response received');

            // Extract JSON from response
            let cleanText = aiText.replace(/```json/g, '').replace(/```/g, '');
            const firstOpen = cleanText.indexOf('{');
            const lastClose = cleanText.lastIndexOf('}');

            if (firstOpen === -1 || lastClose === -1 || firstOpen >= lastClose) {
                logger.error('Invalid AI response format:', aiText);
                throw new Error('AI response does not contain valid JSON');
            }

            const jsonStr = cleanText.substring(firstOpen, lastClose + 1);
            let result;
            try {
                result = JSON.parse(jsonStr);
            } catch (parseError) {
                logger.error('JSON Parse Error:', parseError);
                throw new Error('Failed to parse AI response as JSON');
            }

            // Validate result structure
            if (typeof result.riskLevel !== 'number') result.riskLevel = 1;
            if (!result.riskReason) result.riskReason = '解析結果が不完全です';
            if (!result.summary) result.summary = '契約書の解析が完了しました';
            if (!result.changes) result.changes = [];

            logger.info('Gemini API analysis completed successfully');
            return result;

        } catch (error) {
            if (error.response) {
                logger.error(`Gemini API Error: status=${error.response.status} data=${JSON.stringify(error.response.data).substring(0, 500)}`);
            } else {
                logger.error(`Gemini Analysis Failed: ${error.message}`);
            }

            // Fallback: Return specific structure so frontend can still show text
            return {
                summary: "AI解析に失敗しました（テキスト抽出のみ完了）",
                riskLevel: 1,
                riskReason: "AI解析サーバーからの応答がありませんでした。",
                changes: []
            };
        }
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
