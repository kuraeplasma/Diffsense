const axios = require('axios');
const logger = require('../utils/logger');
const Diff = require('diff');

// Gemini API Configuration
// NOTE: We use gemini-2.0-flash on the v1beta endpoint as it is faster and more reliable.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

if (GEMINI_API_KEY) {
    logger.info(`GEMINI_API_KEY is configured (starts with ${GEMINI_API_KEY.slice(0, 4)}...)`);
} else {
    logger.warn('GEMINI_API_KEY is NOT configured in environment.');
}

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

/**
 * Robust JSON extraction from LLM output.
 */
function extractJsonText(rawText) {
    const src = String(rawText || '').trim();

    // Attempt to find the largest matching balanced { } or [ ] block
    // but first, look for markdown code blocks if they exist anywhere
    const codeBlockMatch = src.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const targetText = codeBlockMatch ? codeBlockMatch[1].trim() : src;

    const startIdx = targetText.indexOf('{');
    const endIdx = targetText.lastIndexOf('}');

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        return targetText.substring(startIdx, endIdx + 1).trim();
    }

    const startArrIdx = targetText.indexOf('[');
    const endArrIdx = targetText.lastIndexOf(']');
    if (startArrIdx !== -1 && endArrIdx !== -1 && endArrIdx > startArrIdx) {
        return targetText.substring(startArrIdx, endArrIdx + 1).trim();
    }

    throw new Error('Gemini response contains no JSON block');
}

function escapeNewlinesInsideStrings(text) {
    let result = '';
    let inString = false;
    let escaping = false;

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            if (escaping) {
                result += ch;
                escaping = false;
                continue;
            }
            if (ch === '\\') {
                result += ch;
                escaping = true;
                continue;
            }
            if (ch === '"') {
                result += ch;
                inString = false;
                continue;
            }
            if (ch === '\r') {
                if (text[i + 1] === '\n') {
                    i += 1;
                }
                result += '\\n';
                continue;
            }
            if (ch === '\n') {
                result += '\\n';
                continue;
            }
            result += ch;
            continue;
        }

        if (ch === '"') {
            inString = true;
        }
        result += ch;
    }

    return result;
}

function normalizeJsonLikeText(text) {
    return String(text || '')
        .replace(/^\uFEFF/, '')
        // Clean smart quotes
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, '\'')
        // Remove trailing commas before closing braces
        .replace(/,\s*([}\]])/g, '$1')
        // Try to fix some common LLM JSON errors
        .replace(/:\s*undefined/g, ': null')
        .replace(/:\s*NaN/g, ': null');
}

/**
 * Last ditch effort to extract fields if JSON.parse fails even after cleanup.
 */
function salvageAnalyzeJson(text) {
    const source = String(text || '');

    // Helper to extract field value via regex (support optional double quotes around field names)
    const getField = (fieldName) => {
        const re = new RegExp(`"?${fieldName}"?\\s*:\\s*"([\\s\\S]*?)"(?=\\s*[,}])`, 'i');
        const match = source.match(re);
        if (match) return match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim();

        // Try without trailing comma/brace for the very last field
        const reLast = new RegExp(`"?${fieldName}"?\\s*:\\s*"([\\s\\S]*?)"\\s*$`, 'i');
        const matchLast = source.match(reLast);
        return matchLast ? matchLast[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim() : null;
    };

    // Special handling for riskLevel which might be numeric
    const riskLevelMatch = source.match(/"riskLevel"\s*:\s*("?)([123]|LOW|MEDIUM|HIGH)\1/i);

    const parsed = {
        changes: [],
        riskLevel: riskLevelMatch ? riskLevelMatch[2] : 1,
        riskReason: getField('riskReason') || '',
        summary: getField('summary') || ''
    };

    // Extract changes array block if possible
    const changesMatch = source.match(/"changes"\s*:\s*\[([\s\S]*?)\]\s*(?:,|\})/i);
    if (changesMatch) {
        // We won't try to perfectly parse the nested array here, 
        // as this is a last-ditch salvage. 
        // But we want at least summary and riskLevel.
    }

    if (!parsed.summary && !parsed.riskReason) {
        throw new Error('Gemini response could not be salvaged via regex');
    }

    return parsed;
}

function parseGeminiJsonResponse(aiText) {
    const jsonText = extractJsonText(aiText);
    const attempts = [
        () => JSON.parse(jsonText),
        () => JSON.parse(normalizeJsonLikeText(jsonText)),
        () => JSON.parse(normalizeJsonLikeText(escapeNewlinesInsideStrings(jsonText))),
        () => salvageAnalyzeJson(jsonText)
    ];

    let lastError = null;
    for (const attempt of attempts) {
        try {
            return attempt();
        } catch (error) {
            lastError = error;
        }
    }

    logger.error('Gemini JSON parse failed after all attempts.');
    logger.error(`Raw AI response: ${aiText}`);
    logger.error(`Extracted segment: ${jsonText}`);
    throw lastError || new Error('Gemini response JSON parse failed');
}

function normalizeChanges(rawChanges) {
    const changes = Array.isArray(rawChanges) ? rawChanges : [];
    return changes.map(c => ({
        section: String(c?.section || c?.clause || '本文').trim() || '本文',
        type: String(c?.type || c?.changeType || 'modification').toLowerCase(),
        old: String(c?.old || c?.before || c?.originalText || '').trim(),
        new: String(c?.new || c?.after || c?.proposal || c?.modifiedText || '').trim(),
        impact: String(c?.impact || c?.benefit || '').trim(),
        concern: String(c?.concern || c?.risk || '').trim(),
        reason: String(c?.issue || c?.reason || c?.description || '').trim()
    }));
}

function normalizeAnalyzeResult(parsed) {
    // 1. Normalize summary (優先順位: summary > changeSummary > fallback)
    const summary = String(parsed?.summary || parsed?.changeSummary || parsed?.change_summary || '').trim() || '解析完了';

    // 2. Normalize riskLevel (1, 2, 3 の文字列)
    const rawLevel = parsed?.riskLevel || parsed?.risk_level || parsed?.risk;
    let riskLevel = "1";
    const levelNum = Number(rawLevel);
    if ([1, 2, 3].includes(levelNum)) {
        riskLevel = String(levelNum);
    } else if (typeof rawLevel === 'string') {
        const val = rawLevel.toUpperCase();
        if (val.includes('HIGH') || val === '3') riskLevel = "3";
        else if (val.includes('MEDIUM') || val === '2') riskLevel = "2";
    }

    // 3. Normalize riskReason
    const riskReason = String(parsed?.riskReason || parsed?.risk_reason || parsed?.latestRegulatoryAlignment || parsed?.latest_regulatory_alignment || '').trim() || '主要な注意点を確認してください。';

    // 4. Normalize changes (新形式: suggestions / 旧形式: changes)
    const rawChanges = parsed?.suggestions || parsed?.changes || parsed?.materialChanges || parsed?.material_changes || parsed?.risks || parsed?.items;
    const changes = Array.isArray(rawChanges) ? rawChanges : [];

    // needs_revision=false の場合はriskLevelを1に下げる
    if (parsed?.needs_revision === false && riskLevel !== "1") riskLevel = "1";

    // 状態判定フラグ
    const isFallback = parsed?.isFallback === true;
    const isLimited = parsed?.isLimited === true;
    
    // aiSucceeded: 
    // - フォールバックでなく、かつサマリーがエラー文言でない場合に true
    const aiSucceeded = !isFallback && summary.length > 0 && 
                        !/AI解析に失敗しました|エラーが発生しました|取得できませんでした/.test(summary);

    return {
        success: true, // APIとしての成功
        aiSucceeded: aiSucceeded,
        isLimited: isLimited,
        summary,
        riskLevel,
        riskReason,
        changes,
        isFallback,
    };
}

function normalizeIsoDate(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (/^(null|undefined|なし|不明|-|N\/A)$/i.test(raw)) return null;

    const ymd = raw.match(/^(\d{4})[\/\-.年]\s*(\d{1,2})[\/\-.月]\s*(\d{1,2})日?$/);
    if (ymd) {
        const y = Number(ymd[1]);
        const m = Number(ymd[2]);
        const d = Number(ymd[3]);
        if (y >= 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
            return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        }
    }

    const dt = new Date(raw);
    if (Number.isNaN(dt.getTime())) return null;
    const y = dt.getFullYear();
    const m = dt.getMonth() + 1;
    const d = dt.getDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function normalizeNoticePeriodDays(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value >= 0 ? Math.round(value) : null;
    }
    const raw = String(value).trim();
    if (!raw) return null;
    const direct = Number(raw);
    if (Number.isFinite(direct) && direct >= 0) {
        return Math.round(direct);
    }
    const matched = raw.match(/(\d{1,4})\s*(日|営業日|週間|週|か月|ヶ月|ヵ月|月|年)/);
    if (!matched) return null;
    const n = Number(matched[1]);
    if (!Number.isFinite(n) || n < 0) return null;
    const unit = matched[2];
    if (unit === '年') return n * 365;
    if (unit === 'か月' || unit === 'ヶ月' || unit === 'ヵ月' || unit === '月') return n * 30;
    if (unit === '週間' || unit === '週') return n * 7;
    return n;
}

function normalizeAutoRenewal(value) {
    if (typeof value === 'boolean') return value;
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return null;
    if (['true', 'yes', 'y', '1', 'あり', '有', '自動更新あり'].includes(raw)) return true;
    if (['false', 'no', 'n', '0', 'なし', '無', '自動更新なし'].includes(raw)) return false;
    return null;
}

function normalizeDateConfidence(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return 'unknown';
    if (raw === 'high') return 'high';
    if (raw === 'medium' || raw === 'partial') return 'medium';
    if (raw === 'low') return 'low';
    return 'unknown';
}

function toUtcDate(isoDate) {
    const matched = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!matched) return null;
    const y = Number(matched[1]);
    const m = Number(matched[2]);
    const d = Number(matched[3]);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return Number.isNaN(dt.getTime()) ? null : dt;
}

function formatUtcDate(dt) {
    if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return null;
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function shiftIsoDate(isoDate, deltaDays) {
    const base = toUtcDate(isoDate);
    if (!base || !Number.isFinite(deltaDays)) return null;
    base.setUTCDate(base.getUTCDate() + Math.round(deltaDays));
    return formatUtcDate(base);
}

function daysBetweenIsoDates(startIso, endIso) {
    const start = toUtcDate(startIso);
    const end = toUtcDate(endIso);
    if (!start || !end) return null;
    const diff = Math.round((end.getTime() - start.getTime()) / 86400000);
    return Number.isFinite(diff) ? diff : null;
}

function normalizeContractMeta(rawMeta) {
    if (!rawMeta || typeof rawMeta !== 'object') return null;

    const normalized = {
        expiry_date: normalizeIsoDate(rawMeta.expiry_date || rawMeta.expiryDate || rawMeta.end_date),
        renewal_deadline: normalizeIsoDate(rawMeta.renewal_deadline || rawMeta.renewalDeadline || rawMeta.notice_deadline),
        contract_start: normalizeIsoDate(rawMeta.contract_start || rawMeta.contractStart || rawMeta.start_date),
        auto_renewal: normalizeAutoRenewal(rawMeta.auto_renewal),
        notice_period_days: normalizeNoticePeriodDays(rawMeta.notice_period_days || rawMeta.noticePeriodDays),
        contract_category: String(rawMeta.contract_category || rawMeta.contractCategory || '').trim() || null,
        date_confidence: normalizeDateConfidence(rawMeta.date_confidence || rawMeta.dateConfidence),
        contract_amount: String(rawMeta.contract_amount || rawMeta.contractAmount || '').trim() || null,
        parties: String(rawMeta.parties || '').trim() || null
    };

    if (!normalized.renewal_deadline && normalized.expiry_date && normalized.notice_period_days !== null) {
        normalized.renewal_deadline = shiftIsoDate(normalized.expiry_date, -normalized.notice_period_days);
    }

    if (normalized.notice_period_days === null && normalized.renewal_deadline && normalized.expiry_date) {
        const diffDays = daysBetweenIsoDates(normalized.renewal_deadline, normalized.expiry_date);
        if (Number.isFinite(diffDays) && diffDays >= 0 && diffDays <= 3660) {
            normalized.notice_period_days = diffDays;
        }
    }

    if (
        normalized.date_confidence === 'unknown'
        && (normalized.expiry_date || normalized.renewal_deadline || normalized.contract_start)
    ) {
        normalized.date_confidence = 'medium';
    }

    return normalized;
}

function hasMeaningfulContractMeta(meta) {
    if (!meta || typeof meta !== 'object') return false;
    return Boolean(
        meta.expiry_date
        || meta.renewal_deadline
        || meta.contract_start
        || meta.contract_category
        || meta.notice_period_days !== null
        || typeof meta.auto_renewal === 'boolean'
    );
}

function mergeContractMeta(baseMeta, incomingMeta) {
    const base = normalizeContractMeta(baseMeta) || normalizeContractMeta({});
    const incoming = normalizeContractMeta(incomingMeta);
    if (!incoming) return base;

    const merged = { ...base };
    if (!merged.expiry_date && incoming.expiry_date) merged.expiry_date = incoming.expiry_date;
    if (!merged.renewal_deadline && incoming.renewal_deadline) merged.renewal_deadline = incoming.renewal_deadline;
    if (!merged.contract_start && incoming.contract_start) merged.contract_start = incoming.contract_start;
    if (merged.auto_renewal === null && typeof incoming.auto_renewal === 'boolean') merged.auto_renewal = incoming.auto_renewal;
    if (merged.notice_period_days === null && incoming.notice_period_days !== null) merged.notice_period_days = incoming.notice_period_days;
    if (!merged.contract_category && incoming.contract_category) merged.contract_category = incoming.contract_category;
    if ((merged.date_confidence || 'unknown') === 'unknown' && incoming.date_confidence && incoming.date_confidence !== 'unknown') {
        merged.date_confidence = incoming.date_confidence;
    }
    return normalizeContractMeta(merged);
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
    const changes = sections.slice(0, 5).map((section) => ({
        section,
        type: 'risk',
        old: section,
        new: '当該条項の文言を確認してください。',
        impact: '要点を簡易的に抽出しました',
        concern: 'AIサービスへの接続が制限されている、または解析エラーのため簡易表示となっています。'
    }));

    return normalizeAnalyzeResult({
        changes,
        riskLevel: 1,
        riskReason: 'AI評価を取得できなかったため補完要約を表示しています',
        summary: preview ? `補完要約: ${preview}` : '補完要約を表示しています',
        isFallback: true
    });
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

    return normalizeAnalyzeResult({
        changes: [{
            section,
            type: 'modification',
            old: removed || lhs.slice(0, 240),
            new: added || rhs.slice(0, 240),
            impact: '差分のある条項を抽出しました',
            concern: 'AI解析に失敗したため、プログラム的なテキスト比較結果を表示しています。詳細な法的影響は個別にご確認ください。'
        }],
        riskLevel: 1,
        riskReason: 'AI評価を取得できなかったため補完差分を表示しています',
        summary,
        isFallback: true
    });
}

function buildHeuristicFallbackAnalysis(currentText, previousText = null) {
    const base = previousText
        ? buildLocalDiffAnalysis(currentText, previousText)
        : buildLocalSingleAnalysis(currentText);
    
    return normalizeAnalyzeResult({
        ...base,
        riskReason: 'AI評価を一部補完表示しています',
        summary: String(base.summary || '補完解析を返しました')
            .replace(/^ローカル差分要約:/, '補完差分要約:')
            .replace(/^ローカル要約:/, '補完要約:'),
        isFallback: true
    });
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

function riskLevelToLabel(value) {
    const level = normalizeRiskLevelValue(value);
    if (level >= 3) return 'HIGH';
    if (level === 2) return 'MEDIUM';
    return 'LOW';
}

function buildSemanticDiffCandidate(oldText, newText, maxLength = 1600) {
    const lhs = String(oldText || '').trim();
    const rhs = String(newText || '').trim();
    if (!lhs && !rhs) return '差分候補なし';

    const chunks = Diff.diffWordsWithSpace(lhs, rhs);
    const parts = chunks.map((chunk) => {
        const text = String(chunk.value || '').replace(/\s+/g, ' ').trim();
        if (!text) return '';
        if (chunk.removed) return `[-${text}-]`;
        if (chunk.added) return `{+${text}+}`;
        return text.length > 40 ? `${text.slice(0, 40)}...` : text;
    }).filter(Boolean);

    const candidate = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (!candidate) return '差分候補なし';
    return candidate.length > maxLength
        ? `${candidate.slice(0, maxLength)} ...[省略]`
        : candidate;
}

function normalizeStructuredClauseResult(parsed, index) {
    const change = parsed?.change === true || String(parsed?.change || '').trim().toLowerCase() === 'true';
    const sectionId = `CHG-${index}`;
    if (!change) {
        return {
            sectionId,
            change: false,
            summary: '',
            riskLevel: 1,
            risk: 'LOW'
        };
    }

    const riskLevel = normalizeRiskLevelValue(parsed?.risk || parsed?.risk_level || parsed?.riskLevel);
    return {
        sectionId,
        change: true,
        summary: typeof parsed?.summary === 'string' && parsed.summary.trim()
            ? parsed.summary.trim()
            : '変更内容を確認してください。',
        riskLevel,
        risk: riskLevelToLabel(riskLevel)
    };
}

function buildStructuredResultsSummary(results, changes) {
    const changedResults = results.filter((item) => item?.change === true);
    if (changedResults.length === 0) {
        return '実質的な契約変更は検出されませんでした。';
    }

    const snippets = changedResults
        .slice(0, 3)
        .map((item) => item.summary)
        .filter(Boolean);
    if (snippets.length > 0) {
        const suffix = changedResults.length > snippets.length
            ? ` ほか${changedResults.length - snippets.length}件の変更があります。`
            : '';
        return `${snippets.join(' ')}${suffix}`.trim();
    }

    const labels = changedResults
        .slice(0, 3)
        .map((item) => {
            const index = Number(String(item.sectionId || '').replace('CHG-', ''));
            return changes[index]?.section || '';
        })
        .filter(Boolean);
    const suffix = changedResults.length > labels.length
        ? ` ほか${changedResults.length - labels.length}件。`
        : '';
    return labels.length > 0
        ? `${labels.join('、')} に契約上の変更があります。${suffix}`.trim()
        : '契約上の変更を検出しました。';
}

function buildStructuredResultsRiskReason(results) {
    const changedResults = results.filter((item) => item?.change === true);
    if (changedResults.length === 0) {
        return '契約上の意味変更はありません。';
    }

    const highestRisk = Math.max(...changedResults.map((item) => normalizeRiskLevelValue(item.riskLevel)));
    if (highestRisk >= 3) return '高リスクの契約変更を検出しました。条件変更の影響を確認してください。';
    if (highestRisk === 2) return '契約条件に影響する変更を検出しました。主要条文を確認してください。';
    return '軽微な契約変更を検出しました。変更内容を確認してください。';
}

function scoreMcpDiffChange(change) {
    const source = `${change?.section || ''}\n${change?.old || ''}\n${change?.new || ''}`;
    let score = 0;
    if (String(change?.type || '').toUpperCase() === 'DELETE') score += 3;
    if (/損害賠償|免責|解除|知的財産|著作権|秘密保持|個人情報|再委託|競業|反社会的勢力|準拠法|裁判管轄/u.test(source)) score += 4;
    if (/[0-9０-９]+|%|％|円|ヶ月|か月|日以内|営業日/u.test(source)) score += 1;
    return score;
}

function prioritizeMcpDiffChanges(changes, limit = 10) {
    return [...(Array.isArray(changes) ? changes : [])]
        .sort((a, b) => scoreMcpDiffChange(b) - scoreMcpDiffChange(a))
        .slice(0, limit);
}

function buildSanitizedRegulatorySearch(changes) {
    const source = (Array.isArray(changes) ? changes : [])
        .map((change) => `${change?.section || ''}\n${change?.old || ''}\n${change?.new || ''}`)
        .join('\n');
    const keywords = [];

    if (/下請|委託|発注|受領拒否|買いたたき|支払遅延/u.test(source)) {
        keywords.push('下請法 契約 条項見直し');
    }
    if (/個人情報|個人データ|プライバシー|再委託|漏えい/u.test(source)) {
        keywords.push('個人情報保護法 契約 条項 2024 2026');
    }
    if (/フリーランス|業務委託|募集情報|ハラスメント|中途解除/u.test(source)) {
        keywords.push('フリーランス新法 業務委託 契約 条項');
    }
    if (/電子帳簿|電磁的記録|保存|電子取引/u.test(source)) {
        keywords.push('電子帳簿保存法 契約 実務 2024 2026');
    }

    return {
        required: keywords.length > 0,
        keywords: Array.from(new Set(keywords)).slice(0, 5)
    };
}

function normalizeRecommendedActions(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => String(item || '').trim())
            .filter(Boolean)
            .slice(0, 5);
    }
    const text = String(value || '').trim();
    if (!text) return [];
    return text
        .split(/\r?\n|[•・]|-\s+/)
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 5);
}

function normalizeMcpMaterialChanges(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => ({
            section: String(item?.section || item?.clause || '本文').trim() || '本文',
            changeType: normalizeStructuredChangeType(item?.changeType || item?.type || 'MODIFY'),
            direction: String(item?.direction || '要確認').trim() || '要確認',
            summary: String(item?.summary || '').trim(),
            risk: String(item?.risk || '').trim()
        }))
        .filter((item) => item.summary)
        .slice(0, 8);
}

function buildMcpRiskEvaluation(riskLevel, rawDisplay = '') {
    const explicit = String(rawDisplay || '').trim();
    if (explicit) return explicit;
    if (riskLevel >= 3) return '🔴 高リスク';
    if (riskLevel === 2) return '🟡 中リスク';
    return '🟢 改善';
}

function normalizeMcpRegulatorySearch(value, changes) {
    const fallback = buildSanitizedRegulatorySearch(changes);
    const rawKeywords = Array.isArray(value?.keywords)
        ? value.keywords
        : [];
    const keywords = rawKeywords
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 5);
    return {
        required: value?.required === true || String(value?.required || '').trim().toLowerCase() === 'true' || fallback.required,
        keywords: keywords.length > 0 ? keywords : fallback.keywords
    };
}

function normalizeMcpComparisonResult(parsed, changes) {
    return normalizeAnalyzeResult({
        ...parsed,
        changes: changes
    });
}

function normalizeMcpSingleRiskItems(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => {
            const level = riskLevelToLabel(item?.level || item?.risk || item?.riskLevel || item?.risk_level);
            const reason = String(item?.reason || item?.summary || item?.concern || item?.impact || '').trim();
            const action = String(item?.action || item?.recommendedAction || item?.recommendation || item?.new || '').trim();
            return {
                section: String(item?.section || item?.clause || '本文').trim() || '本文',
                level,
                reason,
                action: action || '法務観点で妥当性を確認してください。'
            };
        })
        .filter((item) => item.reason)
        .slice(0, 5);
}

function normalizeMcpSingleAnalysisResult(parsed) {
    return normalizeAnalyzeResult(parsed);
}

function buildLocalMcpDiffAnalysis(changes) {
    const prioritized = prioritizeMcpDiffChanges(changes, 3);
    const regulatorySearch = buildSanitizedRegulatorySearch(changes);
    const hasHighRiskKeyword = prioritized.some((change) => /損害賠償|免責|解除|知的財産|個人情報/u.test(`${change?.section || ''}\n${change?.old || ''}\n${change?.new || ''}`));
    const riskLevel = hasHighRiskKeyword ? 3 : (prioritized.length > 0 ? 2 : 1);
    const summary = prioritized.length > 0
        ? `${prioritized.length}件の主要差分を抽出しました。全文ではなく差分箇所だけをもとに確認しています。`
        : '実質的な差分は検出されませんでした。';
    const riskReason = regulatorySearch.required
        ? '最新法規制との整合性は未確認です。返却された一般化キーワードで追加確認してください。'
        : '現時点で直近法改正の確認が必要な主要キーワードは目立ちません。';
    const materialChanges = prioritized.map((change) => ({
        section: String(change?.section || '本文').trim() || '本文',
        changeType: normalizeStructuredChangeType(change?.type || 'MODIFY'),
        direction: '要確認',
        summary: `${String(change?.type || 'MODIFY').toUpperCase()} の差分を検出しました。`,
        risk: buildMcpRiskEvaluation(riskLevel)
    }));
    
    return normalizeAnalyzeResult({
        summary,
        riskLevel,
        riskReason,
        changes: materialChanges,
        isFallback: true
    });
}

function buildLocalMcpSingleAnalysis(contractText) {
    const base = buildLocalSingleAnalysis(contractText);
    return normalizeAnalyzeResult({
        ...base,
        isFallback: true
    });
}

function buildMcpDiffPrompt(changes, options = {}) {
    const contractAName = String(options?.contractAName || '旧版').trim() || '旧版';
    const contractBName = String(options?.contractBName || '新版').trim() || '新版';
    const prioritized = prioritizeMcpDiffChanges(changes, 10);
    const diffBody = prioritized.map((change, index) => {
        const diffText = truncateStructuredClauseText(change?.diffText || [change?.old || '', change?.new || ''].filter(Boolean).join('\n'), 700);
        return [
            `[差分${index + 1}]`,
            `区分: ${normalizeStructuredChangeType(change?.type || 'MODIFY')}`,
            `条項: ${String(change?.section || '本文').trim() || '本文'}`,
            diffText || '差分データなし'
        ].join('\n');
    }).join('\n\n');

    return `# 役割
あなたは高度な法務専門AIエージェントです。
提供された2通の契約書の「差分データ」のみを根拠に、リスク分析と実務アドバイスを行ってください。
契約全文は与えられていません。差分以外の条文を推測で補わないでください。

# 比較対象
- 旧版: ${contractAName}
- 新版: ${contractBName}

# 必須タスク
1. 差分箇所の特定:
   追加、削除、変更された条項を差分データどおりに整理してください。

2. リーガルリスクの判定:
   各差分が「自社にとって有利 / 不利 / 中立 / 要確認」のどれかを判定してください。
   特に、損害賠償、免責、解除規定、知的財産権の帰属、個人情報、再委託は最優先で分析してください。

3. 最新法規制との整合性:
   差分に 2024年〜2026年の法改正に関連し得るキーワードが含まれる場合、
   このシステムでは外部検索は実行しないでください。
   その代わり、一般化した法務キーワードだけを regulatorySearch.keywords に返し、
   latestRegulatoryAlignment には「最新法令は要確認」と明記してください。

4. 匿名性の維持:
   社名、案件名、金額などの固有情報は検索語や要約に含めず、一般的な法務用語へ置き換えてください。

# 差分データ
${diffBody || '差分なし'}

# 出力形式
以下の JSON のみを返してください。説明文やコードブロックは不要です。
{
  "changeSummary": "【変更点概要】に入る簡潔なまとめ",
  "riskLevel": 2,
  "riskEvaluation": "🟡 中リスク",
  "latestRegulatoryAlignment": "【最新法規制との整合性】に入る助言。外部検索未実施ならその旨を明記",
  "recommendedActions": [
    "【推奨アクション】1",
    "【推奨アクション】2"
  ],
  "materialChanges": [
    {
      "section": "第5条（損害賠償）",
      "changeType": "ADD | DELETE | MODIFY",
      "direction": "自社に有利 | 自社に不利 | 中立 | 要確認",
      "summary": "変更内容の要約",
      "risk": "🔴 高リスク | 🟡 中リスク | 🟢 改善"
    }
  ],
  "regulatorySearch": {
    "required": true,
    "keywords": [
      "下請法 契約 条項見直し"
    ]
  }
}

# 重要
- 日本語で回答してください。
- riskLevel は 1, 2, 3 のいずれかです。
- riskEvaluation は必ず「🔴 高リスク」「🟡 中リスク」「🟢 改善」のいずれかにしてください。
- materialChanges は重要な差分のみ最大 5 件に絞ってください。
- 差分がない場合は、changeSummary に「実質的な差分は検出されませんでした」と書いてください。`;
}

function buildMcpSingleAnalysisPrompt(contractText) {
    const maxLength = 28000;
    const truncatedText = contractText.length > maxLength
        ? `${contractText.substring(0, maxLength)}\n\n[...テキストが長すぎるため省略されました]`
        : contractText;

    return `# 役割
あなたは契約書レビュー専門AIです。
以下の契約書を解析し、要約と主要リスクだけを返してください。

# 制約
- 原文の引用は禁止です。
- 条文全文や長い抜粋を出してはいけません。
- 社名、案件名、金額などの固有情報は必要以上に繰り返さないでください。
- ダッシュボードに出すことを前提に、簡潔で実務的な日本語にしてください。

# 入力契約書
${truncatedText}

# 出力形式
JSONのみを返してください。説明文やコードブロックは不要です。
{
  "summary": "契約の要点と全体リスクの要約",
  "riskLevel": 2,
  "riskReason": "総合リスクの理由",
  "risks": [
    {
      "section": "第5条（損害賠償）",
      "level": "HIGH | MEDIUM | LOW",
      "reason": "何が問題かを簡潔に説明",
      "action": "相手方に確認・修正したい事項"
    }
  ]
}

# 重要
- 原文の引用やコピペは禁止です。
- risks は最大5件までに絞ってください。
- level は必ず HIGH / MEDIUM / LOW のいずれかです。
- riskLevel は 1, 2, 3 のいずれかです。`;
}

async function mapWithConcurrency(items, limit, mapper) {
    const results = new Array(items.length);
    let cursor = 0;

    async function worker() {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await mapper(items[index], index);
        }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

function shouldRetryGeminiRequest(error) {
    const status = Number(error?.response?.status || 0);
    if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
    const message = String(error?.message || '');
    return /timeout|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(message);
}

function getGeminiErrorStatus(error) {
    const status = Number(error?.response?.status || 0);
    return Number.isFinite(status) ? status : 0;
}

function parseRetryAfterMs(error) {
    const headers = error?.response?.headers || {};
    const raw = headers['retry-after'] ?? headers['Retry-After'];
    if (raw === undefined || raw === null) return null;

    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber >= 0) {
        return Math.floor(asNumber * 1000);
    }

    const asDate = new Date(String(raw)).getTime();
    if (Number.isNaN(asDate)) return null;
    const delta = asDate - Date.now();
    return delta > 0 ? delta : 0;
}

function getGeminiRequestBudget() {
    // ローカル/本番で同一実装。必要時は環境変数で同じキーを調整する。
    const timeoutMsRaw = Number(process.env.GEMINI_TIMEOUT_MS || 45000);
    const maxAttemptsRaw = Number(process.env.GEMINI_MAX_ATTEMPTS || 2);
    const retryBaseMsRaw = Number(process.env.GEMINI_RETRY_BASE_MS || 1000);
    return {
        timeoutMs: Number.isFinite(timeoutMsRaw) && timeoutMsRaw >= 5000 ? Math.floor(timeoutMsRaw) : 45000,
        maxAttempts: Number.isFinite(maxAttemptsRaw) && maxAttemptsRaw >= 1 ? Math.min(Math.floor(maxAttemptsRaw), 5) : 2,
        retryBaseMs: Number.isFinite(retryBaseMsRaw) && retryBaseMsRaw >= 0 ? Math.floor(retryBaseMsRaw) : 1000
    };
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

        if (previousText && currentText && previousText.trim() === currentText.trim()) {
            logger.info('No changes detected, skipping AI analysis');
            return {
                summary: "前バージョンからの変更は検出されませんでした。契約内容は維持されています。",
                riskLevel: 1,
                riskReason: "変更なし",
                changes: [],
                aiSucceeded: true,
                isLimited: false,
                isFallback: false
            };
        }

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

        logger.info('Starting unified Gemini 2.0 analysis task');
        const start = Date.now();
        
        const prompt = this.buildUnifiedAnalysisPrompt(currentText, previousText);

        const requestWithMimeFallback = async (p, label) => {
            let lastError = null;
            for (const enforceJsonMime of [true, false]) {
                try {
                    return await this.requestGeminiJson(p, enforceJsonMime);
                } catch (error) {
                    lastError = error;
                    logger.warn(`${label} request failed (jsonMime=${enforceJsonMime}): ${error.message}`);
                    // 429 は MIME 変更では解消しないため、不要な追加リクエストを抑制する。
                    if (getGeminiErrorStatus(error) === 429) {
                        throw error;
                    }
                }
            }
            throw lastError || new Error(`${label} request failed`);
        };

        try {
            const res = await requestWithMimeFallback(prompt, 'unified_analysis');
            
            if (!res) {
                throw new Error('Unified request returned empty result');
            }

            const result = {
                ...normalizeAnalyzeResult(res),
                changes: normalizeChanges(res?.changes),
                contract_meta: normalizeContractMeta(res?.contract_meta || res),
                isLimited: false,
                isFallback: false
            };

            logger.info(`Analysis complete. duration=${Date.now() - start}ms`);
            return result;

        } catch (error) {
            logger.error('Gemini unified analysis failed:', error);
            const status = Number(error?.response?.status || 0);
            if (status === 429) {
                const limited = buildHeuristicFallbackAnalysis(currentText, previousText);
                limited.errorCode = 'AI_RATE_LIMITED';
                limited.errorMessage = '現在アクセスが集中しています。数分後にもう一度お試しください。';
                return limited;
            }
            if (shouldUseLocalAiFallback()) {
                return previousText
                    ? buildLocalDiffAnalysis(currentText, previousText)
                    : buildLocalSingleAnalysis(currentText);
            }
            return buildHeuristicFallbackAnalysis(currentText, previousText);
        }
    }

    async ensureContractMeta(currentText, previousText, rawMeta) {
        const primary = normalizeContractMeta(rawMeta);
        if (hasMeaningfulContractMeta(primary)) {
            return primary;
        }

        const prompt = this.buildDeadlineMetaPrompt(currentText, previousText);
        for (const enforceJsonMime of [true, false]) {
            try {
                const recovered = await this.requestGeminiJson(prompt, enforceJsonMime);
                const recoveredMeta = normalizeContractMeta(recovered?.contract_meta || recovered);
                if (hasMeaningfulContractMeta(recoveredMeta)) {
                    logger.info(`Recovered contract_meta via focused deadline extraction (jsonMime=${enforceJsonMime})`);
                    return mergeContractMeta(primary, recoveredMeta);
                }
            } catch (error) {
                logger.warn(`Focused deadline extraction failed (jsonMime=${enforceJsonMime}): ${error.message}`);
            }
        }

        return primary;
    }

    async analyzeMcpContract(contractText) {
        const currentText = typeof contractText === 'string'
            ? contractText
            : JSON.stringify(contractText || '');

        if (shouldUseLocalAiFallback()) {
            if (!GEMINI_API_KEY || process.env.LOCAL_AI_ONLY === 'true') {
                logger.info('Using local MCP single-contract fallback analysis');
                return buildLocalMcpSingleAnalysis(currentText);
            }
        }

        if (!GEMINI_API_KEY) {
            throw new Error('Gemini API key is not configured');
        }

        const prompt = buildMcpSingleAnalysisPrompt(currentText);
        logger.info('Starting Gemini analyzeMcpContract request');

        try {
            const primary = await this.requestGeminiJson(prompt, true);
            return {
                ...normalizeMcpSingleAnalysisResult(primary),
                isFallback: false
            };
        } catch (error) {
            logger.warn('Gemini analyzeMcpContract primary request failed, retrying without JSON mime type:', error.message);
            try {
                const fallback = await this.requestGeminiJson(prompt, false);
                return {
                    ...normalizeMcpSingleAnalysisResult(fallback),
                    isFallback: false
                };
            } catch (retryError) {
                logger.error('Gemini analyzeMcpContract failed:', retryError);
            }
            logger.warn('Returning local MCP single-contract fallback analysis instead of AI failure');
            return buildLocalMcpSingleAnalysis(currentText);
        }
    }

    async requestGeminiJson(prompt, enforceJsonMime = true) {
        const body = {
            contents: [{
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                temperature: 0.0,
                maxOutputTokens: 4096
            }
        };

        if (enforceJsonMime) {
            body.generationConfig.responseMimeType = 'application/json';
        }

        const budget = getGeminiRequestBudget();
        let lastError = null;
        for (let attempt = 0; attempt < budget.maxAttempts; attempt += 1) {
            try {
                const response = await axios.post(
                    `${GEMINI_ENDPOINT}?key=${GEMINI_API_KEY}`,
                    body,
                    {
                        timeout: budget.timeoutMs,
                        headers: {
                            'Content-Type': 'application/json',
                            'Referer': 'https://diffsense.spacegleam.co.jp'
                        }
                    }
                );

                const aiText = extractCandidateText(response?.data);
                return parseGeminiJsonResponse(aiText);
            } catch (error) {
                lastError = error;
                if (attempt >= budget.maxAttempts - 1 || !shouldRetryGeminiRequest(error)) {
                    break;
                }
                const status = getGeminiErrorStatus(error);
                const retryAfterMs = status === 429 ? parseRetryAfterMs(error) : null;
                const linearWaitMs = budget.retryBaseMs * (attempt + 1);
                const waitMs = status === 429
                    ? Math.max(retryAfterMs ?? 0, Math.max(2000, linearWaitMs * 3))
                    : linearWaitMs;
                logger.warn(`Gemini request retry ${attempt + 1}/${Math.max(0, budget.maxAttempts - 1)} after ${waitMs}ms (status=${status || 'n/a'}): ${error.message}`);
                await new Promise((resolve) => setTimeout(resolve, waitMs));
            }
        }

        throw lastError || new Error('Gemini request failed');
    }

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

        const modifiedChanges = changes.filter(c => c.type !== 'UNTOUCHED').slice(0, 15);
        logger.info(`Analyzing structured diff with ${modifiedChanges.length} prioritized changes`);

        const clauseResults = await mapWithConcurrency(modifiedChanges, 3, async (change, index) => {
            const prompt = this.buildStructuredClausePrompt(change);
            try {
                const primary = await this.requestGeminiJson(prompt, true);
                return normalizeStructuredClauseResult(primary, index);
            } catch (error) {
                logger.warn(`Structured clause analysis primary request failed for CHG-${index}, retrying without JSON mime type: ${error.message}`);
                try {
                    const fallback = await this.requestGeminiJson(prompt, false);
                    return normalizeStructuredClauseResult(fallback, index);
                } catch (retryError) {
                    logger.error(`Structured clause analysis failed for CHG-${index}:`, retryError);
                    return null;
                }
            }
        });

        const successfulResults = clauseResults.filter(Boolean);
        const changedResults = successfulResults.filter((item) => item.change === true);
        if (successfulResults.length === 0 || (successfulResults.length < modifiedChanges.length && changedResults.length === 0)) {
            return normalizeAnalyzeResult({
                summary: 'AI差分要約を取得できませんでした。再解析を実行してください。',
                riskLevel: 1,
                riskReason: 'AI差分要約未取得',
                changes: [],
                isFallback: true
            });
        }

        return normalizeAnalyzeResult({
            summary: buildStructuredResultsSummary(successfulResults, modifiedChanges),
            riskLevel: changedResults.length > 0
                ? Math.max(...changedResults.map((item) => normalizeRiskLevelValue(item.riskLevel)))
                : 1,
            riskReason: buildStructuredResultsRiskReason(successfulResults),
            changes: successfulResults,
            isFallback: false
        });
    }

    async analyzeMcpDiff(changes, options = {}) {
        const normalizedChanges = Array.isArray(changes) ? changes.filter(Boolean) : [];
        if (normalizedChanges.length === 0) {
            return normalizeAnalyzeResult({
                summary: '実質的な差分は検出されませんでした。',
                riskLevel: 1,
                riskReason: '現時点で直近法改正との追加照合が必要な主要差分は見当たりません。',
                changes: [],
                isFallback: false
            });
        }

        if (shouldUseLocalAiFallback()) {
            if (!GEMINI_API_KEY || process.env.LOCAL_AI_ONLY === 'true') {
                logger.info('Using local MCP diff fallback analysis');
                return buildLocalMcpDiffAnalysis(normalizedChanges);
            }
        }

        if (!GEMINI_API_KEY) {
            throw new Error('Gemini API key is not configured');
        }

        const prompt = buildMcpDiffPrompt(normalizedChanges, options);
        logger.info('Starting Gemini analyzeMcpDiff request');

        try {
            const primary = await this.requestGeminiJson(prompt, true);
            return {
                ...normalizeMcpComparisonResult(primary, normalizedChanges),
                isFallback: false
            };
        } catch (error) {
            logger.warn('Gemini analyzeMcpDiff primary request failed, retrying without JSON mime type:', error.message);
            try {
                const fallback = await this.requestGeminiJson(prompt, false);
                return {
                    ...normalizeMcpComparisonResult(fallback, normalizedChanges),
                    isFallback: false
                };
            } catch (retryError) {
                logger.error('Gemini analyzeMcpDiff failed:', retryError);
            }
            logger.warn('Returning local MCP diff fallback analysis instead of AI failure');
            return buildLocalMcpDiffAnalysis(normalizedChanges);
        }
    }

    buildStructuredClausePrompt(change) {
        return `あなたは契約書レビュー専門AIです。

旧条文と新条文を比較し、
契約内容に変更があるかを評価してください。

重要
文字差分ではなく契約の意味差分を評価してください。

--------------------------------

入力

旧条文
${truncateStructuredClauseText(change?.old || '')}

新条文
${truncateStructuredClauseText(change?.new || '')}

差分候補
${buildSemanticDiffCandidate(change?.old || '', change?.new || '')}

--------------------------------

手順

1. 旧条文の意味を要約
2. 新条文の意味を要約
3. 契約上の効果が変わるか判断

--------------------------------

重要

意味が同じ場合は

変更なし

と判定してください。

--------------------------------

変更として扱うもの

・金額変更
・数量変更
・支払条件変更
・期限変更
・責任範囲変更
・権利義務変更
・契約解除条件変更
・知的財産条件変更
・再委託条件変更
・保証範囲変更

--------------------------------

出力

{
 "change": true,
 "summary": "変更内容",
 "risk": "HIGH | MEDIUM | LOW"
}

変更がない場合

{
 "change": false
}

重要:
- JSONのみを返してください。
- 説明文やコードブロックは不要です。
- "change": false の場合は summary や risk を含めないでください。`;
    }

    buildUnifiedAnalysisPrompt(contractText, previousVersion) {
        const maxLength = 30000;
        const truncatedText = contractText.length > maxLength
            ? contractText.substring(0, maxLength) + '\n\n[...テキストが長すぎるため省略されました]'
            : contractText;

        const input = previousVersion
            ? `【旧版】\n${previousVersion.substring(0, maxLength)}\n\n【新版】\n${truncatedText}`
            : `【契約書】\n${truncatedText}`;

        return `あなたは高度な法務専門AIエージェントです。提供された契約書（比較時は新旧の差分）を解析し、以下のJSON形式で結果を返してください。

指示:
1. 概要(summary): 契約の全体像、主要な変更の意義、および実務上の注意点を200〜300文字程度で丁寧に解説してください。単なる要約ではなく、文脈を汲み取ったアドバイスを含めてください。
2. リスクレベル(riskLevel): 1(低), 2(中), 3(高)の3段階で判定してください。
3. リスク理由(riskReason): 判定の根拠を100文字以内で簡潔に述べてください。
4. 変更点(changes): 特に重要な変更やリスクのある条項を最大5件抽出してください。
5. メタデータ(contract_meta): 契約開始日、終了日、更新期限、自動更新の有無、通知期間、契約金額（月額や総額）、契約当事者（甲・乙の名称）を正確に抽出してください。

出力形式(JSONのみ):
{
  "summary": "...",
  "riskLevel": 2,
  "riskReason": "...",
  "changes": [
    {
      "section": "条項名",
      "type": "modification | risk",
      "old": "書類内の該当箇所の文章をそのまま一字一句引用（要約・言い換え禁止）",
      "new": "後の文言（または修正案・解説）",
      "impact": "法的影響",
      "concern": "注意点"
    }
  ],
  "contract_meta": {
    "expiry_date": "YYYY-MM-DD",
    "renewal_deadline": "YYYY-MM-DD",
    "contract_start": "YYYY-MM-DD",
    "auto_renewal": true,
    "notice_period_days": 30,
    "contract_category": "...",
    "date_confidence": "high | medium | low",
    "contract_amount": "例: 月額 ¥500,000 (税抜)",
    "parties": "例: 株式会社A（甲）、株式会社B（乙）"
  }
}

重要:
- 日本語で回答してください。
- JSON以外のテキストは一切出力しないでください。
- 日付が不明な場合はnullにしてください。
- 差分解析の場合は、新旧の対比を明確にしてください。

${input}`;
    }

    buildPrompt(contractText, previousVersion) {
        const maxLength = 30000;
        const truncatedText = contractText.length > maxLength
            ? contractText.substring(0, maxLength) + '\n\n[...テキストが長すぎるため省略されました]'
            : contractText;

        if (previousVersion) {
            const truncatedPrev = previousVersion.length > maxLength
                ? previousVersion.substring(0, maxLength) + '\n\n[...テキストが長すぎるため省略されました]'
                : previousVersion;

            return `あなたは契約書の差分解析の専門家です。以下の2つの契約書を比較し、変更点を抽出した上で、全体的な総括を行ってください。

【旧バージョン】
${truncatedPrev}

【新バージョン】
${truncatedText}

以下のJSON形式で回答してください（JSONのみを出力し、説明文は不要です）:
{
  "summary": "日本語で回答してください。まず最新版契約書の全体像とリスク状況、および前バージョンからの変更が契約全体に与える意義を統合し、実務上のアドバイスを含めて200〜300文字程度で詳しく要約してください。単なる箇条書きではなく、文脈を持った説明にしてください。",
  "riskLevel": 3,
  "riskReason": "リスク判定の理由を簡潔に（100文字以内）",
  "changes": [
    {
      "section": "条項名",
      "issue": "変更内容の概要",
      "type": "modification",
      "old": "旧バージョンの該当箇所の文章をそのまま一字一句引用（要約・言い換え禁止）",
      "proposal": "修正後の推奨文言（変更後の文言をベースに改善を加えたもの）",
      "risk": "この変更による法的リスクや注意点",
      "benefit": "修正することで得られるメリット（50文字以内）"
    }
  ]
}

重要: 
- summaryフィールドを必ず含め、新バージョンがどのような状態になり、どのようなリスクがあるかの「解説」を含めてください。
- changesには、特に重要と思われる変更を優先的に抽出してください。
- riskLevelは1（低リスク）、2（中リスク）、3（高リスク）のいずれかに設定してください。`;
        } else {
            return `あなたは契約書レビュー専門の法務AIです。以下の契約書を分析し、「修正提案を行うかどうか」と「その理由」を明確に説明してください。

【契約書】
${truncatedText}

# ■最重要ルール

修正提案は必ず以下のいずれかに該当する場合のみ行う：

① リスク低減：損害賠償が無制限／一方的に不利な義務／解除条件が不利／責任範囲が過大
② 不利条件の是正：一般的な契約より明らかに不利／支払い条件が悪い／権利が一方的に相手に偏っている
③ 曖昧性の排除：解釈が分かれる表現／具体性がない条文／トラブルになりやすい記述
④ 条項の欠落：支払い条件がない／損害賠償条項がない／解除条件がない／秘密保持がない
⑤ 有利化（任意）：より有利な条件にできる場合のみ

# ■修正してはいけないケース

以下の場合は修正提案を出さない：
・一般的な契約内容である
・リスクが低い
・バランスが取れている
・実務上問題がない

# ■出力ルール（厳守）

必ず以下のJSON形式のみで出力すること（説明文・コードブロック記号は不要）:

修正不要の場合:
{
  "needs_revision": false,
  "summary": "大きな修正は不要と判断されました（契約全体の評価を200文字以内で）",
  "riskLevel": 1,
  "riskReason": "リスク判定の根拠（100文字以内）",
  "reason": ["主要な条項が網羅されているため", "一般的な契約構成であるため"],
  "suggestions": [],
  "contract_meta": {
    "expiry_date": "YYYY-MM-DDまたはnull",
    "renewal_deadline": "YYYY-MM-DDまたはnull",
    "contract_start": "YYYY-MM-DDまたはnull",
    "auto_renewal": null,
    "notice_period_days": null,
    "contract_category": "契約種別",
    "date_confidence": "high/medium/low"
  }
}

修正必要の場合:
{
  "needs_revision": true,
  "summary": "一部調整を推奨します（契約全体の評価を200文字以内で）",
  "riskLevel": 2,
  "riskReason": "リスク判定の根拠（100文字以内）",
  "reason": ["判断理由1（必ず2つ以上）", "判断理由2"],
  "suggestions": [
    {
      "section": "該当する条項名",
      "issue": "問題点の概要",
      "old": "書類内の該当条文をそのまま一字一句引用（要約・言い換え禁止。条文が長い場合は問題箇所を中心に引用）",
      "proposal": "具体的な修正案（修正後の文案）",
      "risk": "このままにした場合の具体的なリスク",
      "benefit": "修正することで得られるメリット"
    }
  ],
  "contract_meta": {
    "expiry_date": "YYYY-MM-DDまたはnull",
    "renewal_deadline": "YYYY-MM-DDまたはnull",
    "contract_start": "YYYY-MM-DDまたはnull",
    "auto_renewal": null,
    "notice_period_days": null,
    "contract_category": "契約種別",
    "date_confidence": "high/medium/low"
  }
}

重要:
- 必ずJSONのみ出力。説明文・マークダウン不要。
- riskLevelは1（低）、2（中）、3（高）のいずれか。
- suggestionsのoldは書類内の原文を一字一句引用すること（要約・解釈・言い換え禁止）。
- 修正不要の場合はsuggestionsを空配列にすること。
- contract_metaの日付は契約書本文から正確に読み取ること。記載がない場合はnull。`;
        }
    }

    buildFullAnalysisPrompt(contractText, previousVersion) {
        const truncatedText = contractText.substring(0, 30000);
        const truncatedPrev = previousVersion ? previousVersion.substring(0, 30000) : null;

        const input = previousVersion
            ? `【比較解析】\n旧版:\n${truncatedPrev}\n\n新版:\n${truncatedText}`
            : `【単体解析】\n内容:\n${truncatedText}`;

        return `${input}

[指示]
契約書を解析し、以下のJSON形式で結果のみを返してください。説明は不要です。

{
  "summary": "内容とリスクの要約（日本語で簡潔に）",
  "riskLevel": 1, 2, 3 のいずれか,
  "riskReason": "理由（短く）",
  "changes": [
    {
      "section": "条項名",
      "type": "modification/risk",
      "old": "前の文言",
      "new": "後の文言/アドバイス",
      "impact": "影響",
      "concern": "注意点"
    }
  ],
  "contract_meta": {
    "expiry_date": "YYYY-MM-DD",
    "renewal_deadline": "YYYY-MM-DD",
    "contract_start": "YYYY-MM-DD",
    "auto_renewal": true/false,
    "notice_period_days": 数値,
    "contract_category": "種別"
  }
}

[ルール]
- changesは最重要の5件以内
- 日付不明はnull
- JSON以外のテキストは出力禁止`;
    }

    buildSummaryPrompt(contractText, previousVersion) {
        const maxLength = 30000;
        const truncatedText = contractText.length > maxLength
            ? contractText.substring(0, maxLength) + '\n\n[...テキストが長すぎるため省略されました]'
            : contractText;

        if (previousVersion) {
            const truncatedPrev = previousVersion.length > maxLength
                ? previousVersion.substring(0, maxLength) + '\n\n[...テキストが長すぎるため省略されました]'
                : previousVersion;

            return `以下の2つの契約書を比較し、変更の意義とリスク状況を要約してください。\n【旧版】\n${truncatedPrev}\n\n【新版】\n${truncatedText}

        以下のJSON形式で回答してください:
        {
          "summary": "日本語で200〜300文字程度で詳しく解説・要約してください。",
          "riskLevel": 3,
          "riskReason": "リスク判定の理由（100文字以内）"
        }`;
        } else {
            return `以下の契約書を解析し、内容とリスク状況を要約してください。\n【契約書】\n${truncatedText}

        以下のJSON形式で回答してください:
        {
          "summary": "日本語で200〜300文字程度で詳しく解説・要約してください。",
          "riskLevel": 3,
          "riskReason": "リスク判定の理由（100文字以内）"
        }`;
        }
    }

    buildDetailsPrompt(contractText, previousVersion) {
        const maxLength = 30000;
        const truncatedText = contractText.length > maxLength
            ? contractText.substring(0, maxLength) + '\n\n[...テキストが長すぎるため省略されました]'
            : contractText;

        if (previousVersion) {
            const truncatedPrev = previousVersion.length > maxLength
                ? previousVersion.substring(0, maxLength) + '\n\n[...テキストが長すぎるため省略されました]'
                : previousVersion;

            return `以下の2つの契約書の具体的な変更条項と期限情報を抽出してください。\n【旧版】\n${truncatedPrev}\n\n【新版】\n${truncatedText}

        以下のJSON形式で回答してください:
        {
          "changes": [
            {
              "section": "条項名",
              "type": "modification",
              "old": "前の文言（単体解析時は原文引用）",
              "new": "後の文言（単体解析時はリスク解説/修正案）",
              "impact": "法的影響",
              "concern": "注意点"
            }
          ],
          "contract_meta": {
            "expiry_date": "YYYY-MM-DD",
            "renewal_deadline": "YYYY-MM-DD",
            "contract_start": "YYYY-MM-DD",
            "auto_renewal": true,
            "notice_period_days": 30,
            "date_confidence": "high|medium|low",
            "contract_category": "契約種別"
          }
        }

        注意:
        - 日付は必ず YYYY-MM-DD で返してください。
        - 「満了日の◯日前に通知」等の条文がある場合は notice_period_days を数値で返してください。
        - renewal_deadline が未記載でも、expiry_date と notice_period_days から算出できる場合は算出して返してください。`;
        } else {
            return `以下の契約書の重要な条項（リスク・注意点）と期限情報を抽出してください。\n【契約書】\n${truncatedText}

        以下のJSON形式で回答してください:
        {
          "changes": [
            {
              "section": "条項名",
              "type": "modification",
              "old": "前の文言（単体解析時は原文引用）",
              "new": "後の文言（単体解析時はリスク解説/修正案）",
              "impact": "法的影響",
              "concern": "注意点"
            }
          ],
          "contract_meta": {
            "expiry_date": "YYYY-MM-DD",
            "renewal_deadline": "YYYY-MM-DD",
            "contract_start": "YYYY-MM-DD",
            "auto_renewal": true,
            "notice_period_days": 30,
            "date_confidence": "high|medium|low",
            "contract_category": "契約種別"
          }
        }

        注意:
        - 日付は必ず YYYY-MM-DD で返してください。
        - 「満了日の◯日前に通知」等の条文がある場合は notice_period_days を数値で返してください。
        - renewal_deadline が未記載でも、expiry_date と notice_period_days から算出できる場合は算出して返してください。`;
        }
    }

    buildDeadlineMetaPrompt(contractText, previousVersion) {
        const maxLength = 30000;
        const truncatedText = contractText.length > maxLength
            ? contractText.substring(0, maxLength) + '\n\n[...テキストが長すぎるため省略されました]'
            : contractText;

        if (previousVersion) {
            const truncatedPrev = previousVersion.length > maxLength
                ? previousVersion.substring(0, maxLength) + '\n\n[...テキストが長すぎるため省略されました]'
                : previousVersion;

            return `以下の契約書（新版優先）から期限情報のみを高精度で抽出してください。\n【旧版】\n${truncatedPrev}\n\n【新版】\n${truncatedText}

        以下のJSONのみで回答してください（説明文不要）:
        {
          "contract_meta": {
            "expiry_date": "YYYY-MM-DD または null",
            "renewal_deadline": "YYYY-MM-DD または null",
            "contract_start": "YYYY-MM-DD または null",
            "auto_renewal": true,
            "notice_period_days": 30,
            "contract_category": "契約種別またはnull",
            "date_confidence": "high|medium|low"
          }
        }

        ルール:
        - 日付は必ず YYYY-MM-DD に正規化する。
        - 明記がない項目は null。
        - 「満了日の◯日前通知」等がある場合は notice_period_days を数値で返す。
        - renewal_deadline が明記されていなくても、expiry_date と notice_period_days から算出可能なら算出する。`;
        } else {
            return `以下の契約書から期限情報のみを高精度で抽出してください。\n【契約書】\n${truncatedText}

        以下のJSONのみで回答してください（説明文不要）:
        {
          "contract_meta": {
            "expiry_date": "YYYY-MM-DD または null",
            "renewal_deadline": "YYYY-MM-DD または null",
            "contract_start": "YYYY-MM-DD または null",
            "auto_renewal": true,
            "notice_period_days": 30,
            "contract_category": "契約種別またはnull",
            "date_confidence": "high|medium|low"
          }
        }

        ルール:
        - 日付は必ず YYYY-MM-DD に正規化する。
        - 明記がない項目は null。
        - 「満了日の◯日前通知」等がある場合は notice_period_days を数値で返す。
        - renewal_deadline が明記されていなくても、expiry_date と notice_period_days から算出可能なら算出する。`;
        }
    }

    /**
     * Generate a free-form text response from Gemini (non-JSON)
     * @param {string} prompt
     * @returns {Promise<string>}
     */
    async generateText(prompt) {
        if (!GEMINI_API_KEY) {
            throw new Error('Gemini API key is not configured');
        }
        const body = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 512 }
        };
        const response = await axios.post(
            `${GEMINI_ENDPOINT}?key=${GEMINI_API_KEY}`,
            body,
            { timeout: 30000, headers: { 'Content-Type': 'application/json' } }
        );
        return extractCandidateText(response?.data);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 修正提案付き拡張解析 (Enhanced Analysis with Modification Suggestions)
     * @param {string} contractText - 契約書テキスト
     * @returns {Promise<Object>} { contractType, contractTypeConfidence, overall, clauses, finalDocument, negotiationText }
     */
    async analyzeContractEnhanced(contractText) {
        if (!GEMINI_API_KEY) {
            throw new Error('Gemini API key is not configured');
        }

        const maxLength = 28000;
        const truncated = String(contractText || '').substring(0, maxLength);

        const prompt = `あなたは高度な法務専門AIエージェントです。
以下の契約書を詳細に解析し、各条項に対する修正提案を含む拡張レポートをJSON形式で返してください。

# 契約書
${truncated}

# 出力形式（JSONのみ。説明文やコードブロック不要）
{
  "contractType": "契約種別（例: 業務委託契約、売買契約、秘密保持契約）",
  "contractTypeConfidence": "高 | 中 | 低",
  "overall": {
    "riskLevel": 2,
    "riskLabel": "🟡 中リスク",
    "summary": "契約全体のリスク概要と推奨対応（200文字以内）"
  },
  "clauses": [
    {
      "clauseName": "第X条（条項名）",
      "severity": "HIGH | MEDIUM | LOW",
      "issue": "この条項の問題点（100文字以内）",
      "suggestion": "修正提案の要旨（100文字以内）",
      "originalText": "元の条文（原文をそのまま引用。200文字以内）",
      "modifiedText": "修正後の条文案（200文字以内）"
    }
  ],
  "finalDocument": "全条項を修正提案反映済みの完全な契約書テキスト（改行\\nで表現）",
  "negotiationText": "相手方への交渉・申し入れ文書のサンプル（300文字以内）"
}

# ルール
- 日本語で回答してください
- clausesは重要度の高い順に最大8件
- severity は必ず HIGH / MEDIUM / LOW のいずれか
- riskLevel は 1, 2, 3 のいずれか
- riskLabel は「🔴 高リスク」「🟡 中リスク」「🟢 低リスク」のいずれか
- finalDocument は元の契約書をベースに修正提案を反映した完成形テキスト
- JSON以外のテキストは一切出力しないでください`;

        logger.info('Starting analyzeContractEnhanced request');
        try {
            const result = await this.requestGeminiJson(prompt, true);
            return this._normalizeEnhancedResult(result);
        } catch (error) {
            logger.warn('analyzeContractEnhanced primary failed, retrying without JSON mime:', error.message);
            try {
                const result = await this.requestGeminiJson(prompt, false);
                return this._normalizeEnhancedResult(result);
            } catch (retryError) {
                logger.error('analyzeContractEnhanced failed:', retryError);
                throw retryError;
            }
        }
    }

    _normalizeEnhancedResult(parsed) {
        const riskLevel = Number(parsed?.overall?.riskLevel || 2);
        const riskLabel = parsed?.overall?.riskLabel ||
            (riskLevel >= 3 ? '🔴 高リスク' : riskLevel === 2 ? '🟡 中リスク' : '🟢 低リスク');

        const clauses = Array.isArray(parsed?.clauses) ? parsed.clauses.map(c => ({
            clauseName: String(c?.clauseName || c?.clause || '').trim() || '条項',
            severity: /^(HIGH|MEDIUM|LOW)$/i.test(String(c?.severity || '')) ? String(c.severity).toUpperCase() : 'MEDIUM',
            issue: String(c?.issue || c?.reason || '').trim(),
            suggestion: String(c?.suggestion || c?.action || '').trim(),
            originalText: String(c?.originalText || c?.original || c?.old || '').trim(),
            modifiedText: String(c?.modifiedText || c?.modified || c?.new || '').trim()
        })).filter(c => c.clauseName || c.issue) : [];

        return {
            contractType: String(parsed?.contractType || '').trim() || '契約書',
            contractTypeConfidence: String(parsed?.contractTypeConfidence || '').trim() || '中',
            overall: {
                riskLevel,
                riskLabel,
                summary: String(parsed?.overall?.summary || '').trim() || '解析が完了しました。'
            },
            clauses,
            finalDocument: String(parsed?.finalDocument || '').trim(),
            negotiationText: String(parsed?.negotiationText || '').trim()
        };
    }
}

module.exports = new GeminiService();
