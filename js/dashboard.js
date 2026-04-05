import { Notify } from './notify.js';
import { dbService } from './db-service.js?v=20260321f';
import { aiService } from './ai-service.js?v=20260309h2';
import { getApiBaseUrl } from './api-base.js';
import { auth } from './firebase-config.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
const LOCAL_UI_CACHE_VERSION = '20260310v3';
const DASHBOARD_CACHE_KEYS = {
    USER_META: `diffsense_cache_user_meta_${LOCAL_UI_CACHE_VERSION}`,
    SUBSCRIPTION: `diffsense_cache_subscription_${LOCAL_UI_CACHE_VERSION}`,
    RECENT_HISTORY: `diffsense_cache_recent_history_${LOCAL_UI_CACHE_VERSION}`
};

const SCRIPT_LOAD_CACHE = new Map();

function loadExternalScriptOnce(src, globalGuard = null) {
    if (globalGuard && globalGuard()) {
        return Promise.resolve();
    }
    if (SCRIPT_LOAD_CACHE.has(src)) {
        return SCRIPT_LOAD_CACHE.get(src);
    }
    const loader = new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-src="${src}"]`);
        if (existing) {
            if (globalGuard && globalGuard()) {
                resolve();
                return;
            }
            if (existing.dataset.loaded === '1' || existing.readyState === 'complete') {
                resolve();
                return;
            }
            const timeoutId = setTimeout(() => {
                reject(new Error(`Timed out while loading ${src}`));
            }, 10000);
            existing.addEventListener('load', () => resolve(), { once: true });
            existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
            existing.addEventListener('load', () => clearTimeout(timeoutId), { once: true });
            existing.addEventListener('error', () => clearTimeout(timeoutId), { once: true });
            return;
        }
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.dataset.src = src;
        const timeoutId = setTimeout(() => {
            reject(new Error(`Timed out while loading ${src}`));
        }, 10000);
        script.onload = () => {
            script.dataset.loaded = '1';
            clearTimeout(timeoutId);
            resolve();
        };
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
    });
    SCRIPT_LOAD_CACHE.set(src, loader);
    return loader;
}

const parseArticleNumeric = (label) => {
    if (!label) return 0;
    const m = String(label).match(/隨ｬ\s*([0-9・・・吩ｸ莠御ｸ牙屁莠泌・荳・・荵晏香逋ｾ蜊・・峺]+)\s*譚｡/);
    if (!m) return 0;
    const raw = m[1].replace(/[・・・兢/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0));
    if (/^\d+$/.test(raw)) return parseInt(raw, 10);
    const map = { '髮ｶ': 0, '縲・: 0, '荳': 1, '莠・: 2, '荳・: 3, '蝗・: 4, '莠・: 5, '蜈ｭ': 6, '荳・: 7, '蜈ｫ': 8, '荵・: 9 };
    if (map[raw] !== undefined) return map[raw];
    return 0;
};

const normalizeStructuredDisplayContent = (content) => {
    if (!content || typeof content !== 'object' || Array.isArray(content) || !Array.isArray(content.articles)) {
        return content;
    }

    const clone = {
        ...content,
        preamble: String(content.preamble || '').trim(),
        articles: content.articles.map((a) => ({ ...a }))
    };

    const firstArticleOneIdx = clone.articles.findIndex((a) => parseArticleNumeric(a.articleNumber || a.article || '') === 1);
    if (firstArticleOneIdx > 0) {
        const prefix = clone.articles.slice(0, firstArticleOneIdx);
        const allLikelyNoise = prefix.every((a) => {
            const body = String(a.content || '').trim();
            if (!body) return true;
            if (body.length < 30) return true;
            return /(蜑肴枚|螂醍ｴ・嶌|隕冗ｴл謾ｹ險・ver\.?|version)/i.test(body);
        });

        if (allLikelyNoise) {
            const mergedPrefixText = prefix
                .map((a) => String(a.content || '').trim())
                .filter(Boolean)
                .join('\n')
                .trim();
            if (mergedPrefixText) {
                clone.preamble = clone.preamble
                    ? `${clone.preamble}\n${mergedPrefixText}`.trim()
                    : mergedPrefixText;
            }
            clone.articles = clone.articles.slice(firstArticleOneIdx);
        }
    }

    return clone;
};

const escapeHtmlText = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const isStructuredDocumentContent = (content) => {
    if (!content) return false;
    if (Array.isArray(content)) return true;
    return typeof content === 'object' && Array.isArray(content.articles);
};

const isWordDocumentFilename = (value) => /\.(docx?|dotx?)$/i.test(String(value || '').trim());
const isLocalDashboardMode = () => window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

const isEmbeddablePdfUrl = (value) => {
    const src = String(value || '').trim();
    if (!src) return false;
    if (src.startsWith('blob:')) return true;
    if (/^https?:\/\//i.test(src)) return true;
    if (src.startsWith('/uploads/')) return true;
    return false;
};

const resolvePdfPreviewUrl = (contract, runtimePdfUrl = null) => {
    const candidates = [contract?.pdf_url, runtimePdfUrl, contract?.pdf_storage_path];
    for (const candidate of candidates) {
        if (isEmbeddablePdfUrl(candidate)) return candidate;
    }
    return null;
};

const clauseIdentityKey = (clause) => `${clause?.title || ''}__${clause?.header || ''}`;

const clauseParagraphs = (clause) => Array.isArray(clause?.paragraphs)
    ? clause.paragraphs.map((p) => String(p ?? ''))
    : [];

const clauseBodyText = (clause) => Array.isArray(clause?.paragraphs)
    ? clause.paragraphs.map((p) => String(p || '')).join('\n').trim()
    : '';

const renderClauseParagraphs = (text) => {
    const lines = String(text || '').split(/\n+/).filter((line) => line.length > 0);
    if (lines.length === 0) {
        return '<p class="text-muted">譛ｬ譁・↑縺・/p>';
    }
    return lines.map((line) => `<p class="clause-p">${escapeHtmlText(line)}</p>`).join('');
};

const isMeaningfulAnalysisPayload = (payload) => {
    if (!payload || typeof payload !== 'object') return false;
    const summary = String(payload.summary || '').trim();
    const riskReason = String(payload.riskReason || '').trim();
    const changes = Array.isArray(payload.changes) ? payload.changes.filter(Boolean) : [];

    if (changes.length > 0) return true;
    if (!summary) return false;
    if (/縺ｾ縺�隗｣譫舌＆繧後※縺・∪縺帙ｓ|豈碑ｼ・・繧帝∈謚槭☆繧九→|AI隗｣譫舌′縺ゅｊ縺ｾ縺帙ｓ|隗｣譫舌ョ繝ｼ繧ｿ縺ｪ縺慾繝ｭ繝ｼ繧ｫ繝ｫ繝・せ繝医Δ繝ｼ繝榎繝ｭ繝ｼ繧ｫ繝ｫ蟾ｮ蛻・ｦ∫ｴл繝ｭ繝ｼ繧ｫ繝ｫ隕∫ｴл陬懷ｮ瑚ｧ｣譫舌ｒ霑斐＠縺ｾ縺励◆|陬懷ｮ瑚ｦ∫ｴл陬懷ｮ悟ｷｮ蛻・ｦ∫ｴлAI蟾ｮ蛻・ｦ∫ｴ・ｒ蜿門ｾ励〒縺阪∪縺帙ｓ縺ｧ縺励◆/.test(summary)) return false;
    if (/繝ｭ繝ｼ繧ｫ繝ｫ繝・せ繝医Δ繝ｼ繝榎譛ｬ逡ｪAI隗｣譫舌〒縺ｯ縺ゅｊ縺ｾ縺帙ｓ|Gemini蠢懃ｭ比ｸ榊ｮ牙ｮ・.test(riskReason)) return false;
    return true;
};

const hasAnalysisRecord = (payload) => {
    if (!payload || typeof payload !== 'object') return false;
    const summary = String(payload.summary || '').trim();
    const riskReason = String(payload.riskReason || '').trim();
    const changes = Array.isArray(payload.changes) ? payload.changes.filter(Boolean) : [];
    return Boolean(summary || riskReason || changes.length > 0 || payload.isFallback === true || payload.aiFailed === true);
};

const sanitizeAnalysisPayload = (payload) => {
    const base = (payload && typeof payload === 'object') ? payload : {};
    const changes = Array.isArray(base.changes) ? base.changes.filter(Boolean) : [];
    const summaryRaw = String(base.summary || '').trim();
    const reasonRaw = String(base.riskReason || '').trim();
    const hasFallbackPhrase = /繝ｭ繝ｼ繧ｫ繝ｫ繝・せ繝医Δ繝ｼ繝榎繝ｭ繝ｼ繧ｫ繝ｫ蟾ｮ蛻・ｦ∫ｴл繝ｭ繝ｼ繧ｫ繝ｫ隕∫ｴл譛ｬ逡ｪAI隗｣譫舌〒縺ｯ縺ゅｊ縺ｾ縺帙ｓ|Gemini蠢懃ｭ比ｸ榊ｮ牙ｮ嘶陬懷ｮ瑚ｧ｣譫舌ｒ霑斐＠縺ｾ縺励◆|陬懷ｮ瑚ｦ∫ｴл陬懷ｮ悟ｷｮ蛻・ｦ∫ｴлAI隧穂ｾ｡繧剃ｸ驛ｨ陬懷ｮ瑚｡ｨ遉ｺ縺励※縺・∪縺處AI隧穂ｾ｡繧貞叙蠕励〒縺阪↑縺九▲縺溘◆繧∬｣懷ｮ瑚ｧ｣譫舌ｒ陦ｨ遉ｺ縺励※縺・∪縺處AI隧穂ｾ｡繧貞叙蠕励〒縺阪↑縺九▲縺溘◆繧∬｣懷ｮ悟ｷｮ蛻・ｒ陦ｨ遉ｺ縺励※縺・∪縺處AI隧穂ｾ｡繧貞叙蠕励〒縺阪↑縺九▲縺溘◆繧∬｣懷ｮ瑚ｦ∫ｴ・ｒ陦ｨ遉ｺ縺励※縺・∪縺處AI蟾ｮ蛻・ｦ∫ｴ・ｒ蜿門ｾ励〒縺阪∪縺帙ｓ縺ｧ縺励◆|AI蟾ｮ蛻・ｦ∫ｴ・悴蜿門ｾ・.test(`${summaryRaw} ${reasonRaw}`);
    const isFallback = base.isFallback === true || hasFallbackPhrase;

    if (!isFallback) {
        return {
            ...base,
            changes,
            isFallback
        };
    }

    const impactSnippets = changes
        .map((c) => String(c.impact || '').trim())
        .filter(Boolean)
        .slice(0, 2);
    const canKeepOriginalSummary = Boolean(
        summaryRaw
        && !/AI蟾ｮ蛻・ｦ∫ｴ・ｒ蜿門ｾ励〒縺阪∪縺帙ｓ縺ｧ縺励◆|AI蟾ｮ蛻・ｦ∫ｴ・悴蜿門ｾ慾蟾ｮ蛻・・讀懷・縺輔ｌ縺ｾ縺帙ｓ縺ｧ縺励◆|螟画峩轤ｹ縺ｯ讀懷・縺輔ｌ縺ｾ縺帙ｓ縺ｧ縺励◆|螟画峩轤ｹ繧堤｢ｺ隱阪＠縺ｦ縺上□縺輔＞/.test(summaryRaw)
        && !/\d+莉ｶ縺ｮ螟画峩轤ｹ?繧呈､懷・縺励∪縺励◆/.test(summaryRaw)
    );
    const sectionLabels = changes
        .map((c) => String(c.section || '').trim())
        .filter(Boolean)
        .slice(0, 3);
    const sectionHint = sectionLabels.length > 0 ? `・・{sectionLabels.join('縲・)}・荏 : '';
    const summary = canKeepOriginalSummary
        ? summaryRaw
        : (impactSnippets.length > 0
            ? `${impactSnippets.join(' ')}${changes.length > impactSnippets.length ? ` 縺ｻ縺・{changes.length - impactSnippets.length}莉ｶ縺ｮ螟画峩縺後≠繧翫∪縺吶Ａ : ''}`.trim()
            : (changes.length > 0
                ? `${changes.length}莉ｶ縺ｮ螟画峩轤ｹ繧呈､懷・縺励∪縺励◆${sectionHint}縲Ａ
                : '螟画峩轤ｹ繧堤｢ｺ隱阪＠縺ｦ縺上□縺輔＞縲・));

    return {
        ...base,
        summary,
        riskReason: '螟画峩轤ｹ繧定ｦ∫｢ｺ隱・,
        changes,
        isFallback
    };
};

const hasMeaningfulAiSummary = (payload) => {
    if (!payload || typeof payload !== 'object') return false;
    const summary = String(payload.summary || '').trim();
    const riskReason = String(payload.riskReason || '').trim();
    if (!summary) return false;
    const combined = `${summary} ${riskReason}`;
    if (/AI蟾ｮ蛻・ｦ∫ｴ・ｒ蜿門ｾ励〒縺阪∪縺帙ｓ縺ｧ縺励◆|AI蟾ｮ蛻・ｦ∫ｴ・悴蜿門ｾ慾AI蟾ｮ蛻・悴菫晏ｭ・縺ｾ縺�菫晏ｭ倥＆繧後※縺・∪縺帙ｓ|蟾ｮ蛻・・讀懷・縺輔ｌ縺ｾ縺帙ｓ縺ｧ縺励◆|螟画峩轤ｹ縺ｯ讀懷・縺輔ｌ縺ｾ縺帙ｓ縺ｧ縺励◆|隗｣譫舌ョ繝ｼ繧ｿ縺ｪ縺・.test(combined)) {
        return false;
    }
    return true;
};

const mergeStructuredChangesWithAnalysis = (structuredChanges, analysisChanges) => {
    const baseChanges = Array.isArray(structuredChanges) ? structuredChanges.filter(Boolean) : [];
    const aiChanges = Array.isArray(analysisChanges) ? analysisChanges.filter(Boolean) : [];
    if (baseChanges.length === 0) return aiChanges;
    if (aiChanges.length === 0) return baseChanges;

    return baseChanges.map((base) => {
        const matched = aiChanges.find((candidate) => {
            const baseSection = String(base?.section || '').trim();
            const candidateSection = String(candidate?.section || '').trim();
            if (baseSection && candidateSection && baseSection === candidateSection) return true;
            const baseType = resolveDisplayChangeType(base);
            const candidateType = resolveDisplayChangeType(candidate);
            if (baseType !== candidateType) return false;
            return String(base?.old || '').trim() === String(candidate?.old || '').trim()
                || String(base?.new || '').trim() === String(candidate?.new || '').trim();
        });

        return matched
            ? {
                ...base,
                impact: matched.impact || base.impact || '',
                concern: matched.concern || base.concern || ''
            }
            : base;
    });
};

const isReusableAnalysisPayload = (payload) => {
    const normalized = sanitizeAnalysisPayload(payload);
    return isMeaningfulAnalysisPayload(normalized) && normalized.isFallback !== true;
};

const buildStoredContractAnalysis = (contract) => {
    if (!contract) return null;
    const changes = Array.isArray(contract.ai_changes) ? contract.ai_changes.filter(Boolean) : [];
    const summary = String(contract.ai_summary || '').trim();
    const riskReason = String(contract.ai_risk_reason || '').trim();
    if (!summary && changes.length === 0) return null;
    return {
        summary: summary || 'AI隗｣譫舌′螳御ｺ・＠縺ｾ縺励◆',
        riskLevel: contract.risk_level === 'High' ? 3 : (contract.risk_level === 'Medium' ? 2 : 1),
        riskReason: riskReason || '繝ｪ繧ｹ繧ｯ蛻､螳壹′螳御ｺ・＠縺ｾ縺励◆',
        changes,
        isFallback: contract.ai_is_fallback === true
    };
};

const extractChangeDisplayKey = (change) => {
    const section = String(change?.section || '').trim();
    const explicitNumber = Number(change?.articleNumber || change?.oldArticleNumber || 0);
    if (explicitNumber > 0) return `article:${explicitNumber}`;
    const articleMatch = section.match(/^隨ｬ\s*[0-9・・・吩ｸ莠御ｸ牙屁莠泌・荳・・荵晏香逋ｾ蜊・・峺]+\s*譚｡/);
    if (articleMatch) {
        return `section:${articleMatch[0].replace(/\s+/g, '')}`;
    }
    return section ? `section:${section}` : '';
};

const resolveDisplayChangeType = (change) => {
    const oldText = String(change?.old || '').trim();
    const newText = String(change?.new || '').trim();
    if (oldText && newText) return 'MODIFY';
    if (newText) return 'ADD';
    if (oldText) return 'DELETE';
    const rawType = String(change?.type || '').toUpperCase();
    return ['ADD', 'DELETE', 'MODIFY'].includes(rawType) ? rawType : 'MODIFY';
};

const normalizeChangesForDisplay = (changes) => {
    const items = Array.isArray(changes) ? changes.filter(Boolean) : [];
    const used = new Set();
    const normalized = [];

    for (let index = 0; index < items.length; index += 1) {
        if (used.has(index)) continue;
        const current = items[index];
        const currentType = resolveDisplayChangeType(current);
        const currentKey = extractChangeDisplayKey(current);

        if ((currentType === 'ADD' || currentType === 'DELETE') && currentKey) {
            const oppositeType = currentType === 'ADD' ? 'DELETE' : 'ADD';
            const matchIndex = items.findIndex((candidate, candidateIndex) => {
                if (candidateIndex <= index || used.has(candidateIndex)) return false;
                if (resolveDisplayChangeType(candidate) !== oppositeType) return false;
                return extractChangeDisplayKey(candidate) === currentKey;
            });

            if (matchIndex >= 0) {
                const matched = items[matchIndex];
                used.add(matchIndex);
                normalized.push({
                    ...current,
                    section: String(current.section || matched.section || '').trim(),
                    type: 'MODIFY',
                    old: currentType === 'DELETE' ? current.old : matched.old,
                    new: currentType === 'ADD' ? current.new : matched.new,
                    impact: current.impact || matched.impact || '',
                    concern: current.concern || matched.concern || ''
                });
                continue;
            }
        }

        normalized.push({
            ...current,
            type: currentType
        });
    }

    return normalized;
};

const isExplicitNoDiffAnalysis = (payload) => {
    const normalized = sanitizeAnalysisPayload(payload);
    const summary = String(normalized.summary || '').trim();
    const riskReason = String(normalized.riskReason || '').trim();
    const changes = Array.isArray(normalized.changes) ? normalized.changes.filter(Boolean) : [];
    if (changes.length > 0) return false;
    return /蟾ｮ蛻・・讀懷・縺輔ｌ縺ｾ縺帙ｓ縺ｧ縺励◆|螟画峩轤ｹ縺ｯ讀懷・縺輔ｌ縺ｾ縺帙ｓ縺ｧ縺励◆/.test(`${summary} ${riskReason}`);
};

const buildParagraphDiffOps = (previousParagraphs, currentParagraphs) => {
    const oldItems = Array.isArray(previousParagraphs) ? previousParagraphs.map((item) => String(item || '').trim()) : [];
    const newItems = Array.isArray(currentParagraphs) ? currentParagraphs.map((item) => String(item || '').trim()) : [];
    const m = oldItems.length;
    const n = newItems.length;
    const lcs = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

    for (let i = m - 1; i >= 0; i -= 1) {
        for (let j = n - 1; j >= 0; j -= 1) {
            if (oldItems[i] === newItems[j]) {
                lcs[i][j] = lcs[i + 1][j + 1] + 1;
            } else {
                lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
            }
        }
    }

    const ops = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (oldItems[i] === newItems[j]) {
            ops.push({ type: 'equal', value: oldItems[i] });
            i += 1;
            j += 1;
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
            ops.push({ type: 'delete', value: oldItems[i] });
            i += 1;
        } else {
            ops.push({ type: 'add', value: newItems[j] });
            j += 1;
        }
    }

    while (i < m) {
        ops.push({ type: 'delete', value: oldItems[i] });
        i += 1;
    }
    while (j < n) {
        ops.push({ type: 'add', value: newItems[j] });
        j += 1;
    }

    return ops;
};

const buildClauseLevelChange = (section, previousClause, currentClause) => {
    if (!previousClause && !currentClause) return null;
    if (!previousClause && currentClause) {
        return {
            section,
            type: 'ADD',
            old: '',
            new: clauseBodyText(currentClause),
            impact: '',
            concern: ''
        };
    }
    if (previousClause && !currentClause) {
        return {
            section,
            type: 'DELETE',
            old: clauseBodyText(previousClause),
            new: '',
            impact: '',
            concern: ''
        };
    }

    const ops = buildParagraphDiffOps(clauseParagraphs(previousClause), clauseParagraphs(currentClause));
    const oldSegments = [];
    const newSegments = [];
    let pendingDeletes = [];
    let pendingAdds = [];

    const flushPending = () => {
        if (pendingDeletes.length === 0 && pendingAdds.length === 0) return;

        if (pendingDeletes.length > 0 && pendingAdds.length > 0) {
            oldSegments.push(pendingDeletes.join('\n'));
            newSegments.push(pendingAdds.join('\n'));
        } else if (pendingDeletes.length > 0) {
            oldSegments.push(pendingDeletes.join('\n'));
        } else if (pendingAdds.length > 0) {
            newSegments.push(pendingAdds.join('\n'));
        }

        pendingDeletes = [];
        pendingAdds = [];
    };

    ops.forEach((op) => {
        if (op.type === 'equal') {
            flushPending();
            return;
        }
        if (op.type === 'delete') {
            if (op.value) pendingDeletes.push(op.value);
            return;
        }
        if (op.type === 'add') {
            if (op.value) pendingAdds.push(op.value);
        }
    });
    flushPending();

    const oldText = oldSegments.filter(Boolean).join('\n\n').trim();
    const newText = newSegments.filter(Boolean).join('\n\n').trim();

    if (!oldText && !newText) {
        return null;
    }

    let type = 'MODIFY';
    if (!oldText && newText) type = 'ADD';
    else if (oldText && !newText) type = 'DELETE';

    return {
        section,
        type,
        old: oldText,
        new: newText,
        impact: '',
        concern: ''
    };
};

const buildStructuredFallbackAnalysis = (previousContent, currentContent) => {
    if (!isStructuredDocumentContent(previousContent) && !isStructuredDocumentContent(currentContent)) {
        return null;
    }

    const previousClauses = parseContractIntoClauses(previousContent);
    const currentClauses = parseContractIntoClauses(currentContent);
    if (previousClauses.length === 0 && currentClauses.length === 0) {
        return null;
    }

    const previousMap = new Map(previousClauses.map((clause) => [clauseIdentityKey(clause), clause]));
    const currentMap = new Map(currentClauses.map((clause) => [clauseIdentityKey(clause), clause]));
    const orderedKeys = [];

    currentClauses.forEach((clause) => {
        const key = clauseIdentityKey(clause);
        if (!orderedKeys.includes(key)) orderedKeys.push(key);
    });
    previousClauses.forEach((clause) => {
        const key = clauseIdentityKey(clause);
        if (!orderedKeys.includes(key)) orderedKeys.push(key);
    });

    const changes = orderedKeys.map((key) => {
        const previousClause = previousMap.get(key) || null;
        const currentClause = currentMap.get(key) || null;
        const section = composeClauseHeading(
            currentClause?.title || previousClause?.title || '譚｡譁・,
            currentClause?.header || previousClause?.header || ''
        );
        return buildClauseLevelChange(section, previousClause, currentClause);
    }).filter(Boolean);

    if (changes.length === 0) {
        return {
            summary: '蟾ｮ蛻・・讀懷・縺輔ｌ縺ｾ縺帙ｓ縺ｧ縺励◆',
            riskLevel: 1,
            riskReason: '蟾ｮ蛻・・讀懷・縺輔ｌ縺ｾ縺帙ｓ縺ｧ縺励◆',
            changes: [],
            isFallback: true
        };
    }

    const previewChanges = changes.slice(0, 3);
    const previewSections = previewChanges.map((item) => item.section).filter(Boolean);
    const hasDelete = changes.some((item) => item.type === 'DELETE');
    const hasAdd = changes.some((item) => item.type === 'ADD');
    const hasModify = changes.some((item) => item.type === 'MODIFY');
    const modifyCount = changes.filter((item) => item.type === 'MODIFY').length;
    const addCount = changes.filter((item) => item.type === 'ADD').length;
    const deleteCount = changes.filter((item) => item.type === 'DELETE').length;
    let riskReason = '譚｡譁・ｷｮ蛻・ｒ讀懷・縺励∪縺励◆';
    if (hasDelete && (hasAdd || hasModify)) {
        riskReason = '霑ｽ蜉�繝ｻ蜑企勁繝ｻ螟画峩繧呈､懷・縺励∪縺励◆';
    } else if (hasDelete) {
        riskReason = '蜑企勁繧呈､懷・縺励∪縺励◆';
    } else if (hasAdd && hasModify) {
        riskReason = '霑ｽ蜉�繝ｻ螟画峩繧呈､懷・縺励∪縺励◆';
    } else if (hasAdd) {
        riskReason = '霑ｽ蜉�繧呈､懷・縺励∪縺励◆';
    } else if (hasModify) {
        riskReason = '螟画峩繧呈､懷・縺励∪縺励◆';
    }

    const previewText = previewChanges.map((item) => {
        const typeLabel = item.type === 'ADD' ? '霑ｽ蜉�' : (item.type === 'DELETE' ? '蜑企勁' : '螟画峩');
        return `${item.section}縺ｧ${typeLabel}`;
    }).join('縲・);
    const suffix = changes.length > previewChanges.length
        ? `縲ゅ⊇縺・{changes.length - previewChanges.length}譚｡譁・〒繧ょ､画峩縺後≠繧翫∪縺吶Ａ
        : '縲・;
    let summary = `${previewText}${suffix}`;
    if (!previewText) {
        const summaryParts = [];
        if (modifyCount > 0) summaryParts.push(`螟画峩 ${modifyCount}莉ｶ`);
        if (addCount > 0) summaryParts.push(`霑ｽ蜉� ${addCount}莉ｶ`);
        if (deleteCount > 0) summaryParts.push(`蜑企勁 ${deleteCount}莉ｶ`);
        summary = summaryParts.length > 0
            ? `${summaryParts.join('縲・)}繧堤｢ｺ隱阪＠縺ｾ縺励◆縲Ａ
            : '螟画峩轤ｹ繧堤｢ｺ隱阪＠縺ｦ縺上□縺輔＞縲・;
    }

    return {
        summary: summary.trim(),
        riskLevel: hasDelete ? 2 : 1,
        riskReason,
        changes,
        isFallback: true
    };
};

const isCurrentVsLatestHistoryPair = (documentOptions, sourceDoc, targetDoc) => {
    if (!Array.isArray(documentOptions) || !sourceDoc || !targetDoc?.is_current) return false;
    const historicalDocs = documentOptions.filter((doc) => !doc.is_current);
    if (historicalDocs.length === 0) return false;
    const latestHistoricalDoc = historicalDocs.reduce((latest, doc) => {
        if (!latest) return doc;
        return (Number(doc.sort_order || 0) > Number(latest.sort_order || 0)) ? doc : latest;
    }, null);
    return Boolean(latestHistoricalDoc && latestHistoricalDoc.id === sourceDoc.id);
};

const contentToComparableText = (content) => {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content.trim();
    if (typeof content === 'number' || typeof content === 'boolean') return String(content);

    if (Array.isArray(content)) {
        return content.map((item, idx) => {
            if (typeof item === 'string') return item;
            if (!item || typeof item !== 'object') return String(item || '');
            const article = String(item.article || item.articleNumber || `隨ｬ${idx + 1}譚｡`).trim();
            const title = String(item.title || '').trim();
            const header = title ? `${article} ${title}`.trim() : article;
            const paragraphs = Array.isArray(item.paragraphs)
                ? item.paragraphs.map((p) => {
                    if (typeof p === 'string') return p;
                    if (p && typeof p === 'object') return String(p.content || p.body || '');
                    return '';
                }).filter(Boolean).join('\n')
                : String(item.body || item.content || '');
            return `${header}\n${paragraphs}`.trim();
        }).filter(Boolean).join('\n\n').trim();
    }

    if (typeof content === 'object' && Array.isArray(content.articles)) {
        const preamble = String(content.preamble || '').trim();
        const articleText = contentToComparableText(content.articles);
        return [preamble, articleText].filter(Boolean).join('\n\n').trim();
    }

    try {
        return JSON.stringify(content);
    } catch {
        return String(content);
    }
};

const resolveExtractedContentPayload = (data) => {
    if (!data || typeof data !== 'object') return null;
    const candidates = [
        data.structuredContract,
        data.extractedText,
        data.structured_contract,
        data.extracted_text,
        data.contractText,
        data.text
    ];
    for (const candidate of candidates) {
        if (candidate === null || candidate === undefined) continue;
        if (typeof candidate === 'string' && candidate.trim().length === 0) continue;
        return candidate;
    }
    return null;
};

const normalizeDiffContractId = (value) => {
    if (value && typeof value === 'object') {
        return normalizeDiffContractId(value.id ?? value.contractId ?? value.contract_id ?? null);
    }
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : null;
};

const renderStructuredDiffParagraphColumn = (paragraphs, counterpartParagraphs, tone) => {
    const own = Array.isArray(paragraphs) ? paragraphs : [];
    const other = Array.isArray(counterpartParagraphs) ? counterpartParagraphs : [];
    const maxLength = Math.max(own.length, other.length, 1);
    const html = [];

    for (let i = 0; i < maxLength; i += 1) {
        const current = String(own[i] ?? '');
        const counterpart = String(other[i] ?? '');

        if (!current && !counterpart) {
            continue;
        }

        const paragraphClasses = ['clause-p', 'structured-diff-paragraph'];
        let paragraphHtml = escapeHtmlText(current);

        if (!current && counterpart) {
            paragraphClasses.push('structured-diff-empty');
            paragraphHtml = '';
        } else if (current && !counterpart) {
            paragraphClasses.push(tone === 'old' ? 'structured-diff-removed' : 'structured-diff-added');
            paragraphHtml = escapeHtmlText(current);
        } else if (current === counterpart) {
            paragraphHtml = escapeHtmlText(current);
        } else if (window.Diff && typeof window.Diff.diffWordsWithSpace === 'function') {
            const oldText = tone === 'old' ? current : counterpart;
            const newText = tone === 'old' ? counterpart : current;
            const chunks = window.Diff.diffWordsWithSpace(oldText, newText);
            const fragmentHtml = [];
            for (const chunk of chunks) {
                const safe = escapeHtmlText(chunk.value);
                if (chunk.added) {
                    if (tone === 'new') {
                        fragmentHtml.push(`<ins>${safe}</ins>`);
                    }
                } else if (chunk.removed) {
                    if (tone === 'old') {
                        fragmentHtml.push(`<del>${safe}</del>`);
                    }
                } else {
                    fragmentHtml.push(safe);
                }
            }
            paragraphHtml = fragmentHtml.join('') || escapeHtmlText(current);
            paragraphClasses.push(tone === 'old' ? 'structured-diff-removed' : 'structured-diff-added');
        } else {
            paragraphClasses.push(tone === 'old' ? 'structured-diff-removed' : 'structured-diff-added');
            paragraphHtml = escapeHtmlText(current);
        }

        html.push(`<p class="${paragraphClasses.join(' ')}">${paragraphHtml || '縲'}</p>`);
    }

    return html.join('') || '<p class="clause-p text-muted">譛ｬ譁・↑縺・/p>';
};

const renderStructuredDiffView = (previousContent, currentContent, options = {}) => {
    const {
        idPrefix = 'structured-diff'
    } = options;
    const previousClauses = parseContractIntoClauses(previousContent);
    const currentClauses = parseContractIntoClauses(currentContent);

    if (previousClauses.length === 0 && currentClauses.length === 0) {
        return '<div class="text-center text-muted" style="padding:40px;">豈碑ｼ・〒縺阪ｋ譚｡譁・ョ繝ｼ繧ｿ縺後≠繧翫∪縺帙ｓ</div>';
    }

    const previousMap = new Map(previousClauses.map((clause) => [clauseIdentityKey(clause), clause]));
    const currentMap = new Map(currentClauses.map((clause) => [clauseIdentityKey(clause), clause]));
    const orderedKeys = [];

    currentClauses.forEach((clause) => {
        const key = clauseIdentityKey(clause);
        if (!orderedKeys.includes(key)) orderedKeys.push(key);
    });
    previousClauses.forEach((clause) => {
        const key = clauseIdentityKey(clause);
        if (!orderedKeys.includes(key)) orderedKeys.push(key);
    });

    const renderClauseCard = (key, currentClause, previousClause, index) => {
        const title = currentClause?.title || previousClause?.title || '譚｡譁・;
        const header = currentClause?.header || previousClause?.header || '';
        const previousParagraphs = clauseParagraphs(previousClause);
        const currentParagraphs = clauseParagraphs(currentClause);
        const previousHtml = renderStructuredDiffParagraphColumn(previousParagraphs, currentParagraphs, 'old');
        const currentHtml = renderStructuredDiffParagraphColumn(currentParagraphs, previousParagraphs, 'new');
        const fullClauseTitle = composeClauseHeading(title, header);
        const clauseId = `${idPrefix}-clause-${index}`;

        return `
            <article class="clause-card diff-card structured-diff-card" id="${clauseId}">
                <div class="clause-header diff-header">
                    <span class="clause-num">${escapeHtmlText(fullClauseTitle)}</span>
                </div>
                <div class="diff-compare structured-diff-grid">
                    <div class="diff-old structured-diff-pane">
                        <div class="diff-text structured-diff-text">${previousHtml}</div>
                    </div>
                    <div class="diff-new structured-diff-pane">
                        <div class="diff-text structured-diff-text">${currentHtml}</div>
                    </div>
                </div>
            </article>
        `;
    };

    const cards = orderedKeys.map((key, index) => {
        const previousClause = previousMap.get(key) || null;
        const currentClause = currentMap.get(key) || null;
        return renderClauseCard(key, currentClause, previousClause, index);
    }).join('');

    const navHtml = `
        <div class="clause-nav">
            <div class="clause-nav-title">譚｡譁・岼谺｡</div>
            <ul class="clause-nav-list">
                ${orderedKeys.map((key, index) => {
        const previousClause = previousMap.get(key) || null;
        const currentClause = currentMap.get(key) || null;
        const title = currentClause?.title || previousClause?.title || '譚｡譁・;
        const header = currentClause?.header || previousClause?.header || '';
        const fullClauseTitle = composeClauseHeading(title, header);
        const clauseId = `${idPrefix}-clause-${index}`;
        return `
                        <li class="clause-nav-item" data-clause-id="${clauseId}" onclick="window.app?.scrollToClause('${clauseId}')" title="${escapeHtmlText(fullClauseTitle)}">
                            <span class="nav-clause-num">${escapeHtmlText(fullClauseTitle)}</span>
                        </li>
                    `;
    }).join('')}
            </ul>
        </div>
    `;

    return `
        <div class="contract-structured-container structured-diff-shell">
            ${navHtml}
            <div class="clause-cards-container structured-diff-stack">
                ${cards}
                <div style="height: 40px; flex-shrink: 0;"></div>
            </div>
        </div>
    `;
};

// --- Static Content ---

// --- View Renderers Helpers ---

/**
 * 螂醍ｴ・嶌繧呈擅譁・腰菴搾ｼ育ｬｬn譚｡・峨〒蛻・牡縺吶ｋ
 */
const parseContractIntoClauses = (content) => {
    if (!content) return [];

    const applyHeadingPromotion = (title, header, paragraphs) => {
        let nextHeader = String(header || '').trim();
        let nextParagraphs = Array.isArray(paragraphs) ? [...paragraphs] : [];
        if (!nextHeader && title !== '蜑肴枚' && nextParagraphs.length > 0) {
            const firstRaw = String(nextParagraphs[0] || '').trim();
            const bracketed = firstRaw.match(/^([・・縲疹[^・・縲曽{1,20}[・・縲曽)\s*(.*)$/);
            if (bracketed && !String(bracketed[1]).includes('縲・)) {
                nextHeader = String(bracketed[1] || '').trim();
                const rest = String(bracketed[2] || '').trim();
                if (rest) {
                    nextParagraphs[0] = rest;
                } else {
                    nextParagraphs = nextParagraphs.slice(1);
                }
            } else {
                const looksLikeHeading = firstRaw.length > 0 && firstRaw.length <= 20 && !firstRaw.includes('縲・);
                if (looksLikeHeading) {
                    nextHeader = firstRaw;
                    nextParagraphs = nextParagraphs.slice(1);
                }
            }
        }
        return { header: nextHeader, paragraphs: nextParagraphs };
    };

    // structuredContract support: { title, version, preamble, articles[] }
    if (typeof content === 'object' && !Array.isArray(content) && Array.isArray(content.articles)) {
        const normalized = normalizeStructuredDisplayContent(content);
        const clauses = [];
        if (normalized.preamble) {
            clauses.push({
                title: '蜑肴枚',
                header: normalized.title || '',
                paragraphs: String(normalized.preamble).split(/\n+/).filter(Boolean)
            });
        }
        normalized.articles.forEach((item, idx) => {
            const promoted = applyHeadingPromotion(
                item.articleNumber || `隨ｬ${idx + 1}譚｡`,
                item.title || '',
                String(item.content || '').split(/\n+/).filter(Boolean)
            );
            clauses.push({
                title: item.articleNumber || `隨ｬ${idx + 1}譚｡`,
                header: promoted.header,
                paragraphs: promoted.paragraphs
            });
        });
        return clauses;
    }

    // If content is already structured (Array from backend)
    if (Array.isArray(content)) {
        return content.map((item, idx) => {
            let title = item.article || (idx === 0 ? '蜑肴枚' : `隨ｬ${idx}譚｡`);
            // 縲悟燕譁・繝倥ャ繝繝ｼ縲阪↑縺ｩ縺ｮ蜀鈴聞縺ｪ陦ｨ險倥ｒ豁｣隕丞喧
            if (title === '蜑肴枚/繝倥ャ繝繝ｼ') title = '蜑肴枚';

            const promoted = applyHeadingPromotion(
                title,
                item.title || '',
                Array.isArray(item.paragraphs) ? item.paragraphs : (item.body ? item.body.split(/\n+/) : [])
            );
            let header = promoted.header;
            let paragraphs = promoted.paragraphs;
            // 縲悟燕譁・繝倥ャ繝繝ｼ縲阪′繧ｿ繧､繝医Ν縺ｨ驥崎､・☆繧句�ｴ蜷医・髱櫁｡ｨ遉ｺ縺ｫ縺吶ｋ
            if (idx === 0 && (header === '蜑肴枚/繝倥ャ繝繝ｼ' || header === '蜑肴枚' || header === title)) {
                header = '';
            }
            return {
                title: title,
                header: header,
                paragraphs
            };
        });
    }

    // Fallback: parse from plain text
    const lines = content.split(/\r?\n/);
    const clauses = [];
    let currentClause = { title: '蜑肴枚', header: '', body: [] };

    const clauseRegex = /^(?:隨ｬ\s*[\d・・・兢+\s*譚｡|縲申s*隨ｬ\s*[\d・・・兢+\s*譚｡\s*縲・/;

    lines.forEach(line => {
        const trimmedLine = line.trim();
        if (clauseRegex.test(trimmedLine)) {
            if (currentClause.body.length > 0 || currentClause.title !== '蜑肴枚') {
                clauses.push({
                    title: currentClause.title,
                    header: currentClause.header,
                    paragraphs: currentClause.body
                });
            }
            // Split title into "Clause Number" and "Header" if possible
            const match = trimmedLine.match(/^(隨ｬ\s*[\d・・・兢+\s*譚｡|縲申s*隨ｬ\s*[\d・・・兢+\s*譚｡\s*縲・(.*)/);
            if (match) {
                const rawHeader = match[2].trim().replace(/^[\(・医疹|[・噂)縲曽$/g, '');
                const normalizedHeader = String(rawHeader || '');
                const isValidTitle = normalizedHeader.length > 0 && normalizedHeader.length <= 20 && !normalizedHeader.includes('縲・);
                currentClause = { title: match[1].replace(/[・・・兢/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)), header: isValidTitle ? normalizedHeader : '', body: [] };
                if (!isValidTitle && normalizedHeader) {
                    currentClause.body.push(normalizedHeader);
                }
            } else {
                currentClause = { title: trimmedLine, header: '', body: [] };
            }
        } else {
            if (trimmedLine.length > 0) currentClause.body.push(trimmedLine);
        }
    });

    if (currentClause.body.length > 0 || currentClause.title !== '蜑肴枚') {
        clauses.push({
            title: currentClause.title,
            header: currentClause.header,
            paragraphs: currentClause.body
        });
    }

    return clauses;
};

const composeClauseHeading = (title, header) => {
    const t = String(title || '').trim();
    const h = String(header || '').trim();
    if (!h) return t;
    if (/^[・・縲疹/.test(h)) return `${t}${h}`;
    return `${t} ${h}`.trim();
};

const formatDisplayTimestamp = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return raw.replace(/-/g, '/');
    }
    const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(raw)
        ? `${raw}:00:00`
        : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)
            ? `${raw}:00`
            : raw.replace(' ', 'T');
    const parsed = new Date(normalized);
    if (Number.isNaN(parsed.getTime())) return raw;
    return parsed.toLocaleString('ja-JP', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
};

const trimDocumentLabel = (value, fallback = '雉・侭') => {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    return raw.length > 42 ? `${raw.slice(0, 42)}...` : raw;
};

const buildComparisonLabel = (name, timestamp, fallbackName = '雉・侭') => {
    const label = trimDocumentLabel(name, fallbackName);
    const stamp = formatDisplayTimestamp(timestamp);
    return stamp ? `${label} / ${stamp}` : label;
};

const buildDocumentOptionLabel = (doc) => {
    if (!doc) return '';
    const primary = trimDocumentLabel(doc.document_name || '雉・侭', 64);
    const stamp = formatDisplayTimestamp(doc.uploaded_at);
    return stamp ? `${primary} | ${stamp}` : primary;
};

const renderStructuredView = (content, idPrefix = 'clause') => {
    try {
        const clauses = parseContractIntoClauses(content);
        if (!clauses || clauses.length === 0) return '<div class="text-muted p-4">陦ｨ遉ｺ縺ｧ縺阪ｋ蜀・ｮｹ縺後≠繧翫∪縺帙ｓ</div>';

        const navHtml = `
            <div class="clause-nav">
                <div class="clause-nav-title">譚｡譁・岼谺｡</div>
                <ul class="clause-nav-list">
                    ${clauses.map((c, i) => {
            const fullClauseTitle = composeClauseHeading(c.title, c.header);
            return `
                        <li class="clause-nav-item" data-clause-id="${idPrefix}-clause-${i}" onclick="window.app?.scrollToClause('${idPrefix}-clause-${i}')" title="${fullClauseTitle}">
                            <span class="nav-clause-num">${fullClauseTitle}</span>
                        </li>
                    `;
        }).join('')}
                </ul>
            </div>
        `;

        const cardsHtml = `
            <div class="clause-cards-container">
                ${clauses.map((c, i) => {
            const pTags = c.paragraphs && c.paragraphs.length > 0
                ? c.paragraphs.map(p => {
                    const text = typeof p === 'string' ? p : (p.body || p.content || JSON.stringify(p));
                    return `<p class="clause-p">${text.replace(/\n/g, '<br>')}</p>`;
                }).join('')
                : `<p class="text-muted">譛ｬ譁・↑縺・/p>`;

            const fullClauseTitle = composeClauseHeading(c.title, c.header);
            return `
                        <article class="clause-card" id="${idPrefix}-clause-${i}">
                            <div class="clause-header">
                                <span class="clause-num">${fullClauseTitle}</span>
                            </div>
                            <div class="clause-body">${pTags}</div>
                        </article>
                    `;
        }).join('')}
                <div style="height: 40px; flex-shrink: 0;"></div> <!-- Bottom spacer -->
            </div>
        `;

        return `
            <div class="contract-structured-container">
                ${navHtml}
                ${cardsHtml}
            </div>
        `;
    } catch (e) {
        console.error('renderStructuredView Error:', e);
        return `<div class="alert alert-danger">陦ｨ遉ｺ荳ｭ縺ｫ繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆: ${e.message}</div>`;
    }
};

const Views = {
    loading: (viewId = 'dashboard') => {
        const titleMap = {
            dashboard: '繝繝・す繝･繝懊・繝峨ｒ隱ｭ縺ｿ霎ｼ縺ｿ荳ｭ',
            contracts: '螂醍ｴ・ｸ隕ｧ繧定ｪｭ縺ｿ霎ｼ縺ｿ荳ｭ',
            diff: '隧ｳ邏ｰ繧定ｪｭ縺ｿ霎ｼ縺ｿ荳ｭ',
            history: '螻･豁ｴ繧定ｪｭ縺ｿ霎ｼ縺ｿ荳ｭ',
            team: '繝√・繝�諠・�ｱ繧定ｪｭ縺ｿ霎ｼ縺ｿ荳ｭ',
            plan: '繝励Λ繝ｳ諠・�ｱ繧定ｪｭ縺ｿ霎ｼ縺ｿ荳ｭ'
        };
        return `
            <div class="page-title">${titleMap[viewId] || '隱ｭ縺ｿ霎ｼ縺ｿ荳ｭ'}</div>
            <div class="shell-skeleton">
                <div class="skeleton-block" style="width:42%"></div>
                <div class="skeleton-block" style="width:66%"></div>
                <div style="display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px;">
                    <div class="skeleton-card"></div>
                    <div class="skeleton-card"></div>
                    <div class="skeleton-card"></div>
                </div>
                <div class="skeleton-row"></div>
                <div class="skeleton-row"></div>
                <div class="skeleton-row"></div>
            </div>
        `;
    },
    // 5. Plan Management (New)
    plan: () => {
        const sub = window.app ? window.app.subscription : null;
        const payment = window.app ? window.app.paymentStatus : null;
        if (!sub || !sub.plan) {
            return `
                <div class="page-title">繝励Λ繝ｳ邂｡逅・/div>
                <div class="plan-loading" style="text-align:center; padding:50px;">
                    <i class="fa-solid fa-spinner fa-spin" style="font-size:2rem; color:#c19b4a; margin-bottom:16px;"></i>
                    <p>蛻ｩ逕ｨ迥ｶ豕√ｒ遒ｺ隱阪＠縺ｦ縺・∪縺・..</p>
                </div>
            `;
        }

        const currentBillingCycle = sub.billingCycle === 'annual' ? 'annual' : 'monthly';
        const requestedBillingCycle = window.app?.planViewBillingCycle === 'annual' ? 'annual' : currentBillingCycle;
        const annualKnownUnavailable = window.app?.hasAnnualBillingPlans === false;
        const selectedBillingCycle =
            (annualKnownUnavailable && requestedBillingCycle === 'annual' && currentBillingCycle !== 'annual')
                ? 'monthly'
                : requestedBillingCycle;

        const currentCycleLabel = currentBillingCycle === 'annual' ? '蟷ｴ鬘・ : '譛磯｡・;
        const selectedCycleLabel = selectedBillingCycle === 'annual' ? '蟷ｴ鬘・ : '譛磯｡・;
        const planAvailability = window.app?.paymentPlanAvailability || null;
        const formatYen = (value) => `ﾂ･${Number(value).toLocaleString('ja-JP')}`;

        const plans = [
            {
                id: 'free',
                name: 'Free',
                prices: { monthly: 0, annual: 0 },
                features: [
                    'Word / PDF / URL 逋ｻ骭ｲ・夂┌蛻ｶ髯・,
                    'AI蟾ｮ蛻・メ繧ｧ繝・け・壽怦3蝗槭∪縺ｧ',
                    '髮ｻ蟄千ｽｲ蜷肴ｩ溯・・壽怦10蝗槭∪縺ｧ',
                    'AI隕∫ｴ・・繝ｪ繧ｹ繧ｯ蛻､螳夲ｼ・igh / Medium / Low・・,
                    '蟾ｮ蛻・ワ繧､繝ｩ繧､繝郁｡ｨ遉ｺ',
                    '繝√・繝�邂｡逅・・1莠ｺ'
                ]
            },
            {
                id: 'starter',
                name: 'Starter',
                prices: { monthly: 1480, annual: 14800 },
                features: [
                    'Word / PDF / URL 逋ｻ骭ｲ・夂┌蛻ｶ髯・,
                    'AI蟾ｮ蛻・メ繧ｧ繝・け・壽怦50蝗槭∪縺ｧ',
                    '髮ｻ蟄千ｽｲ蜷肴ｩ溯・・壽怦25蝗槭∪縺ｧ',
                    'AI隕∫ｴ・・繝ｪ繧ｹ繧ｯ蛻､螳・,
                    '蟾ｮ蛻・ワ繧､繝ｩ繧､繝医∝ｱ･豁ｴ邂｡逅・,
                    '隗｣譫舌Ο繧ｰ繝ｻ逶｣譟ｻ螻･豁ｴ縺ｮ髢ｲ隕ｧ',
                    '繝√・繝�邂｡逅・・1莠ｺ'
                ]
            },
            {
                id: 'business',
                name: 'Business',
                prices: { monthly: 4980, annual: 49800 },
                features: [
                    'Word / PDF / URL 逋ｻ骭ｲ・夂┌蛻ｶ髯・,
                    'AI蟾ｮ蛻・メ繧ｧ繝・け・壽怦120蝗槭∪縺ｧ',
                    '髮ｻ蟄千ｽｲ蜷肴ｩ溯・・壽怦100莉ｶ縺ｾ縺ｧ',
                    'AI隕∫ｴ・・繝ｪ繧ｹ繧ｯ蛻､螳・,
                    '豕慕噪蠖ｱ髻ｿ繝ｻ諛ｸ蠢ｵ轤ｹ縺ｮ隧ｳ邏ｰ隗｣隱ｬ',
                    '蟾ｮ蛻・ワ繧､繝ｩ繧､繝医∝・譫舌Ο繧ｰ',
                    '繝√・繝�邂｡逅・・3莠ｺ',
                    'PDF 繧ｨ繧ｯ繧ｹ繝昴・繝・
                ]
            },
            {
                id: 'pro',
                name: 'Pro',
                prices: { monthly: 9800, annual: 98000 },
                features: [
                    'Word / PDF / URL 逋ｻ骭ｲ・夂┌蛻ｶ髯・,
                    'AI蟾ｮ蛻・メ繧ｧ繝・け・壽怦400蝗槭∪縺ｧ',
                    '髮ｻ蟄千ｽｲ蜷肴ｩ溯・・夂┌蛻ｶ髯・,
                    'AI隕∫ｴ・・繝ｪ繧ｹ繧ｯ蛻､螳・,
                    '豕慕噪蠖ｱ髻ｿ繝ｻ諛ｸ蠢ｵ轤ｹ縺ｮ隧ｳ邏ｰ隗｣隱ｬ',
                    '蟾ｮ蛻・ワ繧､繝ｩ繧､繝郁｡ｨ遉ｺ縲√ヰ繝ｼ繧ｸ繝ｧ繝ｳ螻･豁ｴ邂｡逅・,
                    '隗｣譫舌Ο繧ｰ繝ｻ逶｣譟ｻ螻･豁ｴ縺ｮ髢ｲ隕ｧ',
                    '螳壽悄URL逶｣隕悶・Slack・上Γ繝ｼ繝ｫ騾夂衍',
                    '繝√・繝�邂｡逅・・10莠ｺ',
                    'PDF 繧ｨ繧ｯ繧ｹ繝昴・繝・
                ]
            }
        ];

        const hasPayment = payment && payment.hasPaymentMethod;

        const cards = plans.map((p) => {
            const isBusiness = p.id === 'business';
            const isCurrentPlan = sub.plan === p.id;
            const isCurrentSelection = isCurrentPlan && currentBillingCycle === selectedBillingCycle;
            const hideCurrentButtonInAnnual = selectedBillingCycle === 'annual' && isCurrentSelection;
            const isFree = p.id === 'free';
            const selectedPrice = p.prices[selectedBillingCycle] || p.prices.monthly;
            const selectedUnit = selectedBillingCycle === 'annual' ? ' / 蟷ｴ' : ' / 譛・;
            const annualMonthlyEquivalent = Math.round(p.prices.annual / 12);
            const annualRegularPrice = p.prices.monthly * 12;
            const canStartSelectedCycle = isFree || !planAvailability || Boolean(planAvailability[selectedBillingCycle]?.[p.id]);
            const ctaDisabled = isCurrentSelection || (!isFree && !canStartSelectedCycle);
            const ctaLabel = isCurrentSelection
                ? '迴ｾ蝨ｨ蛻ｩ逕ｨ荳ｭ'
                : isFree
                    ? '繝励Λ繝ｳ繧貞､画峩縺吶ｋ'
                    : canStartSelectedCycle
                        ? '繝励Λ繝ｳ繧貞､画峩縺吶ｋ'
                        : `${selectedCycleLabel}縺ｯ貅門ｙ荳ｭ`;
            const ctaAction = ctaDisabled
                ? 'disabled'
                : isFree
                    ? `onclick="window.app.startSubscriptionCheckout('free', 'monthly')"`
                    : `onclick="window.app.startSubscriptionCheckout('${p.id}', '${selectedBillingCycle}')"`;
            const ctaStyleClass = ctaDisabled
                ? ''
                : (isBusiness ? 'plan-cta-business' : 'plan-cta-outline');

            return `
                <article class="plan-card ${isCurrentPlan ? 'is-current' : ''} ${isBusiness ? 'is-business' : 'is-muted'}">
                    <div class="plan-card-header">
                        ${isBusiness ? `<span class="plan-recommend-chip">縺翫☆縺吶ａ</span>` : ''}
                        ${isCurrentPlan ? `<span class="plan-current-chip">迴ｾ蝨ｨ縺ｮ螂醍ｴ・{isFree ? '' : `・・{currentCycleLabel}・荏}</span>` : ''}
                    </div>
                    <h3 class="plan-name">${p.name}</h3>
                    <div class="plan-pricing-block">
                        <div class="plan-price-line">
                            <span class="plan-price">${isFree ? '辟｡譁・ : formatYen(selectedPrice)}</span>
                            ${isFree ? '' : `<span class="plan-price-unit">${selectedUnit}</span>`}
                        </div>
                        <div class="plan-meta-slot ${isFree ? 'is-free-spacer' : (selectedBillingCycle === 'annual' ? 'is-annual' : 'is-monthly')}">
                            ${isFree ? '<div class="plan-annual-meta" style="visibility:hidden; height:54px;">spacer</div>' : `
                                <div class="plan-annual-meta">
                                    <p class="plan-effective">譛医≠縺溘ｊ <strong>${formatYen(annualMonthlyEquivalent)}</strong> 縺ｧ蛻ｩ逕ｨ</p>
                                    <p class="plan-compare">騾壼ｸｸ萓｡譬ｼ <span class="plan-regular">${formatYen(annualRegularPrice)}</span> 竊・蟷ｴ鬘榊粋險・<span>${formatYen(p.prices.annual)}</span></p>
                                    <p class="plan-discount">2繝ｶ譛亥・縺雁ｾ・/p>
                                </div>
                                <div class="plan-price-meta">
                                    蟷ｴ鬘阪↑繧・${formatYen(p.prices.annual)} / 蟷ｴ・・繝ｶ譛亥・縺雁ｾ暦ｼ・
                                </div>
                            `}
                        </div>
                    </div>
                    <ul class="plan-feature-list">
                        ${p.features.map((f) => `<li><i class="fa-solid fa-check"></i>${f}</li>`).join('')}
                    </ul>
                    ${hideCurrentButtonInAnnual
                    ? ''
                    : `
                    <button class="btn-dashboard plan-cta ${ctaStyleClass} ${isCurrentSelection ? 'is-current' : ''} ${!canStartSelectedCycle ? 'is-disabled' : ''}" ${ctaAction}>
                        ${ctaLabel}
                    </button>
                    `}
                </article>
            `;
        }).join('');

        let paymentSection = '';
        if (hasPayment) {
            const renewalText = (sub && sub.renewalDate)
                ? `<div style="margin-top:8px; font-size:13px; color:#555;">谺｡蝗樊峩譁ｰ譌･: <strong>${new Date(sub.renewalDate).toLocaleDateString('ja-JP')}</strong></div>`
                : '';
            paymentSection = `
                <div class="plan-payment-card is-ok compact">
                    <div class="plan-payment-title ok">
                        <i class="fa-solid fa-circle-check"></i>
                        <strong>縺頑髪謇輔＞譁ｹ豕輔′逋ｻ骭ｲ縺輔ｌ縺ｦ縺・∪縺・/strong>
                    </div>
                    ${renewalText}
                </div>
            `;
        } else {
            paymentSection = `
                <div class="plan-inline-alert-badge">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                    <span>縺頑髪謇輔＞譁ｹ豕輔′譛ｪ逋ｻ骭ｲ縺ｧ縺・/span>
                </div>
            `;
        }

        const cancelSection = `
            <div class="plan-cancel-section" style="margin: 20px 0 40px 0; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; text-align: left; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px;">
                    <div>
                        <h3 style="font-size: 1rem; font-weight: 700; color: #111827; margin: 0 0 4px 0;">繝励Λ繝ｳ縺ｮ隗｣邏・ｼ育┌譁吶・繝ｩ繝ｳ縺ｸ縺ｮ遘ｻ陦鯉ｼ・/h3>
                        <p style="color: #6b7280; font-size: 0.85rem; margin: 0;">譛画侭繝励Λ繝ｳ繧偵＃蛻ｩ逕ｨ縺ｮ蝣ｴ蜷医・縲√％縺｡繧峨°繧峨＞縺､縺ｧ繧りｧ｣邏・焔邯壹″縺悟庄閭ｽ縺ｧ縺吶・/p>
                    </div>
                    <button onclick="window.app.showCancelModal()" class="btn-dashboard plan-cancel-btn" style="background:#fff; color:#dc2626; border:1px solid #dc2626; padding:8px 16px; font-weight:600; border-radius:8px; white-space:nowrap;">
                        <i class="fa-solid fa-xmark"></i> 繝励Λ繝ｳ繧定ｧ｣邏・☆繧・
                    </button>
                </div>
            </div>
        `;

        return `
            <div class="page-title">繝励Λ繝ｳ邂｡逅・/div>
            <div class="plan-billing-toolbar">
                <div class="plan-cycle-switch" role="group" aria-label="隲区ｱゅし繧､繧ｯ繝ｫ蛻・崛">
                    <button class="plan-cycle-btn ${selectedBillingCycle === 'monthly' ? 'active' : ''}" onclick="window.app.setPlanBillingCycle('monthly')">譛磯｡・/button>
                    <button class="plan-cycle-btn ${selectedBillingCycle === 'annual' ? 'active' : ''}" onclick="window.app.setPlanBillingCycle('annual')" ${annualKnownUnavailable ? 'disabled' : ''}>蟷ｴ鬘搾ｼ・繝ｶ譛亥・縺雁ｾ暦ｼ・/button>
                </div>
                <p class="plan-cycle-note">${annualKnownUnavailable ? '蟷ｴ鬘阪・繝ｩ繝ｳ縺ｯ迴ｾ蝨ｨ貅門ｙ荳ｭ縺ｧ縺吶・ : ''}</p>
            </div>
            ${paymentSection}
            ${cancelSection}
            <div class="plan-grid">
                ${cards}
            </div>
        `;
    },
    // 1. Dashboard Overview
    dashboard: () => {
        const stats = dbService.getStats();
        const currentFilter = window.app ? window.app.dashboardFilter : 'pending';
        const filteredItems = dbService.getFilteredContracts(currentFilter);

        let sectionTitle = "隕∫｢ｺ隱阪い繧､繝・Β (蜆ｪ蜈亥ｺｦ鬆・";
        if (currentFilter === 'pending') sectionTitle = "譛ｪ蜃ｦ逅・・繧｢繧､繝・Β (譁ｰ逹繝ｻ螟画峩讀懃衍)";
        if (currentFilter === 'risk') sectionTitle = "繝ｪ繧ｹ繧ｯ隕∝愛螳壹い繧､繝・Β";
        if (currentFilter === 'total') sectionTitle = "蜈ｨ逶｣隕門ｯｾ雎｡・域怙譁ｰ鬆・ｼ・;

        const tableRows = filteredItems.length > 0 ? filteredItems.slice(0, 10).map(c => {
            let riskBadgeClass = 'badge-neutral';
            if (c.risk_level === 'High') riskBadgeClass = 'badge-danger';
            else if (c.risk_level === 'Medium') riskBadgeClass = 'badge-warning';
            else if (c.risk_level === 'Low') riskBadgeClass = 'badge-success';

            let statusBadge = '';
            if (c.status === '譛ｪ隗｣譫・) statusBadge = '<span class="badge badge-info">譛ｪ隗｣譫・(譁ｰ隕・</span>';
            else if (c.status === '譛ｪ蜃ｦ逅・) statusBadge = '<span class="badge badge-info">譛ｪ蜃ｦ逅・/span>';
            else if (c.status === '譛ｪ遒ｺ隱・) statusBadge = '<span class="badge badge-warning">隕∫｢ｺ隱・(螟画峩)</span>';
            else if (c.status === '遒ｺ隱肴ｸ・) statusBadge = '<span class="badge badge-neutral"><i class="fa-solid fa-check"></i> 遒ｺ隱肴ｸ・/span>';

            const actionBtn = window.app.can('operate_contract')
                ? `<button class="btn-dashboard">${c.status === '遒ｺ隱肴ｸ・ ? '螻･豁ｴ繧定ｦ九ｋ' : '遒ｺ隱阪☆繧・}</button>`
                : `<button class="btn-dashboard">隧ｳ邏ｰ繧定ｦ九ｋ</button>`;

            return `
                <tr onclick="window.app.navigate('diff', ${c.id})">
                    <td><span class="badge ${riskBadgeClass}">${c.risk_level === 'High' ? 'High' : (c.risk_level === 'Medium' ? 'Medium' : (c.risk_level === 'Low' ? 'Low' : c.risk_level))}</span></td>
                    <td class="col-name" title="${c.name}">${c.name}</td>
                    <td>${formatDisplayTimestamp(c.last_updated_at || c.last_analyzed_at || c.created_at)}</td>
                    <td>${statusBadge}</td>
                    <td>${actionBtn}</td>
                </tr>
            `;
        }).join('') : '<tr><td colspan="5" class="text-center text-muted" style="padding:40px;">隧ｲ蠖薙☆繧九い繧､繝・Β縺ｯ縺ゅｊ縺ｾ縺帙ｓ</td></tr>';

        return `
            <div class="page-title">繝繝・す繝･繝懊・繝・/div>
            <div class="stats-grid">
                <div class="stat-card ${currentFilter === 'pending' ? 'active' : ''}" onclick="window.app.setDashboardFilter('pending')">
                    <div class="stat-label ${currentFilter === 'pending' ? 'text-warning' : ''}"><i class="fa-regular fa-square-check"></i> 譛ｪ蜃ｦ逅・/div>
                    <div class="stat-value">${stats.pending}莉ｶ</div>
                </div>
                <div class="stat-card ${currentFilter === 'risk' ? 'active' : ''}" onclick="window.app.setDashboardFilter('risk')">
                    <div class="stat-label ${currentFilter === 'risk' ? 'text-danger' : ''}"><i class="fa-solid fa-triangle-exclamation"></i> 繝ｪ繧ｹ繧ｯ隕∝愛螳・/div>
                    <div class="stat-value">${stats.highRisk}莉ｶ</div>
                </div>
                <div class="stat-card ${currentFilter === 'total' ? 'active' : ''}" onclick="window.app.setDashboardFilter('total')">
                    <div class="stat-label"><i class="fa-solid fa-satellite-dish"></i> 逶｣隕紋ｸｭ</div>
                    <div class="stat-value text-muted">${stats.total}</div>
                </div>
            </div>

            <h3 id="dashboard-section-title" style="font-size:16px; margin-bottom:16px; font-weight:600;">${sectionTitle}</h3>
            <div class="table-container">
                <table class="data-table dashboard-table">
                    <thead>
                        <tr>
                            <th>繝ｪ繧ｹ繧ｯ</th>
                            <th>螂醍ｴ・・隕冗ｴ・錐</th>
                            <th>譌･莉・/th>
                            <th>繧ｹ繝・・繧ｿ繧ｹ</th>
                            <th>繧｢繧ｯ繧ｷ繝ｧ繝ｳ</th>
                        </tr>
                    </thead>
                    <tbody id="dashboard-table-body">
                        ${tableRows}
                    </tbody>
                </table>
            </div>
        `;
    },

    // 2. Contract List
    contracts: (params) => {
        const page = params?.page || 1;
        const pageSize = 10;
        const appFilters = window.app ? window.app.filters : {};

        const { items, totalPages, totalItems } = dbService.getPaginatedContracts(page, pageSize, params);

        const rows = items.map(c => {
            let riskBadge = '';
            if (c.risk_level === 'High') riskBadge = '<span class="badge badge-danger">High</span>';
            else if (c.risk_level === 'Medium') riskBadge = '<span class="badge badge-warning">Medium</span>';
            else if (c.risk_level === 'Low') riskBadge = '<span class="badge badge-success">Low</span>';
            else riskBadge = '<span class="badge badge-neutral">-</span>';

            const statusBadge = c.status === '遒ｺ隱肴ｸ・
                ? '<span class="badge badge-neutral"><i class="fa-solid fa-check"></i> 遒ｺ隱肴ｸ・/span>'
                : '<span class="badge badge-warning">譛ｪ遒ｺ隱・/span>';

            return `
                <tr onclick="window.app.navigate('diff', ${c.id})">
                    <td class="col-name" title="${c.name}">${c.name}</td>
                    <td>${c.type}</td>
                    <td>${formatDisplayTimestamp(c.last_updated_at || c.last_analyzed_at || c.created_at)}</td>
                    <td>${riskBadge}</td>
                    <td>${statusBadge}</td>
                    <td>${c.assignee_name}</td>
                </tr>
            `;
        }).join('');

        return `
            <div class="flex justify-between items-center mb-md">
                <h2 class="page-title" style="margin-bottom:0;">螂醍ｴ・・隕冗ｴ・ｮ｡逅・/h2>
                <div class="flex gap-sm">
                </div>
            </div>

            <div class="filter-bar mb-md">
                <div class="flex flex-wrap gap-md items-center">
                    <div style="position:relative; flex:1; min-width:250px;">
                        <i class="fa-solid fa-magnifying-glass" style="position:absolute; left:12px; top:50%; transform:translateY(-50%); color:#999;"></i>
                        <input type="text" id="contract-search" placeholder="螂醍ｴ・錐繝ｻ遞ｮ蛻･繝ｻ諡・ｽ楢・〒讀懃ｴ｢..." 
                               value="${appFilters.query || ''}"
                               style="padding:8px 12px 8px 36px; border:1px solid #ddd; border-radius:4px; width:100%; font-size:13px;"
                               oninput="window.app.updateFilter('query', this.value)">
                    </div>
                    
                    <div class="flex gap-sm items-center">
                        <span class="text-muted" style="font-size:12px;">繝ｪ繧ｹ繧ｯ:</span>
                        <select onchange="window.app.updateFilter('risk', this.value)" style="padding:6px 8px; border:1px solid #ddd; border-radius:4px; font-size:13px;">
                            <option value="all" ${appFilters.risk === 'all' ? 'selected' : ''}>縺吶∋縺ｦ</option>
                            <option value="High" ${appFilters.risk === 'High' ? 'selected' : ''}>High</option>
                            <option value="Medium" ${appFilters.risk === 'Medium' ? 'selected' : ''}>Medium</option>
                            <option value="Low" ${appFilters.risk === 'Low' ? 'selected' : ''}>Low</option>
                        </select>
                    </div>

                    <div class="flex gap-sm items-center">
                        <span class="text-muted" style="font-size:12px;">迥ｶ諷・</span>
                        <select onchange="window.app.updateFilter('status', this.value)" style="padding:6px 8px; border:1px solid #ddd; border-radius:4px; font-size:13px;">
                            <option value="all" ${appFilters.status === 'all' ? 'selected' : ''}>縺吶∋縺ｦ</option>
                            <option value="譛ｪ遒ｺ隱・ ${appFilters.status === '譛ｪ遒ｺ隱・ ? 'selected' : ''}>譛ｪ遒ｺ隱・/option>
                            <option value="遒ｺ隱肴ｸ・ ${appFilters.status === '遒ｺ隱肴ｸ・ ? 'selected' : ''}>遒ｺ隱肴ｸ・/option>
                        </select>
                    </div>

                    <div class="flex gap-sm items-center">
                        <span class="text-muted" style="font-size:12px;">遞ｮ蛻･:</span>
                        <select onchange="window.app.updateFilter('type', this.value)" style="padding:6px 8px; border:1px solid #ddd; border-radius:4px; font-size:13px;">
                            <option value="all" ${appFilters.type === 'all' ? 'selected' : ''}>縺吶∋縺ｦ</option>
                            ${(() => { const fixed = ['蛻ｩ逕ｨ隕冗ｴ・,'NDA','讌ｭ蜍吝ｧ碑ｨ怜･醍ｴ・,'繝励Λ繧､繝舌す繝ｼ繝昴Μ繧ｷ繝ｼ']; const dynamic = dbService.getContracts().map(c => c.type).filter(Boolean); const types = [...new Set([...fixed, ...dynamic.filter(t => t !== '縺昴・莉・)])]; types.push('縺昴・莉・); return types.map(t => `<option value="${t}" ${appFilters.type === t ? 'selected' : ''}>${t}</option>`).join(''); })()}
                        </select>
                    </div>
                </div>
            </div>

            <div class="table-container">
                <table class="data-table contracts-table">
                    <thead>
                        <tr>
                            <th>螂醍ｴ・・隕冗ｴ・錐</th>
                            <th>遞ｮ蛻･</th>
                            <th>譛邨よ峩譁ｰ</th>
                            <th>繝ｪ繧ｹ繧ｯ</th>
                            <th>迥ｶ諷・/th>
                            <th>諡・ｽ楢・/th>
                        </tr>
                    </thead>
                    <tbody>${rows || '<tr><td colspan="6" class="text-center text-muted" style="padding:40px;">隧ｲ蠖薙☆繧句･醍ｴ・′隕九▽縺九ｊ縺ｾ縺帙ｓ縺ｧ縺励◆</td></tr>'}</tbody>
                </table>
            </div>

            <div class="flex justify-between items-center mt-md">
                <div class="text-muted" style="font-size:13px;">蜈ｨ ${totalItems} 莉ｶ荳ｭ ${(page - 1) * pageSize + 1}縲・{Math.min(page * pageSize, totalItems)} 莉ｶ繧定｡ｨ遉ｺ</div>
                <div class="flex gap-sm">
                    <button class="btn-dashboard" ${page <= 1 ? 'disabled' : ''} onclick="window.app.changePage(${page - 1})">蜑阪∈</button>
                    <div style="display:flex; align-items:center; padding:0 12px; font-size:13px; font-weight:600;">${page} / ${totalPages || 1}</div>
                    <button class="btn-dashboard" ${page >= totalPages ? 'disabled' : ''} onclick="window.app.changePage(${page + 1})">谺｡縺ｸ</button>
                </div>
            </div>
`;
    },

    // 3. Diff Details
    diff: (id) => {
        const contract = dbService.getContractById(id);
        const comparisonContext = window.app?.getHistoryComparisonContext(id) || null;
        const documentOptions = dbService.getDocumentsByContractId(id);
        const storedCompareState = window.app?.getDocumentCompareState(id) || null;
        const fallbackSourceDoc = documentOptions.length >= 2 ? documentOptions[documentOptions.length - 2] : null;
        const fallbackTargetDoc = documentOptions.length >= 1 ? documentOptions[documentOptions.length - 1] : null;
        const selectedSourceDoc = documentOptions.find((doc) => doc.id === storedCompareState?.docAId) || fallbackSourceDoc;
        const selectedTargetDoc = documentOptions.find((doc) => doc.id === storedCompareState?.docBId) || fallbackTargetDoc;
        const displaySourceDoc = selectedSourceDoc;
        const displayTargetDoc = selectedTargetDoc;
        const selectedDiffResult = selectedSourceDoc && selectedTargetDoc
            ? dbService.getDiffResult(selectedSourceDoc.id, selectedTargetDoc.id)
            : null;
        const selectedDiffPayload = hasAnalysisRecord(selectedDiffResult?.diff_data)
            ? selectedDiffResult.diff_data
            : null;
        const structuredFallbackAnalysis = selectedSourceDoc && selectedTargetDoc
            ? buildStructuredFallbackAnalysis(selectedSourceDoc.content, selectedTargetDoc.content)
            : null;
        const hasStructuredDifferences = Boolean(structuredFallbackAnalysis?.changes?.length);
        const latestCurrentPair = isCurrentVsLatestHistoryPair(documentOptions, selectedSourceDoc, selectedTargetDoc);
        const storedContractAnalysis = latestCurrentPair ? buildStoredContractAnalysis(contract) : null;
        const hasExplicitNoDiffResult = hasStructuredDifferences
            && Boolean(selectedDiffPayload)
            && isExplicitNoDiffAnalysis(selectedDiffPayload);
        const hasFallbackNoDiffResult = hasExplicitNoDiffResult
            && selectedDiffPayload?.isFallback === true;
        const shouldPreferStructuredFallback = Boolean(
            hasStructuredDifferences
            && selectedDiffPayload
            && (
                selectedDiffPayload.isFallback === true
                || selectedDiffPayload.aiFailed === true
                || !isMeaningfulAnalysisPayload(selectedDiffPayload)
                || (Array.isArray(selectedDiffPayload.changes) ? selectedDiffPayload.changes.filter(Boolean).length === 0 : true)
            )
        );
        const canUseStoredContractAnalysis = Boolean(
            latestCurrentPair
            && hasAnalysisRecord(storedContractAnalysis)
            && storedContractAnalysis?.isFallback !== true
        );
        const shouldPreferStoredContractAnalysis = Boolean(
            canUseStoredContractAnalysis
            && (
                !selectedDiffPayload
                || shouldPreferStructuredFallback
                || hasExplicitNoDiffResult
                || selectedDiffPayload?.isFallback === true
                || !isMeaningfulAnalysisPayload(selectedDiffPayload)
            )
        );
        const effectiveSelectedDiffData = shouldPreferStoredContractAnalysis
            ? storedContractAnalysis
            : ((!hasExplicitNoDiffResult && !shouldPreferStructuredFallback && selectedDiffPayload)
                ? selectedDiffPayload
                : null);
        const shouldShowStructuredFallbackPanel = Boolean(
            !comparisonContext
            && hasStructuredDifferences
            && (!effectiveSelectedDiffData || hasExplicitNoDiffResult || shouldPreferStructuredFallback)
        );
        const shouldForceAutoPairAnalysis = Boolean(
            selectedDiffPayload
            && (
                selectedDiffPayload.isFallback === true
                || selectedDiffPayload.aiFailed === true
                || !isMeaningfulAnalysisPayload(selectedDiffPayload)
                || hasExplicitNoDiffResult
            )
        );
        const shouldAutoPairAnalysis = Boolean(
            !comparisonContext
            && selectedSourceDoc
            && selectedTargetDoc
            && window.app?.can('operate_contract')
            && (
                !selectedDiffPayload
                || shouldForceAutoPairAnalysis
                || selectedDiffPayload?.riskReason === 'AI蟾ｮ蛻・悴菫晏ｭ・
            )
        );
        if (shouldAutoPairAnalysis) {
            window.app.scheduleAutoPairAnalysis(
                id,
                selectedSourceDoc.id,
                selectedTargetDoc.id,
                { force: shouldForceAutoPairAnalysis }
            );
        }
        const isAutoPairAnalysisPending = Boolean(
            selectedSourceDoc
            && selectedTargetDoc
            && window.app?.isPairAnalysisPending(id, selectedSourceDoc.id, selectedTargetDoc.id)
        );
        const shouldUseStructuredDisplayChanges = Boolean(
            !comparisonContext
            && selectedSourceDoc
            && selectedTargetDoc
            && hasStructuredDifferences
        );
        const activeTab = window.app ? window.app.activeDetailTab : 'diff';
        const runtimePdfUrl = window.app?.getRuntimePdfPreviewUrl(id) || null;
        const resolvedPdfPreviewUrl = resolvePdfPreviewUrl(contract, runtimePdfUrl);
        const sourceType = String(contract?.source_type || '').toUpperCase();
        const isPdfSource = sourceType === 'PDF' || (contract?.original_filename || '').toLowerCase().endsWith('.pdf');
        const hasPdfPreview = Boolean(resolvedPdfPreviewUrl);
        // Align with production expectation: keep "蜴滓悽蜈ｨ譁・ as structured text view even for PDF.
        const showPdfViewerInRightPane = false;

        // AI隗｣譫千ｵ先棡縺後≠繧後・縺昴ｌ繧剃ｽｿ逕ｨ縲√↑縺代ｌ縺ｰ髱咏噪繧ｳ繝ｳ繝・Φ繝・∪縺溘・繝・ヵ繧ｩ繝ｫ繝・
        const hasComparableVersion = documentOptions.length >= 2;
        const hasAIResults = Boolean(contract.ai_summary || contract.summary || (Array.isArray(contract.ai_changes) && contract.ai_changes.length > 0));
        const canTriggerPairAnalysis = Boolean(selectedSourceDoc && selectedTargetDoc && window.app?.can('operate_contract'));

        let diffData;
        if (effectiveSelectedDiffData) {
            const cached = effectiveSelectedDiffData?.isFallback === true
                ? {
                    summary: String(effectiveSelectedDiffData.summary || 'AI蟾ｮ蛻・ｦ∫ｴ・ｒ蜿門ｾ励〒縺阪∪縺帙ｓ縺ｧ縺励◆縲ょ・隗｣譫舌ｒ螳溯｡後＠縺ｦ縺上□縺輔＞縲・).trim() || 'AI蟾ｮ蛻・ｦ∫ｴ・ｒ蜿門ｾ励〒縺阪∪縺帙ｓ縺ｧ縺励◆縲ょ・隗｣譫舌ｒ螳溯｡後＠縺ｦ縺上□縺輔＞縲・,
                    riskLevel: effectiveSelectedDiffData.riskLevel ?? 1,
                    riskReason: String(effectiveSelectedDiffData.riskReason || 'AI蟾ｮ蛻・ｦ∫ｴ・悴蜿門ｾ・).trim() || 'AI蟾ｮ蛻・ｦ∫ｴ・悴蜿門ｾ・,
                    changes: Array.isArray(effectiveSelectedDiffData.changes) ? effectiveSelectedDiffData.changes.filter(Boolean) : [],
                    isFallback: true
                }
                : sanitizeAnalysisPayload(effectiveSelectedDiffData);
            diffData = {
                title: `${contract.name} - 譁・嶌豈碑ｼチ,
                summary: cached.summary || '驕ｸ謚槭＠縺・譁・嶌縺ｮ蟾ｮ蛻・ｵ先棡繧定｡ｨ遉ｺ縺励※縺・∪縺吶・,
                riskLevel: cached.riskLevel ?? 1,
                riskReason: cached.riskReason || '菫晏ｭ俶ｸ医∩縺ｮ蟾ｮ蛻・ｵ先棡繧定｡ｨ遉ｺ縺励※縺・∪縺吶・,
                changes: cached.changes || [],
                isFallback: cached.isFallback === true
            };
        } else if (shouldShowStructuredFallbackPanel && structuredFallbackAnalysis) {
            diffData = {
                title: `${contract.name} - 譁・嶌豈碑ｼチ,
                summary: structuredFallbackAnalysis.summary || '螟画峩轤ｹ繧定｡ｨ遉ｺ縺励※縺・∪縺吶・,
                riskLevel: structuredFallbackAnalysis.riskLevel ?? 1,
                riskReason: structuredFallbackAnalysis.riskReason || '螟画峩轤ｹ繧定｡ｨ遉ｺ縺励※縺・∪縺・,
                changes: Array.isArray(structuredFallbackAnalysis.changes) ? structuredFallbackAnalysis.changes : [],
                isFallback: false
            };
        } else if (hasFallbackNoDiffResult) {
            diffData = {
                title: `${contract.name} - 譁・嶌豈碑ｼチ,
                summary: 'AI蟾ｮ蛻・ｦ∫ｴ・ｒ蜿門ｾ励〒縺阪∪縺帙ｓ縺ｧ縺励◆縲ょ・隗｣譫舌ｒ螳溯｡後＠縺ｦ縺上□縺輔＞縲・,
                riskLevel: 1,
                riskReason: 'AI蟾ｮ蛻・ｦ∫ｴ・悴蜿門ｾ・,
                changes: [],
                isFallback: true
            };
        } else if (selectedSourceDoc && selectedTargetDoc) {
            diffData = {
                title: `${contract.name} - 譁・嶌豈碑ｼチ,
                summary: '縺薙・譁・嶌繝壹い縺ｮAI蟾ｮ蛻・ｦ∫ｴ・・縺ｾ縺�菫晏ｭ倥＆繧後※縺・∪縺帙ｓ縲ょｿ・ｦ√↓蠢懊§縺ｦAI蟾ｮ蛻・ｧ｣譫舌ｒ螳溯｡後＠縺ｦ縺上□縺輔＞縲・,
                riskLevel: 1,
                riskReason: 'AI蟾ｮ蛻・悴菫晏ｭ・,
                changes: [],
                isFallback: false
            };
        } else if (comparisonContext?.analysis) {
            diffData = {
                title: `${contract.name} - 豈碑ｼ・ｧ｣譫秦,
                summary: comparisonContext.analysis.summary || '驕ｸ謚槭＠縺溷ｱ･豁ｴ縺ｨ縺ｮ蟾ｮ蛻・ｯ碑ｼ・ｒ陦ｨ遉ｺ縺励※縺・∪縺吶・,
                riskLevel: comparisonContext.analysis.riskLevel ?? 1,
                riskReason: comparisonContext.analysis.riskReason || '驕ｸ謚槭＠縺溷ｱ･豁ｴ縺ｨ縺ｮ蟾ｮ蛻・ｒ隗｣譫舌＠縺ｾ縺励◆縲・,
                changes: comparisonContext.analysis.changes || [],
                isFallback: comparisonContext.analysis.isFallback === true
            };
        } else if (comparisonContext?.analysisNotice) {
            diffData = {
                title: `${contract.name} - 豈碑ｼ・｡ｨ遉ｺ`,
                summary: comparisonContext.analysisNotice,
                riskLevel: 1,
                riskReason: '豈碑ｼ・｡ｨ遉ｺ縺ｮ縺ｿ',
                changes: [],
                isFallback: false
            };
        } else if (hasAIResults) {
            const normalizedStored = sanitizeAnalysisPayload({
                summary: contract.ai_summary || contract.summary || '',
                riskLevel: contract.risk_level === 'High' ? 3 : (contract.risk_level === 'Medium' ? 2 : 1),
                riskReason: contract.ai_risk_reason || contract.risk_reason || '',
                changes: contract.ai_changes || [],
                isFallback: contract.ai_is_fallback === true
            });
            // AI隗｣譫千ｵ先棡繧剃ｽｿ逕ｨ
            diffData = {
                title: `${contract.name} - AI隗｣譫千ｵ先棡`,
                summary: normalizedStored.summary || 'AI隗｣譫舌′螳御ｺ・＠縺ｾ縺励◆',
                riskLevel: normalizedStored.riskLevel ?? 1,
                riskReason: normalizedStored.riskReason || '繝ｪ繧ｹ繧ｯ蛻､螳壹′螳御ｺ・＠縺ｾ縺励◆',
                changes: normalizedStored.changes || [],
                isFallback: normalizedStored.isFallback === true
            };
        } else {
            // 繝・ヵ繧ｩ繝ｫ繝医ョ繝ｼ繧ｿ
            diffData = {
                title: `${contract.name} - 隧ｳ邏ｰ蛻・梵`,
                summary: contract.status === '譛ｪ隗｣譫・
                    ? '縺薙・繝峨く繝･繝｡繝ｳ繝医・縺ｾ縺�AI隗｣譫舌＆繧後※縺・∪縺帙ｓ縲よ眠隕冗匳骭ｲ縺九ｉ隗｣譫舌ｒ螳溯｡後＠縺ｦ縺上□縺輔＞縲・
                    : (!hasComparableVersion
                        ? '豈碑ｼ・ｯｾ雎｡縺ｮ譌ｧ繝舌・繧ｸ繝ｧ繝ｳ縺後↑縺・◆繧√∝ｷｮ蛻・ｦ∫ｴ・・陦ｨ遉ｺ縺輔ｌ縺ｾ縺帙ｓ縲・
                        : '縺薙・繝峨く繝･繝｡繝ｳ繝医・譛譁ｰ縺ｮ螟画峩隕∫ｴ・ｒAI縺檎函謌舌＠縺ｦ縺・∪縺・..'),
                riskLevel: contract.risk_level === 'High' ? 3 : (contract.risk_level === 'Medium' ? 2 : 1),
                riskReason: contract.status === '譛ｪ隗｣譫・
                    ? 'AI隗｣譫舌′譛ｪ螳溯｡後〒縺・
                    : (!hasComparableVersion
                        ? '譌ｧ繝舌・繧ｸ繝ｧ繝ｳ縺梧悴逋ｻ骭ｲ縺ｮ縺溘ａ蟾ｮ蛻・愛螳壹・譛ｪ螳溯｡後〒縺・
                        : '迚ｹ螳壹・螟画峩邂・園縺ｫ縺翫＞縺ｦ縲√Μ繧ｹ繧ｯ隕∝屏縺梧､懃衍縺輔ｌ縺ｾ縺励◆縲りｩｳ邏ｰ繧堤｢ｺ隱阪＠縺ｦ縺上□縺輔＞縲・),
                changes: [],
                isFallback: false
            };
        }

        // 繝・ヰ繝・げ諠・�ｱ・磯幕逋ｺ譎ゅ・縺ｿ陦ｨ遉ｺ・・
        const debugInfoHtml = '';

        const compareBannerHtml = activeTab === 'diff' ? `
            <div class="document-compare-toolbar">
                <div class="document-compare-grid">
                    <label class="document-compare-field">
                        <span class="document-compare-label">豈碑ｼ・・</span>
                        <select class="document-compare-select" onchange="window.app.handleDocumentCompareChange(${id}, 'docA', this.value)">
                            <option value="">譁・嶌繧帝∈謚・/option>
                            ${documentOptions.map((doc) => `
                                <option value="${doc.id}" ${selectedSourceDoc?.id === doc.id ? 'selected' : ''}>${escapeHtmlText(buildDocumentOptionLabel(doc))}</option>
                            `).join('')}
                        </select>
                    </label>
                    <label class="document-compare-field">
                        <span class="document-compare-label">豈碑ｼ・・</span>
                        <select class="document-compare-select" onchange="window.app.handleDocumentCompareChange(${id}, 'docB', this.value)">
                            <option value="">譁・嶌繧帝∈謚・/option>
                            ${documentOptions.map((doc) => `
                                <option value="${doc.id}" ${selectedTargetDoc?.id === doc.id ? 'selected' : ''}>${escapeHtmlText(buildDocumentOptionLabel(doc))}</option>
                            `).join('')}
                        </select>
                    </label>
                </div>
                <div class="document-compare-status">
                    ${selectedSourceDoc && selectedTargetDoc
                ? `豈碑ｼ・ｸｭ: <strong>${escapeHtmlText(trimDocumentLabel(selectedSourceDoc.document_name, '豈碑ｼ・・雉・侭'))}</strong> 竊・<strong>${escapeHtmlText(trimDocumentLabel(selectedTargetDoc.document_name, '豈碑ｼ・・雉・侭'))}</strong>`
                : '豈碑ｼ・・縺ｨ豈碑ｼ・・繧帝∈謚槭＠縺ｦ縺上□縺輔＞'}
                </div>
            </div>
        ` : '';

        const displayChanges = normalizeChangesForDisplay(
            shouldUseStructuredDisplayChanges
                ? mergeStructuredChangesWithAnalysis(structuredFallbackAnalysis?.changes, diffData.changes)
                : diffData.changes
        );
        const changesHtml = (displayChanges.length > 0 ? displayChanges : []).map(c => `
            <div style="margin-bottom: 24px; border:1px solid #eee; border-radius:4px; overflow:hidden;">
                <div style="background:#f0f0f0; padding:8px 12px; font-weight:600; font-size:12px; border-bottom:1px solid #eee;">
                    ${c.section} <span style="font-weight:normal; color:#666; margin-left:8px;">(${(() => {
                const t = String(c.type || '').toUpperCase();
                if (t === 'ADD') return '霑ｽ蜉�';
                if (t === 'DELETE') return '蜑企勁';
                return '螟画峩';
            })()})</span>
                </div>
                <div class="diff-container" style="height:auto; min-height:100px;">
                    <div class="diff-pane diff-left"><span class="diff-del">${typeof c.old === 'string' ? c.old : JSON.stringify(c.old)}</span></div>
                    <div class="diff-pane diff-right"><span class="diff-add">${typeof c.new === 'string' ? c.new : JSON.stringify(c.new)}</span></div>
                </div>
                ${(c.impact || c.concern) ? `
                <div style="background:#fff8e1; padding:10px 12px; border-top:1px solid #ffeeba; font-size:12px; color:#5c3a00;">
                    ${c.impact ? `<div style="margin-bottom:4px;"><strong><i class="fa-solid fa-scale-balanced"></i> 豕慕噪蠖ｱ髻ｿ:</strong> ${c.impact}</div>` : ''}
                    ${c.concern ? `<div><strong><i class="fa-solid fa-triangle-exclamation"></i> 諛ｸ蠢ｵ轤ｹ:</strong> ${c.concern}</div>` : ''}
                </div>
                ` : ''}
            </div>
    `).join('');

        return `
            <div class="detail-split-container">
                <!-- Breadcrumb & Top Actions -->
                <div class="detail-split-header flex justify-between items-center">
                    <div class="detail-header-main">
                        <a onclick="window.app.navigate('dashboard')" style="color:#666; font-size:12px; cursor:pointer;" title="謌ｻ繧・>
                            <i class="fa-solid fa-arrow-left"></i>
                        </a>
                        <div class="detail-header-title-wrap">
                            <h2 style="font-size:18px; font-weight:700; color:var(--text-main); margin:0;">${diffData.title}</h2>
                            <div class="detail-header-meta" style="font-size:12px; color:#666; margin-top:4px;">
                                ${contract.source_url ? `<span class="detail-header-meta-item"><i class="fa-solid fa-link"></i> Source: <a href="${contract.source_url}" target="_blank" style="color:#2196F3; text-decoration:underline;">${contract.source_url}</a></span>` : ''}
                                ${contract.original_filename ? `<span class="detail-header-meta-item"><i class="fa-solid fa-file-lines"></i> Original File: ${contract.original_filename}</span>` : ''}
                            </div>
                        </div>
                    </div>
                    <div class="flex gap-sm">
                        ${window.app.can('operate_contract') ? `<button class="btn-dashboard" onclick="window.app.shareReport(${contract.id})"><i class="fa-solid fa-share-nodes"></i> 蜈ｱ譛・/button>` : ''}
                        ${(['pro', 'business'].includes(window.app.subscription?.plan)) ? `<button class="btn-dashboard" onclick="window.app.exportPDF(${contract.id})"><i class="fa-solid fa-file-pdf"></i> PDF蜃ｺ蜉・/button>` : ''}
                        ${window.app.can('operate_contract') ? `<button class="btn-dashboard" onclick="window.app.showHistoryModal(${id})"><i class="fa-solid fa-note-sticky"></i> 繝｡繝｢</button>` : ''}
                        ${window.app.can('operate_contract')
                ? (contract.status === '譛ｪ蜃ｦ逅・
                    ? ''
                    : contract.status === '譛ｪ遒ｺ隱・
                        ? `<button class="btn-dashboard btn-primary-action" onclick="window.app.confirmContract(${id})"><i class="fa-solid fa-check"></i> 遒ｺ隱肴ｸ医∩縺ｫ縺吶ｋ</button>`
                        : `<button class="btn-dashboard" disabled><i class="fa-solid fa-check"></i> 遒ｺ隱肴ｸ医∩</button>`)
                : ''}
                    </div>
                </div>

                <div class="detail-split-body">
                    <!-- Left Pane: Analysis & Diffs -->
                    <div class="pane">
                        <div class="pane-header" style="min-height:56px; box-sizing:border-box;">
                            <span><i class="fa-solid fa-magnifying-glass-chart"></i> AI隗｣譫舌・蟾ｮ蛻・愛螳・/span>
                            <button id="btn-reanalyze" class="btn-upload-version" onclick="window.app.confirmReanalyze('${contract.id}')">
                                <i class="fa-solid fa-wand-magic-sparkles"></i>繝ｪ繧ｹ繧ｯ隗｣譫舌ｒ縺吶ｋ
                            </button>
                        </div>
                        <div class="pane-scroll-area">
                            ${hasAIResults ? `
                            <div class="analysis-section-title" style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
                                <span><i class="fa-solid fa-robot text-primary"></i> AI繝ｪ繧ｹ繧ｯ隕∫ｴ・/span>
                                ${canTriggerPairAnalysis && shouldAutoPairAnalysis ? `
                                    <span style="font-size:12px; color:${isAutoPairAnalysisPending ? '#0f766e' : '#64748b'};">
                                        <i class="fa-solid ${isAutoPairAnalysisPending ? 'fa-spinner fa-spin' : 'fa-circle-check'}"></i>
                                        ${isAutoPairAnalysisPending ? '閾ｪ蜍戊ｧ｣譫舌ｒ螳溯｡御ｸｭ...' : '閾ｪ蜍戊ｧ｣譫舌く繝･繝ｼ貂医∩'}
                                    </span>
                                ` : ''}
                            </div>
                            <div style="margin-bottom:24px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:16px;">
                                <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
                                    <span class="badge ${diffData.riskLevel >= 3 ? 'badge-danger' : diffData.riskLevel >= 2 ? 'badge-warning' : 'badge-success'}">
                                        ${diffData.riskLevel >= 3 ? 'High' : diffData.riskLevel >= 2 ? 'Medium' : 'Low'}
                                    </span>
                                    <span style="font-size:12px; color:#666;">${diffData.riskReason || ''}</span>
                                </div>
                                <div style="font-size:13px; color:#333; line-height:1.7; white-space:pre-wrap;">${diffData.summary || 'AI隗｣譫千ｵ先棡縺後≠繧翫∪縺帙ｓ'}</div>
                            </div>
                            ` : ''}

                            ${hasComparableVersion ? `

                            ${(contract.expiry_date || contract.renewal_deadline || contract.contract_category) ? (() => {
                                const fmtDate = (d) => {
                                    if (!d) return null;
                                    const dt = new Date(d);
                                    if (isNaN(dt.getTime())) return d;
                                    return dt.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
                                };
                                const daysUntil = (d) => {
                                    if (!d) return null;
                                    const dt = new Date(d); if (isNaN(dt.getTime())) return null;
                                    const today = new Date(); today.setHours(0,0,0,0); dt.setHours(0,0,0,0);
                                    return Math.round((dt - today) / 86400000);
                                };
                                const expiryDays = daysUntil(contract.expiry_date);
                                const renewalDays = daysUntil(contract.renewal_deadline);
                                const urgentDays = renewalDays !== null ? renewalDays : expiryDays;
                                const alertColor = urgentDays !== null && urgentDays <= 7 ? '#e53935' : urgentDays !== null && urgentDays <= 30 ? '#f57c00' : '#2e7d32';
                                const confBadge = contract.date_confidence === 'high'
                                    ? '<span style="font-size:10px;background:#e8f5e9;color:#2e7d32;border-radius:4px;padding:2px 6px;margin-left:6px;">AI閾ｪ蜍墓歓蜃ｺ</span>'
                                    : contract.date_confidence === 'partial'
                                    ? '<span style="font-size:10px;background:#fff8e1;color:#f57c00;border-radius:4px;padding:2px 6px;margin-left:6px;">荳驛ｨ謇句虚遒ｺ隱肴耳螂ｨ</span>'
                                    : '';
                                const dayLabel = (days) => days === null ? '' : days === 0 ? '譛ｬ譌･' : days < 0 ? '譛滄剞蛻・ｌ' : `縺ゅ→${days}譌･`;
                                return `<div style="background:#f0f7ff;border:1px solid #bbdefb;border-radius:12px;padding:16px 20px;margin-bottom:20px;">
                                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
                                        <i class="fa-solid fa-calendar-check" style="color:#1976d2;"></i>
                                        <span style="font-size:14px;font-weight:700;color:#1976d2;">AI縺梧､懷・縺励◆譛滄剞諠・�ｱ</span>
                                        ${confBadge}
                                        ${contract.contract_category ? `<span style="font-size:11px;background:#e3f2fd;color:#1976d2;border-radius:4px;padding:2px 7px;margin-left:auto;">${contract.contract_category}</span>` : ''}
                                    </div>
                                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px;">
                                        ${contract.contract_start ? `<div style="background:#fff;border-radius:8px;padding:10px 14px;border:1px solid #e3f2fd;"><div style="font-size:11px;color:#8a7a6a;margin-bottom:2px;">螂醍ｴ・幕蟋区律</div><div style="font-size:13px;font-weight:600;">${fmtDate(contract.contract_start)}</div></div>` : ''}
                                        ${contract.expiry_date ? `<div style="background:#fff;border-radius:8px;padding:10px 14px;border:1px solid #e3f2fd;"><div style="font-size:11px;color:#8a7a6a;margin-bottom:2px;">螂醍ｴ・ｵゆｺ・律</div><div style="font-size:13px;font-weight:600;">${fmtDate(contract.expiry_date)}</div>${expiryDays !== null ? `<div style="font-size:11px;color:${expiryDays <= 30 ? alertColor : '#666'};margin-top:2px;">${dayLabel(expiryDays)}</div>` : ''}</div>` : ''}
                                        ${contract.renewal_deadline ? `<div style="background:#fff;border-radius:8px;padding:10px 14px;border:1px solid #ffe0b2;"><div style="font-size:11px;color:#8a7a6a;margin-bottom:2px;">譖ｴ譁ｰ諡堤ｵｶ譛滄剞</div><div style="font-size:13px;font-weight:600;">${fmtDate(contract.renewal_deadline)}</div>${renewalDays !== null ? `<div style="font-size:11px;color:${renewalDays <= 30 ? alertColor : '#666'};margin-top:2px;">${dayLabel(renewalDays)}</div>` : ''}</div>` : ''}
                                        ${contract.auto_renewal !== undefined ? `<div style="background:#fff;border-radius:8px;padding:10px 14px;border:1px solid #e3f2fd;"><div style="font-size:11px;color:#8a7a6a;margin-bottom:2px;">閾ｪ蜍墓峩譁ｰ</div><div style="font-size:13px;font-weight:600;color:${contract.auto_renewal ? '#e53935' : '#2e7d32'}">${contract.auto_renewal ? '縺ゅｊ・郁ｦ∵ｳｨ諢擾ｼ・ : '縺ｪ縺・}</div></div>` : ''}
                                    </div>
                                    <div style="margin-top:10px;text-align:right;">
                                        <a onclick="window.app.navigate('deadlines')" style="font-size:12px;color:#1976d2;cursor:pointer;"><i class="fa-solid fa-arrow-right" style="margin-right:4px;"></i>譛滄剞荳隕ｧ繧定ｦ九ｋ</a>
                                    </div>
                                </div>`;
                            })() : ''}

                            <div class="analysis-section-title">
                                <i class="fa-solid fa-circle-exclamation text-warning"></i> 讀懃衍縺輔ｌ縺滄㍾隕√↑螟画峩轤ｹ
                            </div>
                            <div style="margin-bottom:32px;">
                                ${changesHtml || `<div style="padding:20px; text-align:center; color:#999; font-size:13px;">螟画峩轤ｹ縺ｯ讀懃衍縺輔ｌ縺ｾ縺帙ｓ縺ｧ縺励◆</div>`}
                            </div>
                            ` : `
                            <div style="padding:32px 20px; text-align:center; color:#999;">
                                <i class="fa-solid fa-code-compare" style="font-size:32px; margin-bottom:12px; display:block; opacity:0.3;"></i>
                                <div style="font-size:14px;">蟾ｮ蛻・・縺ｾ縺�縺ゅｊ縺ｾ縺帙ｓ</div>
                                <div style="font-size:12px; margin-top:6px;">譁ｰ繝舌・繧ｸ繝ｧ繝ｳ繧偵い繝・・繝ｭ繝ｼ繝峨☆繧九→蟾ｮ蛻・ｧ｣譫舌→繝ｪ繧ｹ繧ｯ隗｣譫舌→譛滄剞蜿門ｾ励′髢句ｧ九＆繧後∪縺・/div>
                                <div style="font-size:12px; margin-top:4px;">縲後Μ繧ｹ繧ｯ隗｣譫舌ｒ縺吶ｋ縲阪ｒ繧ｯ繝ｪ繝・け縺ｧ繝ｪ繧ｹ繧ｯ隗｣譫舌→譛滄剞蜿門ｾ励′髢句ｧ九＆繧後∪縺・/div>
                            </div>
                            `}
                        </div>
                        
                        ${contract.source_type === 'URL' ? `
                        <div style="margin-top: 24px; padding: 20px; border-top: 1px solid #eee;">
                            ${window.app.subscription?.plan === 'pro' ? `
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                                <div style="display:flex; align-items:center; gap:10px;">
                                    <i class="fa-solid fa-satellite-dish" style="color:var(--accent-gold, #c19b4a); font-size:16px;"></i>
                                    <span style="font-weight:600; font-size:14px;">螳壽悄逶｣隕・/span>
                                </div>
                                <label class="toggle-switch">
                                    <input type="checkbox" ${contract.monitoring_enabled ? 'checked' : ''} onchange="window.app.toggleMonitoring(${id}, this.checked)">
                                    <span class="toggle-slider"></span>
                                </label>
                            </div>
                            <p style="font-size:12px; color:#888; margin:0 0 16px; line-height:1.5;">
                                URL縺ｮ螟画峩繧定・蜍輔メ繧ｧ繝・け縺励∝ｷｮ蛻・′縺ゅｋ蝣ｴ蜷医・縺ｿAI隗｣譫舌ｒ螳溯｡後＠縺ｾ縺吶・
                            </p>
                            <div style="background:#f8f9fa; border-radius:8px; padding:14px; font-size:13px; margin-bottom:14px;">
                                <div style="display:flex; justify-content:space-between; margin-bottom:8px; color:#555;">
                                    <span>譛邨ゅメ繧ｧ繝・け</span>
                                    <span style="font-weight:500;">${contract.last_checked_at ? new Date(contract.last_checked_at).toLocaleString('ja-JP') : '窶・}</span>
                                </div>
                                <div style="display:flex; justify-content:space-between; color:#555;">
                                    <span>逶｣隕夜�ｻ蠎ｦ</span>
                                    <span style="font-weight:500;">${contract.stable_count >= 14 ? '3譌･縺ｫ1蝗橸ｼ亥ｮ牙ｮ夲ｼ・ : (contract.stable_count >= 7 ? '2譌･縺ｫ1蝗・ : '豈取律')}</span>
                                </div>
                            </div>
                            <button class="btn-crawl-check" onclick="window.app.manualCrawl(${id})">
                                <i class="fa-solid fa-arrows-rotate"></i> 莉翫☆縺先峩譁ｰ繧堤｢ｺ隱・
                            </button>
                            <p style="font-size:11px; color:#aaa; margin:8px 0 0; text-align:center;">窶ｻ 螟画峩讀懷・譎ゅ↓AI隗｣譫仙屓謨ｰ繧・蝗樊ｶ郁ｲｻ縺励∪縺・/p>
                            ` : `
                            <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
                                <i class="fa-solid fa-satellite-dish" style="color:#ccc; font-size:16px;"></i>
                                <span style="font-weight:600; font-size:14px; color:#999;">螳壽悄逶｣隕悶・Slack・上Γ繝ｼ繝ｫ騾夂衍</span>
                                <span style="background:#f3f0ea; color:#c5a059; border:1px solid #e8d9b8; border-radius:10px; padding:2px 10px; font-size:11px; font-weight:700;">Pro髯仙ｮ・/span>
                            </div>
                            <p style="font-size:12px; color:#aaa; margin:0 0 16px; line-height:1.5;">
                                URL縺ｮ螟画峩繧定・蜍輔メ繧ｧ繝・け縺励∝ｷｮ蛻・ｒSlack繝ｻ繝｡繝ｼ繝ｫ縺ｧ騾夂衍縺励∪縺吶・
                            </p>
                            <button class="btn-dashboard" style="width:100%; background:#c5a059; color:#fff; border:none; border-radius:8px; padding:10px; font-size:13px; font-weight:600; cursor:pointer;" onclick="window.app.showProFeatureModal('螳壽悄URL逶｣隕悶・Slack・上Γ繝ｼ繝ｫ騾夂衍縺ｯPro繝励Λ繝ｳ髯仙ｮ壹・讖溯・縺ｧ縺吶・)">
                                <i class="fa-solid fa-lock" style="margin-right:6px;"></i> Pro繝励Λ繝ｳ縺ｧ菴ｿ縺・
                            </button>
                            `}
                        </div>
                        ` : ''}
                    </div>

                    <!-- Right Pane: Original Document -->
                    <div class="pane">
                        <div class="pane-header" style="display:flex; justify-content:space-between; align-items:center; min-height:56px; box-sizing:border-box;">
                            <div style="display:flex; align-items:center; gap:8px; min-width:0;">
                                <span><i class="fa-solid fa-file-contract"></i> 繝峨く繝･繝｡繝ｳ繝郁｡ｨ遉ｺ</span>
                                ${contract.original_filename ? `<span class="doc-source-name" title="${contract.original_filename}"><i class="fa-solid fa-file-lines"></i> ${contract.original_filename}</span>` : ''}
                            </div>
                            
                            ${window.app.can('operate_contract') ? `
                            <button class="btn-upload-version" onclick="window.app.uploadNewVersion(${id})">
                                <i class="fa-solid fa-cloud-arrow-up"></i> 譁ｰ縺励＞繝舌・繧ｸ繝ｧ繝ｳ繧偵い繝・・繝ｭ繝ｼ繝・
                            </button>` : ''}
                        </div>
                        <div class="tabs-row">
                            <button class="tab-item ${activeTab === 'diff' ? 'active' : ''}" onclick="window.app.setDetailTab('diff')">蟾ｮ蛻・｡ｨ遉ｺ</button>
                            <button class="tab-item ${activeTab === 'original' ? 'active' : ''}" onclick="window.app.setDetailTab('original')">蜴滓悽蜈ｨ譁・/button>
                        </div>
                        <div class="pane-scroll-area ${showPdfViewerInRightPane ? '' : 'document-pane-bg is-frameless'}" style="padding:0; flex:1; display:flex; flex-direction:column; overflow-y:auto;">
                                ${showPdfViewerInRightPane
                ? `<div style="width:100%; height:100%; display:flex; flex-direction:column;">
                        <iframe src="${resolvedPdfPreviewUrl}" style="width:100%; flex:1; border:none; background:#525659; min-height:600px;"></iframe>
                        <div style="padding:10px; text-align:center; background:#f9f9f9; border-top:1px solid #ddd; font-size:12px;">
                            <a href="${resolvedPdfPreviewUrl}" target="_blank" class="text-primary"><i class="fa-solid fa-external-link-alt"></i> PDF繧貞挨繧ｦ繧｣繝ｳ繝峨え縺ｧ髢九￥</a>
                             <span style="margin-left:10px; color:#999;">(Shift+Click縺ｧ繝繧ｦ繝ｳ繝ｭ繝ｼ繝・</span>
                        </div>
                   </div>`
                : `${compareBannerHtml}<div class="document-paper-container is-frameless">
                      <div class="document-content-full">
                         <div class="document-top-anchor" aria-hidden="true"></div>
                                        ${activeTab === 'diff'
                    ? (() => {
                        try {
                            // 蟾ｮ蛻・｡ｨ遉ｺ繝ｭ繧ｸ繝・け
                            const renderAiChangeCards = () => {
                                const aiOnlyHtml = normalizeChangesForDisplay(contract.ai_changes || []).map((c, idx) => {
                                    const escapedOld = escapeHtmlText(c.old || '');
                                    const escapedNew = escapeHtmlText(c.new || '');
                                    const typeLabel = c.type === 'ADD' ? '霑ｽ蜉�' : (c.type === 'DELETE' ? '蜑企勁' : '螟画峩');
                                    return `
                                    <div style="margin-bottom:18px; border:1px solid #e5e7eb; border-radius:8px; overflow:hidden; background:#fff;">
                                        <div style="padding:10px 14px; background:#f8fafc; border-bottom:1px solid #e5e7eb; font-size:12px; font-weight:600;">
                                            ${c.section || `螟画峩 ${idx + 1}`} <span style="font-weight:normal; color:#667085; margin-left:8px;">(${typeLabel})</span>
                                        </div>
                                        <div class="diff-container" style="height:auto; min-height:90px;">
                                            <div class="diff-pane diff-left"><span class="diff-del">${escapedOld || '・亥､画峩蜑阪↑縺暦ｼ・}</span></div>
                                            <div class="diff-pane diff-right"><span class="diff-add">${escapedNew || '・亥､画峩蠕後↑縺暦ｼ・}</span></div>
                                        </div>
                                    </div>
                                `;
                                }).join('');
                                return `<div class="document-content-diff-wrap">${aiOnlyHtml}</div>`;
                            };

                            // Extract text for diff if structured
                            const normalizePdfDisplayText = (text) => {
                                const src = String(text || '');
                                if (!src) return '';
                                const lines = src.split(/\r?\n/);
                                const out = [];
                                const articleHeaderPattern = /^隨ｬ\s*[0-9・・・吩ｸ莠御ｸ牙屁莠泌・荳・・荵晏香逋ｾ蜊・・峺]+\s*譚｡(?:\s+.*)?$/;
                                const listLinePattern = /^([0-9・・・兢+[\.・蚕)]|[繝ｻ笳鞘雷笆�笆｡\-]|隨ｬ\s*[0-9・・・吩ｸ莠御ｸ牙屁莠泌・荳・・荵晏香逋ｾ蜊・・峺]+\s*譚｡)/;
                                const shortTailPattern = /^[\u3040-\u30ff\u3400-\u9fffA-Za-z0-9]{1,6}$/;

                                for (let i = 0; i < lines.length; i += 1) {
                                    const line = String(lines[i] || '').trim();
                                    if (!line) {
                                        if (out.length > 0 && out[out.length - 1] !== '') out.push('');
                                        continue;
                                    }

                                    const prev = out.length > 0 ? out[out.length - 1] : '';
                                    const prevTrim = String(prev || '').trim();
                                    const isList = listLinePattern.test(line);
                                    const isLikelyHeaderTail = shortTailPattern.test(line) && articleHeaderPattern.test(prevTrim);
                                    const isLikelyWrappedContinuation =
                                        !isList &&
                                        prevTrim &&
                                        prevTrim !== '' &&
                                        /[\u3040-\u30ff\u3400-\u9fffA-Za-z0-9・・縲曽$/.test(prevTrim);

                                    if (out.length === 0 || prevTrim === '' || isList) {
                                        out.push(line);
                                    } else if (isLikelyHeaderTail || isLikelyWrappedContinuation) {
                                        out[out.length - 1] = `${prevTrim}${line}`;
                                    } else {
                                        out.push(line);
                                    }
                                }

                                return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
                            };

                            const historyEntries = Array.isArray(contract.history) ? contract.history : [];
                            const currentVersion = displayTargetDoc?.content || selectedTargetDoc?.content || contract.original_content || '';
                            const isWordSource = isWordDocumentFilename(contract.original_filename);
                            const currentVersionText = contentToComparableText(currentVersion);

                            const previousVersion = displaySourceDoc?.content || selectedSourceDoc?.content || comparisonContext?.historyItem?.content || (() => {
                                for (let i = historyEntries.length - 1; i >= 0; i -= 1) {
                                    const candidate = historyEntries[i];
                                    if (contentToComparableText(candidate?.content) !== currentVersionText) {
                                        return candidate?.content || null;
                                    }
                                }
                                return historyEntries.length > 0 ? historyEntries[historyEntries.length - 1].content : null;
                            })();

                            if (!previousVersion) {
                                if (contract.ai_changes && contract.ai_changes.length > 0) {
                                    return renderAiChangeCards();
                                }
                                const initialDisplayText = (isPdfSource && typeof contract.pdf_raw_text === 'string' && contract.pdf_raw_text.trim())
                                    ? contract.pdf_raw_text
                                    : (isPdfSource ? normalizePdfDisplayText(currentVersionText) : currentVersionText);
                                return `
                                <div class="document-content-diff-wrap" style="padding: 8px 0;">
                                    <div style="white-space:pre-wrap; line-height:1.9;">${escapeHtmlText(initialDisplayText)}</div>
                                </div>
                            `;
                            }

                            const previousVersionText = contentToComparableText(previousVersion);
                            if (previousVersionText === currentVersionText) {
                                return `
                                <div class="text-muted text-center" style="padding:24px;">豈碑ｼ・庄閭ｽ縺ｪ蟾ｮ蛻・′縺ゅｊ縺ｾ縺帙ｓ・域立迚医→蜷御ｸ蜀・ｮｹ縺ｧ縺呻ｼ・/div>
                            `;
                            }

                            if (isStructuredDocumentContent(previousVersion) || isStructuredDocumentContent(currentVersion)) {
                                const previousLabel = displaySourceDoc
                                    ? buildComparisonLabel(displaySourceDoc.document_name, displaySourceDoc.uploaded_at, '豈碑ｼ・・雉・侭')
                                    : (comparisonContext?.previousLabel || buildComparisonLabel(contract.original_filename || contract.name, contract.last_updated_at, '豈碑ｼ・・雉・侭'));
                                const currentLabel = displayTargetDoc
                                    ? buildComparisonLabel(displayTargetDoc.document_name, displayTargetDoc.uploaded_at, '豈碑ｼ・・雉・侭')
                                    : (comparisonContext?.currentLabel || buildComparisonLabel(contract.original_filename || contract.name, contract.last_analyzed_at || contract.last_updated_at, '豈碑ｼ・・雉・侭'));
                                return renderStructuredDiffView(previousVersion, currentVersion, {
                                    idPrefix: `diff-${id}`,
                                    previousLabel,
                                    currentLabel
                                });
                            }

                            const renderDualFullDiff = () => {
                                const lhsText = isPdfSource ? normalizePdfDisplayText(previousVersionText) : previousVersionText;
                                const rhsText = isPdfSource ? normalizePdfDisplayText(currentVersionText) : currentVersionText;
                                if (!window.Diff || typeof window.Diff.diffWordsWithSpace !== 'function') {
                                    return `
                                    <div class="document-content-diff-wrap">
                                        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:12px;">
                                            <div style="background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:14px;">
                                                <div style="font-size:12px; font-weight:700; color:#b42318; margin-bottom:8px;">螟画峩蜑搾ｼ域立迚亥・譁・ｼ・/div>
                                                <div style="white-space:pre-wrap; line-height:1.9;">${escapeHtmlText(lhsText)}</div>
                                            </div>
                                            <div style="background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:14px;">
                                                <div style="font-size:12px; font-weight:700; color:#027a48; margin-bottom:8px;">螟画峩蠕鯉ｼ域眠迚域悽譁・ｼ・/div>
                                                <div style="white-space:pre-wrap; line-height:1.9;">${escapeHtmlText(rhsText)}</div>
                                            </div>
                                        </div>
                                    </div>
                                `;
                                }

                                const chunks = window.Diff.diffWordsWithSpace(lhsText, rhsText);
                                let oldHtml = '';
                                let newHtml = '';

                                for (const chunk of chunks) {
                                    const safe = escapeHtmlText(chunk.value);
                                    if (chunk.added) {
                                        newHtml += `<span class="diff-inline-add">${safe}</span>`;
                                    } else if (chunk.removed) {
                                        oldHtml += `<span class="diff-inline-del">${safe}</span>`;
                                    } else {
                                        oldHtml += safe;
                                        newHtml += safe;
                                    }
                                }

                                return `
                                <div class="document-content-diff-wrap">
                                    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:12px;">
                                        <div style="background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:14px;">
                                            <div style="font-size:12px; font-weight:700; color:#b42318; margin-bottom:8px;">螟画峩蜑搾ｼ域立迚亥・譁・ｼ・/div>
                                            <div style="white-space:pre-wrap; line-height:1.9;">${oldHtml}</div>
                                        </div>
                                        <div style="background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:14px;">
                                            <div style="font-size:12px; font-weight:700; color:#027a48; margin-bottom:8px;">螟画峩蠕鯉ｼ域眠迚域悽譁・ｼ・/div>
                                            <div style="white-space:pre-wrap; line-height:1.9;">${newHtml}</div>
                                        </div>
                                    </div>
                                </div>
                            `;
                            };

                            if (isPdfSource || isWordSource) {
                                return renderDualFullDiff();
                            }

                            const diff = (window.Diff && typeof window.Diff.diffChars === 'function')
                                ? window.Diff.diffChars(previousVersionText, currentVersionText)
                                : [{ value: currentVersionText }];

                            // HTML逕滓・
                            let diffHtml = diff.map(part => {
                                const colorClass = part.added ? 'diff-inline-add' :
                                    part.removed ? 'diff-inline-del' : '';

                                // 繧ｨ繧ｹ繧ｱ繝ｼ繝怜・逅・ｼ・SS蟇ｾ遲厄ｼ・
                                const escapedValue = escapeHtmlText(part.value);

                                return colorClass ? `<span class="${colorClass}">${escapedValue}</span>` : escapedValue;
                            }).join('');

                            return `<div class="document-content-diff-wrap">${diffHtml}</div>`;
                        } catch (documentRenderError) {
                            console.error('Document comparison render error:', documentRenderError);
                            const fallbackPreviousText = contentToComparableText(
                                displaySourceDoc?.content || selectedSourceDoc?.content || comparisonContext?.historyItem?.content || ''
                            );
                            const fallbackCurrentText = contentToComparableText(
                                displayTargetDoc?.content || selectedTargetDoc?.content || contract.original_content || ''
                            );
                            const fallbackPreviousLabel = displaySourceDoc
                                ? buildComparisonLabel(displaySourceDoc.document_name, displaySourceDoc.uploaded_at, '豈碑ｼ・・雉・侭')
                                : (comparisonContext?.previousLabel || '豈碑ｼ・・雉・侭');
                            const fallbackCurrentLabel = displayTargetDoc
                                ? buildComparisonLabel(displayTargetDoc.document_name, displayTargetDoc.uploaded_at, '豈碑ｼ・・雉・侭')
                                : (comparisonContext?.currentLabel || '豈碑ｼ・・雉・侭');
                            return `
                                <div class="document-content-diff-wrap">
                                    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:12px;">
                                        <div style="background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:14px;">
                                            <div style="font-size:12px; font-weight:700; color:#667085; margin-bottom:8px;">${escapeHtmlText(fallbackPreviousLabel)}</div>
                                            <div style="white-space:pre-wrap; line-height:1.9;">${escapeHtmlText(fallbackPreviousText || '豈碑ｼ・・繝・・繧ｿ縺ｪ縺・)}</div>
                                        </div>
                                        <div style="background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:14px;">
                                            <div style="font-size:12px; font-weight:700; color:#667085; margin-bottom:8px;">${escapeHtmlText(fallbackCurrentLabel)}</div>
                                            <div style="white-space:pre-wrap; line-height:1.9;">${escapeHtmlText(fallbackCurrentText || '豈碑ｼ・・繝・・繧ｿ縺ｪ縺・)}</div>
                                        </div>
                                    </div>
                                </div>
                            `;
                        }
                    })()
                    : (contract.original_content
                        ? `<div class="is-structured">${renderStructuredView(contract.original_content, `orig-${id}`)}</div>`
                        : '<div class="text-center text-muted" style="padding:40px;">蜴滓悽繝・・繧ｿ縺後≠繧翫∪縺帙ｓ</div>')
                }
                    </div>
                </div>`
            }
            </div>
        </div>
`;
    },

    // 4. History
    history: () => {
        const liveLogs = dbService.getActivityLogs();
        const cachedLogs = window.app?.getCachedItem(DASHBOARD_CACHE_KEYS.RECENT_HISTORY, 10 * 60 * 1000) || [];
        const logs = Array.isArray(liveLogs) && liveLogs.length > 0 ? liveLogs : cachedLogs;
        const rows = logs.map(h => {
            let statusBadge = 'badge-neutral';
            if (h.status === '謌仙粥') statusBadge = 'badge-success';
            else if (h.status === '螟ｱ謨・) statusBadge = 'badge-danger';
            else if (h.status === '繧ｹ繧ｭ繝・・') statusBadge = 'badge-info';

            return `
                <tr>
                    <td>${h.created_at}</td>
                    <td class="col-name" title="${h.target_name}">${h.target_name}</td>
                    <td><span class="badge ${statusBadge}">${h.status || '謌仙粥'}</span></td>
                    <td>${h.action}</td>
                    <td>${h.actor}</td>
                    <td><button class="btn-dashboard" style="padding:2px 8px; font-size:11px;" onclick="window.app.showLogDetails(${h.id})">隧ｳ邏ｰ</button></td>
                </tr>
            `;
        }).join('');

        return `
            <h2 class="page-title">隗｣譫舌Ο繧ｰ繝ｻ逶｣譟ｻ螻･豁ｴ</h2>
            <div class="table-container">
            <table class="data-table history-table">
                <thead>
                    <tr>
                        <th>譌･譎・/th>
                        <th>蟇ｾ雎｡</th>
                        <th>繧ｹ繝・・繧ｿ繧ｹ</th>
                        <th>謫堺ｽ・遞ｮ蛻･</th>
                        <th>螳溯｡瑚・/th>
                        <th>隧ｳ邏ｰ</th>
                    </tr>
                </thead>
                <tbody>${rows || '<tr><td colspan="6" class="text-center text-muted">螻･豁ｴ縺ｯ縺ゅｊ縺ｾ縺帙ｓ</td></tr>'}</tbody>
            </table>
        </div>
`;
    },

    // 5. Team
    team: () => {
        const users = dbService.getUsers();
        const limit = dbService.PLAN_LIMITS[window.app.subscription?.plan] || 1;
        const rows = users.map(m => `
    <tr>
                <td class="col-name" title="${m.name}">${m.name}</td>
            <td>${m.email}</td>
            <td><span class="badge ${m.role === '邂｡逅・・ ? 'badge-warning' : (m.role === '菴懈･ｭ閠・ ? 'badge-success' : 'badge-neutral')}">${m.role}</span></td>
            <td>${m.last_active_at}</td>
            <td>${window.app.can('manage_team') ? `<button class="btn-dashboard" onclick="window.app.showEditMemberModal('${m.email}')">邱ｨ髮・/button>` : '-'}</td>
        </tr>
    `).join('');

        return `
    <div class="flex justify-between items-center mb-md">
        <h2 class="page-title" style="margin-bottom:0;">繝√・繝�邂｡逅・<small style="font-size:14px; font-weight:normal; color:#666; margin-left:12px;">(${users.length} / ${limit} 蜷・</small></h2>
                ${window.app.can('manage_team') ? `<button class="btn-dashboard btn-primary-action" onclick="window.app.showInviteModal()"><i class="fa-solid fa-user-plus"></i> 繝｡繝ｳ繝舌・諡帛ｾ・/button>` : ''}
            </div>
    <div class="table-container">
        <table class="data-table team-table">
            <thead>
                <tr>
                    <th>蜷榊燕</th>
                    <th>繝｡繝ｼ繝ｫ繧｢繝峨Ξ繧ｹ</th>
                    <th>讓ｩ髯・/th>
                    <th>譛邨ゅい繧ｯ繝・ぅ繝・/th>
                    <th>謫堺ｽ・/th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    </div>
`;
    }
};

// --- Registration Flow Logic ---
class RegistrationFlow {
    constructor(app) {
        this.app = app;
        this.modal = document.getElementById('registration-modal');
        this.modalBody = document.getElementById('modal-body');
        this.modalTitle = document.getElementById('modal-title');
        this.fileInput = document.getElementById('reg-file-input');
        this.compareFileInput = document.getElementById('reg-compare-file-input');
        this.currentStep = 1;
        this.tempData = {};
        this.compareFile = null;
    }

    init() {
        const openBtn = document.getElementById('open-registration-btn');
        const closeBtn = document.getElementById('close-registration-modal');

        if (openBtn) openBtn.onclick = () => this.open();
        if (closeBtn) closeBtn.onclick = () => this.close();

        if (this.modal) {
            this.modal.onclick = (e) => {
                if (e.target === this.modal) this.close();
            };
        }

        if (this.fileInput) {
            this.fileInput.onchange = (e) => this.handleFileSelect(e.target.files[0]);
        }

        if (this.compareFileInput) {
            this.compareFileInput.onchange = (e) => this.handleCompareFileSelect(e.target.files[0]);
        }
    }

    open() {
        if (!window.app.can('operate_contract')) {
            Notify.warning('髢ｲ隕ｧ縺ｮ縺ｿ縺ｮ讓ｩ髯舌〒縺ｯ譁ｰ隕冗匳骭ｲ縺ｧ縺阪∪縺帙ｓ');
            return;
        }
        this.currentStep = 1;
        this.tempData = {};

        // 蜈医↓繝ｬ繝ｳ繝繝ｪ繝ｳ繧ｰ
        this.renderStep();

        // 谺｡縺ｮ繝輔Ξ繝ｼ繝�縺ｧ陦ｨ遉ｺ・域緒逕ｻ縺ｮ縺｡繧峨▽縺埼亟豁｢・・ｻ代ｉ縺九＆蜷台ｸ奇ｼ・
        requestAnimationFrame(() => {
            if (this.modal) this.modal.classList.add('active');
        });
    }

    close() {
        if (this.modal) this.modal.classList.remove('active');
        if (this.fileInput) this.fileInput.value = '';
        if (this.compareFileInput) this.compareFileInput.value = '';
        this.compareFile = null;
    }

    renderStep() {
        if (!this.modalBody) return;

        if (this.currentStep === 1) {
            this.modalTitle.textContent = "譁ｰ隕冗匳骭ｲ - 逋ｻ骭ｲ譁ｹ豕輔・驕ｸ謚・;
            this.modalBody.innerHTML = `
                <div class="reg-method-grid">
                    <div class="reg-method-card" id="reg-card-docx">
                        <div class="reg-method-icon"><i class="fa-solid fa-file-word"></i></div>
                        <div class="reg-method-info">
                            <h4>Word繧偵い繝・・繝ｭ繝ｼ繝・/h4>
                            <p>Word繝輔ぃ繧､繝ｫ(.docx)繧定ｧ｣譫舌・豈碑ｼ・＠縺ｾ縺・/p>
                        </div>
                    </div>
                    <div class="reg-method-card" id="reg-card-pdf">
                        <div class="reg-method-icon"><i class="fa-solid fa-file-pdf"></i></div>
                        <div class="reg-method-info">
                            <h4>PDF繧偵い繝・・繝ｭ繝ｼ繝・/h4>
                            <p>繝輔ぃ繧､繝ｫ繧偵％縺薙↓繝峨Ο繝・・縺吶ｋ縺九√け繝ｪ繝・け縺励※驕ｸ謚・/p>
                        </div>
                    </div>
                    <div class="reg-method-card" id="reg-card-url">
                        <div class="reg-method-icon"><i class="fa-solid fa-globe"></i></div>
                        <div class="reg-method-info">
                            <h4>URL繧堤匳骭ｲ (Web隕冗ｴ・</h4>
                            <p>蜈ｬ髢偽RL繧堤屮隕門ｯｾ雎｡縺ｫ險ｭ螳壹＠縺ｾ縺・/p>
                        </div>
                    </div>
                </div>
    `;
            this.bindCardEvents();
        } else if (this.currentStep === 2) {
            const isPdf = this.tempData.method === 'pdf';
            const isDocx = this.tempData.method === 'docx';
            const methodLabel = (isPdf || isDocx) ? '繧｢繝・・繝ｭ繝ｼ繝峨＆繧後◆繝輔ぃ繧､繝ｫ' : '逶｣隕門ｯｾ雎｡縺ｮURL';
            const sourceVal = (isPdf || isDocx) ? (this.tempData.fileName || '驕ｸ謚樊ｸ医∩') : "";
            const defaultName = this.tempData.fileName ? this.tempData.fileName.replace(/\.[^/.]+$/, "") : "";

            this.modalBody.innerHTML = `
                <div class="form-group">
                    <label>邂｡逅・錐 (蠢・�・</label>
                    <input type="text" id="reg-name" class="form-control" placeholder="萓・ 蛻ｩ逕ｨ隕冗ｴ・(2026蟷ｴ迚・" value="${defaultName}">
                </div>
                <div class="form-group">
                    <label>遞ｮ蛻･</label>
                    <select id="reg-type" class="form-control">
                        ${(() => { const fixed = ['蛻ｩ逕ｨ隕冗ｴ・,'NDA','讌ｭ蜍吝ｧ碑ｨ怜･醍ｴ・,'繝励Λ繧､繝舌す繝ｼ繝昴Μ繧ｷ繝ｼ']; const dynamic = dbService.getContracts().map(c => c.type).filter(Boolean); const types = [...new Set([...fixed, ...dynamic.filter(t => t !== '縺昴・莉・)])]; types.push('縺昴・莉・); return types.map(t => `<option value="${t}">${t}</option>`).join(''); })()}
                    </select>
                </div>
                <div class="form-group">
                    <label>${methodLabel}</label>
                    <input type="text" id="reg-source" class="form-control" 
                        placeholder="${(isPdf || isDocx) ? '' : 'https://example.com/terms'}" 
                        value="${sourceVal}" 
                        ${(isPdf || isDocx) ? 'readonly style="background:#f5f5f5; cursor:not-allowed;"' : ''}>
                </div>
                
<div class="reg-actions">
    <button class="btn-dashboard" onclick="window.app.registration.nextStep(1)">謌ｻ繧・/button>
    <button class="btn-dashboard btn-primary-action" onclick="window.app.registration.submit()">隗｣譫舌・逋ｻ骭ｲ縺吶ｋ</button>
</div>
`;
        } else if (this.currentStep === 3) {
            this.modalTitle.textContent = "逋ｻ骭ｲ螳御ｺ・;
            this.modalBody.innerHTML = `
    <div class="reg-success-icon"><i class="fa-solid fa-check-circle"></i></div>
                <div class="reg-success-text">
                    <h4>逋ｻ骭ｲ繧貞女縺台ｻ倥￠縺ｾ縺励◆</h4>
                    <p>縲・{this.tempData.name}縲阪ｒ逶｣隕門ｯｾ雎｡縺ｨ縺励※逋ｻ骭ｲ縺励∪縺励◆縲ゅム繝・す繝･繝懊・繝峨°繧臥｢ｺ隱阪〒縺阪∪縺吶・/p>
                </div>
                <div class="reg-actions">
                    <button class="btn-dashboard btn-primary-action" onclick="window.app.registration.close()">繝繝・す繝･繝懊・繝峨∈</button>
                </div>
`;
        }
    }

    bindCardEvents() {
        const cardPdf = document.getElementById('reg-card-pdf');
        const cardDocx = document.getElementById('reg-card-docx');
        const cardUrl = document.getElementById('reg-card-url');

        if (cardPdf) {
            cardPdf.onclick = () => {
                this.fileInput.accept = ".pdf";
                this.fileInput.click();
            };
            cardPdf.ondragover = (e) => { e.preventDefault(); cardPdf.classList.add('drop-active'); };
            cardPdf.ondragleave = () => { cardPdf.classList.remove('drop-active'); };
            cardPdf.ondrop = (e) => {
                e.preventDefault();
                cardPdf.classList.remove('drop-active');
                if (e.dataTransfer.files.length > 0) this.handleFileSelect(e.dataTransfer.files[0]);
            };
        }

        if (cardDocx) {
            cardDocx.onclick = () => {
                this.fileInput.accept = ".docx";
                this.fileInput.click();
            };
            cardDocx.ondragover = (e) => { e.preventDefault(); cardDocx.classList.add('drop-active'); };
            cardDocx.ondragleave = () => { cardDocx.classList.remove('drop-active'); };
            cardDocx.ondrop = (e) => {
                e.preventDefault();
                cardDocx.classList.remove('drop-active');
                if (e.dataTransfer.files.length > 0) this.handleFileSelect(e.dataTransfer.files[0]);
            };
        }

        if (cardUrl) {
            const isPro = window.app.subscription?.plan === 'pro';
            if (!isPro) {
                cardUrl.style.opacity = '0.55';
                cardUrl.style.position = 'relative';
                cardUrl.insertAdjacentHTML('beforeend',
                    '<div style="position:absolute;top:8px;right:8px;background:#c5a059;color:#fff;border-radius:10px;padding:2px 8px;font-size:10px;font-weight:700;letter-spacing:0.03em;">Pro</div>'
                );
            }
            cardUrl.onclick = () => {
                if (!isPro) {
                    window.app.showProFeatureModal('URL繧堤匳骭ｲ縺励※螳壽悄逧・↓螟画峩繧堤屮隕悶＠縲∝ｷｮ蛻・ｒSlack繝ｻ繝｡繝ｼ繝ｫ縺ｧ騾夂衍縺吶ｋ讖溯・縺ｯPro繝励Λ繝ｳ髯仙ｮ壹〒縺吶・);
                    return;
                }
                this.nextStep(2, { method: 'url' });
            };
        }
    }

    handleFileSelect(file) {
        if (!file) return;

        const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
        const isDocx = file.name.toLowerCase().endsWith('.docx');

        if (!isPdf && !isDocx) {
            Notify.warning('PDF縺ｾ縺溘・Word繝輔ぃ繧､繝ｫ(.docx)繧帝∈謚槭＠縺ｦ縺上□縺輔＞');
            return;
        }

        this.nextStep(2, {
            method: isPdf ? 'pdf' : 'docx',
            fileName: file.name,
            fileSize: file.size,
            fileData: file
        });
    }

    handleCompareFileSelect(file) {
        if (!file) return;
        this.compareFile = file;
        const displayEl = document.getElementById('reg-compare-filename');
        if (displayEl) displayEl.textContent = file.name;
    }

    nextStep(step, data = {}) {
        this.tempData = { ...this.tempData, ...data };
        this.currentStep = step;
        this.renderStep();
    }

    async submit() {
        const nameInput = document.getElementById('reg-name');
        const typeInput = document.getElementById('reg-type');
        const sourceInput = document.getElementById('reg-source');

        const comparePrevInput = document.getElementById('reg-compare-prev');

        const name = nameInput ? nameInput.value : "";
        const type = typeInput ? typeInput.value : "";
        const source = sourceInput ? sourceInput.value : "";
        const comparePrevId = comparePrevInput ? comparePrevInput.value : "";

        if (!name) {
            Notify.warning('邂｡逅・錐繧貞・蜉帙＠縺ｦ縺上□縺輔＞');
            return;
        }

        this.tempData.name = name;
        this.tempData.type = type;
        this.tempData.source = source;
        this.tempData.comparePrevId = null; // 譌ｧUI縺ｮID謖・ｮ壹・辟｡蜉ｹ蛹・

        // 繝ｭ繝ｼ繝・ぅ繝ｳ繧ｰ陦ｨ遉ｺ・域歓蜃ｺ荳ｭ・・
        const isPdf = this.tempData.method === 'pdf';
        const isDocx = this.tempData.method === 'docx';
        const loadingText = isPdf ? 'PDF繧貞叙繧願ｾｼ縺ｿ荳ｭ...' : (isDocx ? 'Word繝輔ぃ繧､繝ｫ繧貞叙繧願ｾｼ縺ｿ荳ｭ...' : 'URL縺九ｉ隕冗ｴ・ｒ隗｣譫蝉ｸｭ...');
        const loadingSubText = (isPdf || isDocx) ? '隗｣譫先ｺ門ｙ繧偵＠縺ｦ縺・∪縺・ : 'Web繧ｵ繧､繝医°繧芽ｩｳ邏ｰ繧貞叙蠕励＠縺ｦ縺・∪縺・;

        const loadingMsg = document.createElement('div');
        loadingMsg.id = 'reg-loading';
        loadingMsg.style.cssText = 'position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); background:white; padding:30px; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.3); z-index:10005; text-align:center; min-width:300px;';
        loadingMsg.innerHTML = `<div class="custom-loader"></div><br><strong>${loadingText}</strong><br><span style="font-size:12px; color:#666;">${loadingSubText}</span>`;
        document.body.appendChild(loadingMsg);

        // 閭梧勹繧呈囓縺上☆繧九が繝ｼ繝舌・繝ｬ繧､
        const overlay = document.createElement('div');
        overlay.id = 'reg-overlay';
        overlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:10004;';
        document.body.appendChild(overlay);

        // UI謠冗判繧堤｢ｺ螳溘↓縺吶ｋ縺溘ａ縺ｮ遏ｭ縺・≦蟒ｶ
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 50)));

        try {
            // DB縺ｫ逋ｻ骭ｲ
            const isWord = this.tempData.method === 'docx';
            const newContract = dbService.addContract({
                name: this.tempData.name || ((this.tempData.method === 'pdf' || isWord) ? this.tempData.fileData.name : 'Web隕冗ｴ・),
                type: this.tempData.type, // 繝・ヵ繧ｩ繝ｫ繝・
                sourceUrl: this.tempData.method === 'url' ? this.tempData.source : '',
                originalFilename: (this.tempData.method === 'pdf' || isWord) ? this.tempData.fileData.name : ''
            });
            const savedContract = await dbService.persistContractToApi(newContract, 'POST', { throwOnError: true });
            if (!savedContract) {
                throw new Error('螂醍ｴ・ョ繝ｼ繧ｿ縺ｮ菫晏ｭ倥↓螟ｱ謨励＠縺ｾ縺励◆');
            }
            await dbService.syncContractsFromApi();
            // 2. 繝・く繧ｹ繝域歓蜃ｺ繧貞ｮ溯｡鯉ｼ亥､ｱ謨励＠縺ｦ繧ら匳骭ｲ縺ｯ邯ｭ謖√☆繧具ｼ・
            let extractionSucceeded = false;
            try {
                let previousText = null;
                let previousFileBase64 = null;

                // Word縺ｮ蝣ｴ蜷医・繝輔ぃ繧､繝ｫ蜷悟｣ｫ縺ｮ豈碑ｼ・ｒ陦後≧
                if (isWord && this.compareFile) {
                    previousFileBase64 = await aiService.convertFileToBase64(this.compareFile);
                }

                extractionSucceeded = await this.extractTextOnly(newContract.id, previousText, previousFileBase64) === true;
                await dbService.syncContractsFromApi();
            } catch (extractError) {
                console.error('Text Extraction Failed (Non-fatal):', extractError);
                // 螟ｱ謨玲凾縺ｯ繧ｹ繝・・繧ｿ繧ｹ繧呈峩譁ｰ縺励※縺翫￥・医Θ繝ｼ繧ｶ繝ｼ縺ｫ縺ｯ蠕後〒騾夂衍・・
                // NOTE: dbService蛛ｴ縺ｧ閾ｪ蜍慕噪縺ｫ '譛ｪ蜃ｦ逅・ 縺ｫ縺ｪ縺｣縺ｦ縺・ｋ縺ｯ縺壹□縺後√お繝ｩ繝ｼ諠・�ｱ繧呈ｮ九☆縺ｪ繧峨％縺薙〒譖ｴ譁ｰ
            }

            // 3. 螳御ｺ・・逅・
            if (document.getElementById('reg-loading')) document.getElementById('reg-loading').remove();
            if (document.getElementById('reg-overlay')) document.getElementById('reg-overlay').remove();

            this.close();

            if (extractionSucceeded) {
                // 4. 隧ｳ邏ｰ繝壹・繧ｸ縺ｸ驕ｷ遘ｻ・医∪縺壹・蜴滓悽繧定｡ｨ遉ｺ縺励※螳牙ｿ・＆縺帙ｋ・・
                this.app.activeDetailTab = 'original';
                this.app.navigate('diff', newContract.id);
                Notify.toast('隱ｭ縺ｿ霎ｼ縺ｿ縺悟ｮ御ｺ・＠縺ｾ縺励◆縲・, {
                    type: 'success',
                    duration: 2000,
                    closable: false,
                    position: 'center'
                });
            } else {
                this.app.navigate('contracts');
                this.app.showToast('笞�・・逋ｻ骭ｲ縺ｯ螳御ｺ・＠縺ｾ縺励◆縺後√ユ繧ｭ繧ｹ繝域歓蜃ｺ縺ｫ螟ｱ謨励＠縺ｾ縺励◆', 'warning', 5000);
            }

        } catch (error) {
            console.error('Registration Error:', error);
            if (document.getElementById('reg-loading')) document.getElementById('reg-loading').remove();
            if (document.getElementById('reg-overlay')) document.getElementById('reg-overlay').remove();
            Notify.error('逋ｻ骭ｲ荳ｭ縺ｫ繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆: ' + error.message);
        }
    }

    async extractTextOnly(contractId, previousVersion = null, previousFileBase64 = null) {
        try {
            let sourceData = this.tempData.source;

            // PDF縺ｾ縺溘・Word縺ｮ蝣ｴ蜷医・FileReader縺ｧBase64縺ｫ螟画鋤
            if ((this.tempData.method === 'pdf' || this.tempData.method === 'docx') && this.tempData.fileData) {
                sourceData = await aiService.convertFileToBase64(this.tempData.fileData);
                if (this.tempData.method === 'pdf') {
                    this.app?.setRuntimePdfPreviewUrl(contractId, this.tempData.fileData);
                }
            }

            // For DOCX + compare file, run full structural diff analysis immediately.
            if (this.tempData.method === 'docx' && previousFileBase64) {
                const result = await aiService.analyzeContract(
                    contractId,
                    'docx',
                    sourceData,
                    previousFileBase64
                );

                if (!result.success) {
                    throw new Error(result.error || 'Word蟾ｮ蛻・ｧ｣譫舌↓螟ｱ謨励＠縺ｾ縺励◆');
                }
                const extractedContent = resolveExtractedContentPayload(result.data);
                if (!extractedContent) {
                    throw new Error('Word隗｣譫千ｵ先棡縺ｫ譛ｬ譁・ョ繝ｼ繧ｿ縺悟性縺ｾ繧後※縺・∪縺帙ｓ');
                }

                dbService.updateContractAnalysis(contractId, {
                    extractedText: extractedContent,
                    baselineContent: result.data.previousArticles || null,
                    sourceType: result.data.sourceType || 'DOCX',
                    changes: result.data.changes || [],
                    riskLevel: result.data.riskLevel,
                    riskReason: result.data.riskReason,
                    summary: result.data.summary,
                    isFallback: result.data.isFallback === true,
                    aiFailed: result.data.aiFailed === true,
                    status: '譛ｪ遒ｺ隱・,
                    originalFilename: this.tempData.fileData?.name || ''
                });
                await this.app.refreshSubscriptionStatusSafe();

                console.log('Word structured diff completed');
                return true;
            }

            const result = await aiService.analyzeContract(
                contractId,
                this.tempData.method,
                sourceData,
                previousFileBase64 || previousVersion, // Word豈碑ｼ・↑繧隠ase64繧貞━蜈・
                { skipAI: true }
            );

            if (result.success) {
                const extractedContent = resolveExtractedContentPayload(result.data);
                if (!extractedContent) {
                    throw new Error('謚ｽ蜃ｺ邨先棡縺ｫ譛ｬ譁・ョ繝ｼ繧ｿ縺悟性縺ｾ繧後※縺・∪縺帙ｓ');
                }
                // 謚ｽ蜃ｺ縺輔ｌ縺溘ユ繧ｭ繧ｹ繝医・縺ｿ繧剃ｿ晏ｭ假ｼ・I隗｣譫千ｵ先棡縺ｯ菫晏ｭ倥＠縺ｪ縺・ｼ・
                dbService.updateContractText(contractId, {
                    extractedText: extractedContent,
                    rawExtractedText: result.data.rawExtractedText,
                    extractedTextHash: result.data.extractedTextHash,
                    extractedTextLength: result.data.extractedTextLength,
                    sourceType: result.data.sourceType,
                    pdfStoragePath: result.data.pdfStoragePath,
                    pdfUrl: result.data.pdfUrl,
                    status: '譛ｪ蜃ｦ逅・  // 蟾ｮ蛻・′縺ｾ縺�縺ｪ縺・・縺ｧ譛ｪ蜃ｦ逅・
                });

                console.log('Text extraction completed');
                return true;
            } else {
                throw new Error(result.error || '繝・く繧ｹ繝域歓蜃ｺ縺ｫ螟ｱ謨励＠縺ｾ縺励◆');
            }

        } catch (error) {
            console.error('繝・く繧ｹ繝域歓蜃ｺ繧ｨ繝ｩ繝ｼ:', error);

            // 繧ｨ繝ｩ繝ｼ繧ｹ繝・・繧ｿ繧ｹ縺ｫ譖ｴ譁ｰ
            dbService.updateContractStatus(contractId, '逋ｻ骭ｲ螟ｱ謨・);

            // 繝ｦ繝ｼ繧ｶ繝ｼ縺ｫ繧ｨ繝ｩ繝ｼ繧帝夂衍
            const methodLabel = this.tempData.method === 'pdf' ? 'PDF' : (this.tempData.method === 'docx' ? 'Word' : 'URL');
            Notify.alert(`逕ｳ縺苓ｨｳ縺ゅｊ縺ｾ縺帙ｓ縲・{methodLabel}縺九ｉ縺ｮ繝・く繧ｹ繝域歓蜃ｺ縺ｫ螟ｱ謨励＠縺ｾ縺励◆縲・n\n蜴溷屏: ${error.message}\n\n窶ｻ逕ｻ蜒襲DF繧・ヱ繧ｹ繝ｯ繝ｼ繝我ｻ倥″PDF縲√∪縺溘・遐ｴ謳阪＠縺欷ord繝輔ぃ繧､繝ｫ縺ｯ蟇ｾ蠢懊＠縺ｦ縺・↑縺・�ｴ蜷医′縺ゅｊ縺ｾ縺吶Ａ, { type: 'error' });

            console.warn(`繝・く繧ｹ繝域歓蜃ｺ縺ｫ螟ｱ謨・ ${error.message}`);
            return false;
        }
    }

}

// --- App Logic ---
class DashboardApp {
    constructor() {
        this.currentView = 'dashboard';
        this.mainContent = document.getElementById('app-content');
        this.pageTitle = document.getElementById('page-header-title');
        this.currentViewParams = null;
        this.userRole = '邂｡逅・・; // Default: 繧ｪ繝ｼ繝翫・・・PI螟ｱ謨玲凾縺ｯ繝√・繝�繝｡繝ｳ繝舌・縺ｧ縺ｯ縺ｪ縺・・縺ｧ繧ｪ繝ｼ繝翫・謇ｱ縺・ｼ・


        // Navigation State
        this.searchQuery = "";
        this.currentPage = 1;
        this.runtimePdfPreviewUrls = new Map();
        this.historyComparisonContext = null;
        this.documentCompareState = null;
        this.dashboardFilter = "pending";
        this.activeDetailTab = 'original';
        this.filters = {
            query: "",
            risk: "all",
            status: "all",
            type: "all",
            sortBy: "date_desc"
        };
        this.searchTimeout = null;
        this.detailClauseNavScrollCleanup = null;
        this.detailClauseNavRaf = null;

        // Registration Flow
        this.registration = new RegistrationFlow(this);
        // 辟｡譁呎悄髢鍋ｵゆｺ・ヵ繝ｭ繝ｼ譎ゅ・豎ｺ貂医Δ繝ｼ繝繝ｫ繧帝哩縺倥ｉ繧後↑縺・ｈ縺・↓縺吶ｋ
        this.forceSubscriptionPayment = false;
        this.planViewBillingCycle = null;
        this.paymentConfig = null;
        this.paymentPlanAvailability = null;
        this.hasAnnualBillingPlans = null;
        this.stripeEnabled = false;
        this.stripePublishableKey = '';

        // 蛻晄悄陦ｨ遉ｺ繧堤┌譁吶・繝ｩ繝ｳ縺ｫ險ｭ螳・(繝√ぉ繝・け逕ｨ)
        this.subscription = { plan: 'free', billingCycle: 'monthly', usageCount: 0, usageLimit: 3, daysRemaining: null, planLimit: 10 };
        this.userPlan = 'free';

        // URL繝代Λ繝｡繝ｼ繧ｿ縺ｫ繧医ｋ繝励Λ繝ｳ蠑ｷ蛻ｶ (讀懆ｨｼ逕ｨ: ?forcePlan=free)
        const urlParams = new URLSearchParams(window.location.search);
        const forcedPlan = urlParams.get('forcePlan');
        if (forcedPlan === 'free') {
            this.subscription = { plan: 'free', billingCycle: 'monthly', usageCount: 0, usageLimit: 3, daysRemaining: null, planLimit: 10 };
            this.userPlan = 'free';
            // 繧ｭ繝｣繝・す繝･縺ｫ繧ゆｿ晏ｭ倥＠縺ｦ荳雋ｫ諤ｧ繧剃ｿ昴▽
            this.setCachedItem(DASHBOARD_CACHE_KEYS.SUBSCRIPTION, this.subscription);
        }

        this.memoryCache = new Map();
        this.pendingPairAnalysisKeys = new Set();
        this.attemptedAutoPairAnalysisKeys = new Set();
        this.bootstrapCompleted = false;
        this.hydrateCachedState();
    }

    setRuntimePdfPreviewUrl(contractId, file) {
        if (!contractId || !file || !(file instanceof File)) return;
        const key = String(contractId);
        const previous = this.runtimePdfPreviewUrls.get(key);
        if (previous) {
            try { URL.revokeObjectURL(previous); } catch (_) { /* noop */ }
        }
        const blobUrl = URL.createObjectURL(file);
        this.runtimePdfPreviewUrls.set(key, blobUrl);
    }

    getRuntimePdfPreviewUrl(contractId) {
        if (!contractId) return null;
        return this.runtimePdfPreviewUrls.get(String(contractId)) || null;
    }

    setHistoryComparisonContext(context = null) {
        this.historyComparisonContext = context && typeof context === 'object'
            ? { ...context }
            : null;
    }

    getHistoryComparisonContext(contractId) {
        if (!this.historyComparisonContext) return null;
        if (contractId !== undefined && contractId !== null && Number(this.historyComparisonContext.contractId) !== Number(contractId)) {
            return null;
        }
        return this.historyComparisonContext;
    }

    clearHistoryComparisonContext(contractId = null) {
        if (!this.historyComparisonContext) return;
        if (contractId !== null && contractId !== undefined && Number(this.historyComparisonContext.contractId) !== Number(contractId)) {
            return;
        }
        this.historyComparisonContext = null;
    }

    getDocumentCompareState(contractId = null) {
        if (!this.documentCompareState) return null;
        if (contractId !== null && contractId !== undefined && Number(this.documentCompareState.contractId) !== Number(contractId)) {
            return null;
        }
        return this.documentCompareState;
    }

    setDocumentCompareState(state = null) {
        this.documentCompareState = state && typeof state === 'object' ? { ...state } : null;
    }

    syncLatestDocumentCompareState(contractId) {
        const docs = dbService.getDocumentsByContractId(contractId);
        const currentDoc = docs.find((doc) => doc.is_current) || null;
        const historicalDocs = docs.filter((doc) => !doc.is_current);
        const latestHistoryDoc = historicalDocs.length > 0 ? historicalDocs[historicalDocs.length - 1] : null;
        if (!currentDoc || !latestHistoryDoc) return;
        this.setDocumentCompareState({
            contractId,
            docAId: latestHistoryDoc.id,
            docBId: currentDoc.id
        });
    }

    clearDocumentCompareState(contractId = null) {
        if (!this.documentCompareState) return;
        if (contractId !== null && contractId !== undefined && Number(this.documentCompareState.contractId) !== Number(contractId)) {
            return;
        }
        this.documentCompareState = null;
    }

    buildPairAnalysisKey(contractId, docAId, docBId) {
        if (!contractId || !docAId || !docBId) return '';
        return `${contractId}:${docAId}->${docBId}`;
    }

    isPairAnalysisPending(contractId, docAId, docBId) {
        const key = this.buildPairAnalysisKey(contractId, docAId, docBId);
        return key ? this.pendingPairAnalysisKeys.has(key) : false;
    }

    scheduleAutoPairAnalysis(contractId, docAId, docBId, options = {}) {
        if (!this.can('operate_contract')) return false;

        const key = this.buildPairAnalysisKey(contractId, docAId, docBId);
        if (!key) return false;
        if (this.pendingPairAnalysisKeys.has(key)) return true;
        if (this.attemptedAutoPairAnalysisKeys.has(key)) return false;

        const force = options.force === true;
        this.pendingPairAnalysisKeys.add(key);
        this.attemptedAutoPairAnalysisKeys.add(key);

        setTimeout(async () => {
            try {
                if (this.currentView !== 'diff' || Number(this.currentViewParams) !== Number(contractId)) return;

                const docs = dbService.getDocumentsByContractId(contractId);
                const sourceDoc = docs.find((doc) => doc.id === docAId);
                const targetDoc = docs.find((doc) => doc.id === docBId);
                if (!sourceDoc || !targetDoc || sourceDoc.id === targetDoc.id) return;

                const cached = dbService.getDiffResult(docAId, docBId);
                if (!force && hasAnalysisRecord(cached?.diff_data)) return;

                await this.analyzeDocumentPair(contractId, sourceDoc, targetDoc, { force, silent: true, auto: true });
            } catch (error) {
                console.error('Auto pair analysis error:', error);
            } finally {
                this.pendingPairAnalysisKeys.delete(key);
            }
        }, 0);

        return true;
    }

    getCachedItem(key, maxAgeMs = 5 * 60 * 1000) {
        try {
            const mem = this.memoryCache.get(key);
            if (mem && Date.now() - mem.ts < maxAgeMs) return mem.value;
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            if (Date.now() - (parsed.ts || 0) > maxAgeMs) return null;
            this.memoryCache.set(key, parsed);
            return parsed.value;
        } catch {
            return null;
        }
    }

    setCachedItem(key, value) {
        try {
            const payload = { ts: Date.now(), value };
            this.memoryCache.set(key, payload);
            localStorage.setItem(key, JSON.stringify(payload));
        } catch {
            // ignore cache errors
        }
    }

    hydrateCachedState() {
        // URL繝代Λ繝｡繝ｼ繧ｿ蜆ｪ蜈・
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('forcePlan') === 'free') return;

        const cachedSub = this.getCachedItem(DASHBOARD_CACHE_KEYS.SUBSCRIPTION, 10 * 60 * 1000);
        if (cachedSub && cachedSub.plan) {
            this.subscription = {
                ...this.subscription,
                ...cachedSub,
                billingCycle: cachedSub.billingCycle === 'annual' ? 'annual' : 'monthly'
            };
            this.userPlan = cachedSub.plan;
        }

        const cachedUser = this.getCachedItem(DASHBOARD_CACHE_KEYS.USER_META, 30 * 60 * 1000);
        if (cachedUser) {
            if (cachedUser.role) this.userRole = cachedUser.role;
            if (cachedUser.email) {
                const emailEl = document.getElementById('user-email-display');
                if (emailEl) emailEl.textContent = cachedUser.email;
            }
            if (cachedUser.name) {
                const nameEl = document.getElementById('user-name-display');
                if (nameEl) nameEl.textContent = cachedUser.name;
            }
        }
    }

    renderInitialSkeleton(viewId = 'dashboard') {
        if (!this.mainContent) return;
        this.mainContent.innerHTML = Views.loading(viewId);
    }

    cacheRecentHistorySnapshot() {
        try {
            const logs = dbService.getActivityLogs();
            if (Array.isArray(logs) && logs.length > 0) {
                this.setCachedItem(DASHBOARD_CACHE_KEYS.RECENT_HISTORY, logs.slice(0, 30));
            }
        } catch {
            // ignore cache errors
        }
    }

    /**
     * Compute days remaining until a date string (YYYY-MM-DD).
     * Returns null if date is invalid.
     */
    _daysUntil(dateStr) {
        if (!dateStr) return null;
        const target = new Date(dateStr);
        if (isNaN(target.getTime())) return null;
        target.setHours(0, 0, 0, 0);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return Math.round((target - today) / (1000 * 60 * 60 * 24));
    }

    /**
     * Format YYYY-MM-DD to Japanese locale string.
     */
    _formatDateJa(dateStr) {
        if (!dateStr) return '窶・;
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
    }

    /**
     * Show modal with document viewer (paginated) + deadline input form.
     */
    showDeadlineInputModal(contractId) {
        const contracts = dbService.getContracts();
        const c = contracts.find(x => String(x.id) === String(contractId));
        if (!c) return;

        // Build document content HTML using inline styles only (no CSS class dependency)
        let contentHtml = '';
        if (c.original_content) {
            const clauses = parseContractIntoClauses(c.original_content);
            if (clauses && clauses.length > 0) {
                contentHtml = clauses.map(clause => {
                    const titleHtml = clause.title
                        ? `<div style="font-size:13px;font-weight:700;color:#c5a059;margin-bottom:4px;">${clause.title}${clause.header ? `縲${clause.header}` : ''}</div>`
                        : '';
                    const bodyHtml = (clause.paragraphs || []).map(p =>
                        `<p style="margin:0 0 8px;line-height:1.8;font-size:13px;color:#2b2623;">${String(p).replace(/\n/g, '<br>')}</p>`
                    ).join('');
                    return `<div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid #f0ece8;">${titleHtml}${bodyHtml}</div>`;
                }).join('');
            }
        }
        if (!contentHtml && c.extracted_text) {
            const paragraphs = c.extracted_text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
            contentHtml = paragraphs.length > 0
                ? `<div style="padding:4px 0;">${paragraphs.map(p => `<p style="margin:0 0 14px;line-height:1.8;font-size:13px;color:#2b2623;">${p.replace(/\n/g, '<br>')}</p>`).join('')}</div>`
                : '';
        }
        if (!contentHtml) {
            contentHtml = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#aaa;gap:12px;padding:40px 0;">
                <i class="fa-solid fa-file-lines" style="font-size:36px;"></i>
                <div style="font-size:13px;">譖ｸ鬘槭・譛ｬ譁・′蜿門ｾ励〒縺阪∪縺帙ｓ縺ｧ縺励◆</div>
                <div style="font-size:12px;">荳玖ｨ倥ヵ繧ｩ繝ｼ繝�縺九ｉ譛滄剞繧堤峩謗･蜈･蜉帙＠縺ｦ縺上□縺輔＞</div>
              </div>`;
        }

        document.getElementById('deadline-input-overlay')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'deadline-input-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;';
        overlay.innerHTML = `
            <div style="background:#fff;border-radius:12px;width:100%;max-width:1100px;height:88vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,0.22);overflow:hidden;">

                <!-- Header -->
                <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid #eee;flex-shrink:0;">
                    <div>
                        <div style="font-size:15px;font-weight:700;color:#2b2623;">${c.name || '螂醍ｴ・嶌'}</div>
                        <div style="font-size:12px;color:#aaa;margin-top:2px;">${c.type || ''}${c.contract_category ? ' ﾂｷ ' + c.contract_category : ''}</div>
                    </div>
                    <button onclick="document.getElementById('deadline-input-overlay').remove()" style="background:none;border:none;font-size:22px;color:#aaa;cursor:pointer;line-height:1;padding:4px 8px;">笨・/button>
                </div>

                <!-- Body: left=doc, right=form -->
                <div style="display:flex;flex:1;overflow:hidden;min-height:0;">

                    <!-- Document viewer (scrollable) -->
                    <div style="flex:1;overflow:hidden;min-width:0;border-right:1px solid #eee;">
                        <div style="height:100%;overflow-y:auto;padding:20px 24px;box-sizing:border-box;">
                            ${contentHtml}
                        </div>
                    </div>

                    <!-- Deadline input form -->
                    <div style="width:280px;flex-shrink:0;display:flex;flex-direction:column;padding:24px 20px;gap:16px;overflow-y:auto;">
                        <div style="font-size:13px;font-weight:700;color:#2b2623;margin-bottom:4px;"><i class="fa-solid fa-calendar-days" style="color:#c5a059;margin-right:6px;"></i>譛滄剞繧貞・蜉・/div>
                        <div>
                            <label style="font-size:11px;font-weight:600;color:#5e544d;display:block;margin-bottom:5px;">螂醍ｴ・ｵゆｺ・律</label>
                            <input type="date" id="dl-expiry" value="${c.expiry_date || ''}"
                                style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;box-sizing:border-box;">
                        </div>
                        <div style="flex:1;"></div>
                        <div style="display:flex;flex-direction:column;gap:8px;">
                            <button onclick="window.app.saveDeadlineInput('${contractId}')"
                                style="padding:10px;border:none;border-radius:6px;background:#c5a059;color:#fff;font-size:13px;font-weight:600;cursor:pointer;width:100%;">
                                <i class="fa-solid fa-check" style="margin-right:6px;"></i>菫晏ｭ・
                            </button>
                            <button onclick="document.getElementById('deadline-input-overlay').remove()"
                                style="padding:9px;border:1px solid #ddd;border-radius:6px;background:#fff;color:#5e544d;font-size:13px;cursor:pointer;width:100%;">繧ｭ繝｣繝ｳ繧ｻ繝ｫ</button>
                        </div>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    }

    /**
     * Show confirmation popup before running single-doc reanalysis.
     */
    confirmReanalyze(contractId) {
        const overlay = document.createElement('div');
        overlay.id = 'reanalyze-confirm-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9500;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div style="background:#fff;border-radius:12px;padding:28px 32px;width:400px;max-width:92vw;box-shadow:0 8px 32px rgba(0,0,0,0.18);">
                <div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:20px;">
                    <div style="width:40px;height:40px;border-radius:10px;background:#fef3e2;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                        <i class="fa-solid fa-wand-magic-sparkles" style="color:#c5a059;font-size:18px;"></i>
                    </div>
                    <div>
                        <div style="font-size:15px;font-weight:700;color:#2b2623;margin-bottom:6px;">AI繝ｪ繧ｹ繧ｯ隗｣譫舌ｒ螳溯｡後＠縺ｾ縺吶°・・/div>
                        <div style="font-size:13px;color:#5e544d;line-height:1.6;">
                            繝ｪ繧ｹ繧ｯ隗｣譫舌→譛滄剞隗｣譫舌ｒ蜷梧凾縺ｫ陦後＞縺ｾ縺吶・br>
                            <strong style="color:#c5a059;">隗｣譫・蝗槭ｒ豸郁ｲｻ縺励∪縺吶・/strong>
                        </div>
                    </div>
                </div>
                <div style="background:#f8f6f3;border-radius:8px;padding:12px 14px;margin-bottom:20px;font-size:12px;color:#7a6a5a;line-height:1.6;">
                    <i class="fa-solid fa-circle-info" style="color:#c5a059;margin-right:6px;"></i>
                    蟾ｮ蛻・メ繧ｧ繝・け縺ｪ縺励〒繧ゅ、I縺梧嶌鬘槫・菴薙・繝ｪ繧ｹ繧ｯ縺ｨ螂醍ｴ・悄髯舌ｒ謚ｽ蜃ｺ縺励∪縺吶・
                </div>
                <div style="display:flex;gap:10px;justify-content:flex-end;">
                    <button onclick="document.getElementById('reanalyze-confirm-overlay').remove()"
                        style="padding:9px 20px;border:1px solid #ddd;border-radius:6px;background:#fff;color:#5e544d;font-size:14px;cursor:pointer;">繧ｭ繝｣繝ｳ繧ｻ繝ｫ</button>
                    <button onclick="document.getElementById('reanalyze-confirm-overlay').remove();window.app.runReanalyze('${contractId}')"
                        style="padding:9px 22px;border:none;border-radius:6px;background:#c5a059;color:#fff;font-size:14px;font-weight:600;cursor:pointer;">
                        <i class="fa-solid fa-play" style="margin-right:6px;"></i>隗｣譫舌☆繧・
                    </button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    }

    /**
     * Execute single-doc reanalysis (risk + deadline) via API.
     */
    async runReanalyze(contractId) {
        const contracts = dbService.getContracts();
        const c = contracts.find(x => String(x.id) === String(contractId));
        if (!c) { Notify.error('螂醍ｴ・′隕九▽縺九ｊ縺ｾ縺帙ｓ'); return; }

        // original_content 縺後が繝悶ず繧ｧ繧ｯ繝茨ｼ域ｧ矩�蛹褒SON・峨・蝣ｴ蜷医・繝・く繧ｹ繝医↓螟画鋤
        let contractText = '';
        if (c.original_content && typeof c.original_content === 'object') {
            const oc = c.original_content;
            const parts = [];
            if (oc.preamble) parts.push(oc.preamble);
            if (Array.isArray(oc.articles)) {
                for (const a of oc.articles) {
                    if (a.articleNumber || a.title) parts.push(`${a.articleNumber || ''} ${a.title || ''}`.trim());
                    if (a.content) parts.push(a.content);
                }
            }
            contractText = parts.join('\n\n').trim();
        }
        if (!contractText) {
            contractText = (typeof c.original_content === 'string' ? c.original_content : (c.extracted_text || '')).trim();
        }
        if (!contractText || contractText.length < 10) {
            Notify.warning('譖ｸ鬘槭・譛ｬ譁・ョ繝ｼ繧ｿ縺後≠繧翫∪縺帙ｓ縲ょｷｮ蛻・メ繧ｧ繝・け縺ｧ蜿悶ｊ霎ｼ繧薙〒縺上□縺輔＞縲・);
            return;
        }

        // Show loading state on button
        const btn = document.getElementById('btn-reanalyze');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>隗｣譫蝉ｸｭ...';
        }

        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            const apiBase = (await import('./api-base.js')).getApiBaseUrl();

            const res = await fetch(`${apiBase}/api/contracts/${contractId}/reanalyze`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ contractText })
            });
            const data = await res.json();

            if (!data.success) {
                Notify.error(data.error || '隗｣譫舌↓螟ｱ謨励＠縺ｾ縺励◆');
                if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>AI繝ｪ繧ｹ繧ｯ隗｣譫・; }
                return;
            }

            // updateContractAnalysis 縺ｧ ai_summary/ai_risk_reason/ai_changes 繧呈ｭ｣縺励￥菫晏ｭ・
            dbService.updateContractAnalysis(contractId, {
                summary: data.data.summary,
                riskLevel: data.data.riskLevel,
                riskReason: data.data.riskReason,
                changes: data.data.changes || [],
                status: '譛ｪ遒ｺ隱・,
            });
            // contract_meta・域悄髯先ュ蝣ｱ・峨ｒ霑ｽ蜉�菫晏ｭ・
            if (data.data.contract_meta) {
                const meta = data.data.contract_meta;
                const allContracts = dbService.getContracts();
                const idx = allContracts.findIndex(x => String(x.id) === String(contractId));
                if (idx !== -1) {
                    Object.assign(allContracts[idx], {
                        expiry_date: meta.expiry_date || null,
                        renewal_deadline: meta.renewal_deadline || null,
                        contract_start: meta.contract_start || null,
                        auto_renewal: meta.auto_renewal,
                        contract_category: meta.contract_category || null,
                        date_confidence: meta.date_confidence || 'unknown',
                    });
                    localStorage.setItem(dbService.KEYS.CONTRACTS, JSON.stringify(allContracts));
                }
            }
            await this.refreshSubscriptionStatusSafe();

            // 譛滄剞諠・�ｱ縺ｮ蜿門ｾ礼ｵ先棡繧帝夂衍
            const meta = data.data.contract_meta;
            const hasDeadline = meta && (meta.expiry_date || meta.renewal_deadline || meta.contract_start);
            if (hasDeadline) {
                Notify.success('隗｣譫仙ｮ御ｺ・よ悄髯先ュ蝣ｱ繧呈悄髯舌・繧｢繝ｩ繝ｼ繝育ｮ｡逅・↓譬ｼ邏阪＠縺ｾ縺励◆');
            } else {
                Notify.success('隗｣譫舌′螳御ｺ・＠縺ｾ縺励◆');
                setTimeout(() => {
                    Notify.info('譛滄剞諠・�ｱ繧貞叙蠕励〒縺阪∪縺帙ｓ縺ｧ縺励◆縲ゅ梧悄髯舌・繧｢繝ｩ繝ｼ繝育ｮ｡逅・阪°繧画焔蜍募・蜉帙☆繧九→縲√せ繝ｩ繝・け繝ｻ繝｡繝ｼ繝ｫ縺ｧ騾夂衍縺悟ｱ翫″縺ｾ縺・, { duration: 6000 });
                }, 800);
            }
            // Re-render detail view
            this.navigate('diff', contractId);

        } catch (err) {
            Notify.error('隗｣譫舌お繝ｩ繝ｼ: ' + err.message);
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>AI繝ｪ繧ｹ繧ｯ隗｣譫・; }
        }
    }

    /**
     * Toggle per-contract deadline notification on/off.
     */
    toggleDeadlineNotify(contractId, enabled) {
        const contracts = dbService.getContracts();
        const idx = contracts.findIndex(x => String(x.id) === String(contractId));
        if (idx === -1) return;
        contracts[idx].deadline_notify = enabled;
        localStorage.setItem(dbService.KEYS.CONTRACTS, JSON.stringify(contracts));
    }

    /**
     * Save manually entered deadline back to localStorage and re-render.
     */
    saveDeadlineInput(contractId) {
        const expiry = document.getElementById('dl-expiry')?.value || null;
        if (!expiry) {
            Notify.warning('螂醍ｴ・ｵゆｺ・律繧貞・蜉帙＠縺ｦ縺上□縺輔＞');
            return;
        }

        const contracts = dbService.getContracts();
        const idx = contracts.findIndex(x => String(x.id) === String(contractId));
        if (idx === -1) return;

        contracts[idx] = {
            ...contracts[idx],
            expiry_date: expiry,
            date_confidence: 'high',
        };
        localStorage.setItem(dbService.KEYS.CONTRACTS, JSON.stringify(contracts));

        document.getElementById('deadline-input-overlay')?.remove();
        Notify.success('譛滄剞繧剃ｿ晏ｭ倥＠縺ｾ縺励◆');
        this.navigate('deadlines');
    }

    /**
     * Re-analyze a contract from the deadline alerts view to extract deadline info.
     */
    async runDeadlineReanalyze(contractId) {
        const contracts = dbService.getContracts();
        const c = contracts.find(x => String(x.id) === String(contractId));
        if (!c) { Notify.error('螂醍ｴ・′隕九▽縺九ｊ縺ｾ縺帙ｓ'); return; }

        let contractText = '';
        if (c.original_content && typeof c.original_content === 'object') {
            const oc = c.original_content;
            const parts = [];
            if (oc.preamble) parts.push(oc.preamble);
            if (Array.isArray(oc.articles)) {
                for (const a of oc.articles) {
                    if (a.articleNumber || a.title) parts.push(`${a.articleNumber || ''} ${a.title || ''}`.trim());
                    if (a.content) parts.push(a.content);
                }
            }
            contractText = parts.join('\n\n').trim();
        }
        if (!contractText) {
            contractText = (typeof c.original_content === 'string' ? c.original_content : (c.extracted_text || '')).trim();
        }
        if (!contractText || contractText.length < 10) {
            Notify.warning('譖ｸ鬘槭・譛ｬ譁・ョ繝ｼ繧ｿ縺後≠繧翫∪縺帙ｓ縲ょｷｮ蛻・メ繧ｧ繝・け縺九ｉ蜀榊叙繧願ｾｼ縺ｿ縺励※縺上□縺輔＞縲・);
            return;
        }

        const btn = document.getElementById(`btn-deadline-reanalyze-${contractId}`);
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:4px;font-size:10px;"></i>隗｣譫蝉ｸｭ...';
        }

        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            const apiBase = (await import('./api-base.js')).getApiBaseUrl();

            const res = await fetch(`${apiBase}/api/contracts/${contractId}/reanalyze`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ contractText })
            });
            const data = await res.json();

            if (!data.success) {
                Notify.error(data.error || '蜀崎ｧ｣譫舌↓螟ｱ謨励＠縺ｾ縺励◆');
                if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-rotate" style="margin-right:4px;font-size:10px;"></i>蜀崎ｧ｣譫・; }
                return;
            }

            if (data.data.contract_meta) {
                const meta = data.data.contract_meta;
                const allContracts = dbService.getContracts();
                const idx = allContracts.findIndex(x => String(x.id) === String(contractId));
                if (idx !== -1) {
                    Object.assign(allContracts[idx], {
                        expiry_date: meta.expiry_date || null,
                        renewal_deadline: meta.renewal_deadline || null,
                        contract_start: meta.contract_start || null,
                        auto_renewal: meta.auto_renewal,
                        contract_category: meta.contract_category || null,
                        date_confidence: meta.date_confidence || 'unknown',
                    });
                    localStorage.setItem(dbService.KEYS.CONTRACTS, JSON.stringify(allContracts));
                }
            }
            await this.refreshSubscriptionStatusSafe();

            const meta = data.data.contract_meta;
            const hasDeadline = meta && (meta.expiry_date || meta.renewal_deadline);
            if (hasDeadline) {
                Notify.success('蜀崎ｧ｣譫仙ｮ御ｺ・よ悄髯先ュ蝣ｱ繧貞叙蠕励＠縺ｾ縺励◆');
            } else {
                Notify.warning('蜀崎ｧ｣譫舌＠縺ｾ縺励◆縺梧悄髯先ュ蝣ｱ繧貞叙蠕励〒縺阪∪縺帙ｓ縺ｧ縺励◆縲よ焔蜍輔〒蜈･蜉帙＠縺ｦ縺上□縺輔＞縲・);
            }
            this.navigate('deadlines');
        } catch (err) {
            Notify.error('蜀崎ｧ｣譫舌お繝ｩ繝ｼ: ' + err.message);
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-rotate" style="margin-right:4px;font-size:10px;"></i>蜀崎ｧ｣譫・; }
        }
    }

    /**
     * Update the sidebar badge for deadlines (urgent contracts count).
     */
    updateDeadlinesBadge() {
        const badge = document.getElementById('nav-deadlines-badge');
        if (!badge) return;
        const contracts = dbService.getContracts ? dbService.getContracts() : (dbService._localContracts || []);
        const urgentCount = contracts.filter(c => {
            const days = this._daysUntil(c.expiry_date);
            return days !== null && days >= 0 && days <= 30;
        }).length;
        if (urgentCount > 0) {
            badge.textContent = urgentCount;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    }

    /**
     * Render the deadlines management view.
     */
    renderDeadlinesView(opts = {}) {
        const plan = this.userPlan || this.subscription?.plan || 'free';
        const deadlineLocked = !['business', 'pro'].includes(plan);

        const query = (opts.query || '').trim().toLowerCase();
        const filterRange = opts.filterRange || 'all'; // all | urgent | warning | upcoming | nodate
        const sortKey = opts.sortKey || 'analyzed'; // analyzed | days | name | date
        const sortDir = opts.sortDir || 'desc';

        const allContracts = (dbService.getContracts ? dbService.getContracts() : (dbService._localContracts || []))
            .filter(c => c.last_analyzed_at); // 繝ｪ繧ｹ繧ｯ隗｣譫先ｸ医∩縺ｮ縺ｿ陦ｨ遉ｺ

        // Annotate with days remaining
        const annotated = allContracts.map(c => {
            const targetDate = c.expiry_date;
            const days = this._daysUntil(targetDate);
            let range = 'nodate';
            if (days !== null) {
                if (days < 0) range = 'past';
                else if (days <= 7) range = 'urgent';
                else if (days <= 30) range = 'warning';
                else range = 'upcoming';
            }
            return { ...c, _daysRemaining: days, _range: range };
        });

        // Filter by search query
        const searched = query
            ? annotated.filter(c =>
                (c.name || '').toLowerCase().includes(query) ||
                (c.contract_category || '').toLowerCase().includes(query) ||
                (c.type || '').toLowerCase().includes(query)
              )
            : annotated;

        // Filter by range tab
        const filtered = filterRange === 'all'
            ? searched.filter(c => c._range !== 'past')
            : searched.filter(c => c._range === filterRange);

        // Sort
        const sorted = [...filtered].sort((a, b) => {
            let va, vb;
            if (sortKey === 'analyzed') {
                va = a.last_analyzed_at || '0';
                vb = b.last_analyzed_at || '0';
            } else if (sortKey === 'days') {
                va = a._daysRemaining ?? 99999;
                vb = b._daysRemaining ?? 99999;
            } else if (sortKey === 'name') {
                va = (a.name || '').toLowerCase();
                vb = (b.name || '').toLowerCase();
            } else if (sortKey === 'date') {
                va = a.expiry_date || '9999';
                vb = b.expiry_date || '9999';
            }
            if (va < vb) return sortDir === 'asc' ? -1 : 1;
            if (va > vb) return sortDir === 'asc' ? 1 : -1;
            return 0;
        });

        // Counts for tab badges
        const counts = {
            all: annotated.filter(c => c._range !== 'past').length,
            urgent: annotated.filter(c => c._range === 'urgent').length,
            warning: annotated.filter(c => c._range === 'warning').length,
            upcoming: annotated.filter(c => c._range === 'upcoming').length,
            nodate: annotated.filter(c => c._range === 'nodate').length,
        };

        const sortBtn = (key, label, extraStyle = '') => {
            const active = sortKey === key;
            const nextDir = active && sortDir === 'asc' ? 'desc' : 'asc';
            const arrow = active ? (sortDir === 'asc' ? ' 竊・ : ' 竊・) : '';
            return `<th style="padding:10px 12px;text-align:left;font-size:12px;color:${active ? '#c5a059' : '#8a7a6a'};font-weight:600;cursor:pointer;white-space:nowrap;${extraStyle}"
                onclick="window.app.navigate('deadlines', {query:'${query}',filterRange:'${filterRange}',sortKey:'${key}',sortDir:'${nextDir}'})">${label}${arrow}</th>`;
        };

        const rows = sorted.map(c => {
            const days = c._daysRemaining;
            const noDate = c._range === 'nodate';
            const badgeColor = days === null ? '#aaa' : days <= 7 ? '#e53935' : days <= 30 ? '#f57c00' : '#2e7d32';
            const daysLabel = days === null ? '譛ｪ險ｭ螳・ : days === 0 ? '譛ｬ譌･' : days < 0 ? '譛滄剞蛻・ｌ' : `縺ゅ→ ${days} 譌･`;
            const targetDate = c.expiry_date;
            const notifyEnabled = c.deadline_notify !== false;
            const notifyToggle = `<label class="toggle-switch" style="flex-shrink:0;" onclick="event.stopPropagation()">
                <input type="checkbox" ${notifyEnabled ? 'checked' : ''} onchange="window.app.toggleDeadlineNotify('${c.id}', this.checked)">
                <span class="toggle-slider"></span>
            </label>`;
            const categoryBadge = c.contract_category
                ? `<span style="font-size:11px;background:#f0ede8;color:#7a6a5a;border-radius:4px;padding:2px 7px;">${c.contract_category}</span>`
                : '';
            const daysBadge = noDate
                ? `<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">
                    <button onclick="event.stopPropagation();window.app.showDeadlineInputModal('${c.id}')"
                        style="background:#fff;border:1.5px dashed #c5a059;color:#c5a059;border-radius:20px;padding:3px 0;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;width:90px;text-align:center;">
                        <i class="fa-solid fa-plus" style="margin-right:4px;font-size:10px;"></i>譛滄剞繧貞・蜉・
                    </button>
                    <button id="btn-deadline-reanalyze-${c.id}" onclick="event.stopPropagation();window.app.runDeadlineReanalyze('${c.id}')"
                        style="background:#fff;border:1.5px dashed #aaa;color:#666;border-radius:20px;padding:3px 0;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;width:90px;text-align:center;">
                        <i class="fa-solid fa-rotate" style="margin-right:4px;font-size:10px;"></i>蜀崎ｧ｣譫・
                    </button>
                  </div>`
                : `<span style="display:inline-block;background:${badgeColor};color:#fff;border-radius:20px;padding:3px 12px;font-size:12px;font-weight:700;">${daysLabel}</span>`;
            const rowClick = `onclick="window.app.showDeadlineInputModal('${c.id}')"`;
            return `<tr style="cursor:pointer;" ${rowClick}>
                <td><div style="font-weight:600;color:#2b2623;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.name || '窶・}</div>${categoryBadge ? `<div style="margin-top:4px;">${categoryBadge}</div>` : ''}</td>
                <td style="font-size:13px;color:#5e544d;white-space:nowrap;width:130px;">${targetDate ? this._formatDateJa(targetDate) : '窶・}</td>
                <td style="white-space:nowrap;width:140px;">${daysBadge}</td>
                <td style="white-space:nowrap;width:90px;">${notifyToggle}</td>
            </tr>`;
        }).join('');

        const tabBtn = (range, label, icon) => {
            const active = filterRange === range;
            const count = counts[range];
            return `<button onclick="window.app.navigate('deadlines', {query:'${query}',filterRange:'${range}',sortKey:'${sortKey}',sortDir:'${sortDir}'})"
                style="padding:7px 14px;border:1px solid ${active ? '#c5a059' : '#ddd'};border-radius:6px;background:${active ? '#c5a059' : '#fff'};color:${active ? '#fff' : '#5e544d'};font-size:13px;font-weight:${active ? '700' : '400'};cursor:pointer;display:flex;align-items:center;gap:6px;">
                ${icon} ${label}${count > 0 ? ` <span style="background:${active ? 'rgba(255,255,255,0.3)' : '#f0ede8'};color:${active ? '#fff' : '#7a6a5a'};border-radius:10px;padding:1px 7px;font-size:11px;">${count}</span>` : ''}
            </button>`;
        };

        const pageHtml = `
        <div class="flex justify-between items-center mb-md">
            <h2 class="page-title" style="margin-bottom:0;">譛滄剞繝ｻ繧｢繝ｩ繝ｼ繝育ｮ｡逅・/h2>
        </div>

        <div class="filter-bar mb-md">
            <div class="flex flex-wrap gap-md items-center">
                <div style="position:relative;flex:1;min-width:240px;">
                    <i class="fa-solid fa-magnifying-glass" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:#999;"></i>
                    <input type="text" placeholder="螂醍ｴ・錐繝ｻ遞ｮ蛻･縺ｧ讀懃ｴ｢..."
                        value="${query}"
                        style="padding:8px 12px 8px 36px;border:1px solid #ddd;border-radius:4px;width:100%;font-size:13px;box-sizing:border-box;"
                        oninput="window.app.navigate('deadlines', {query:this.value,filterRange:'${filterRange}',sortKey:'${sortKey}',sortDir:'${sortDir}'})">
                </div>
                <div class="flex gap-sm items-center flex-wrap">
                    ${tabBtn('all', '縺吶∋縺ｦ', '')}
                    ${tabBtn('urgent', '7譌･莉･蜀・, '')}
                    ${tabBtn('warning', '30譌･莉･蜀・, '')}
                    ${tabBtn('upcoming', '90譌･莉･蜀・, '')}
                    ${tabBtn('nodate', '譛滄剞譛ｪ險ｭ螳・, '')}
                </div>
            </div>
        </div>

        <div class="table-container">
            <table class="data-table deadlines-table" style="table-layout:fixed;width:100%;">
                <thead>
                    <tr>
                        ${sortBtn('name', '螂醍ｴ・錐')}
                        ${sortBtn('date', '譛滄剞譌･', 'white-space:nowrap;width:130px;')}
                        ${sortBtn('days', '谿九ｊ譌･謨ｰ', 'white-space:nowrap;width:140px;')}
                        <th style="padding:10px 12px;text-align:left;font-size:12px;color:#8a7a6a;font-weight:600;white-space:nowrap;width:90px;">騾夂衍</th>
                    </tr>
                </thead>
                <tbody>
                    ${sorted.length > 0 ? rows : `<tr><td colspan="4" class="text-center text-muted" style="padding:40px;">隧ｲ蠖薙☆繧句･醍ｴ・′隕九▽縺九ｊ縺ｾ縺帙ｓ縺ｧ縺励◆</td></tr>`}
                </tbody>
            </table>
        </div>
        <div class="text-muted" style="font-size:13px;margin-top:12px;">蜈ｨ ${counts.all} 莉ｶ荳ｭ ${sorted.length} 莉ｶ繧定｡ｨ遉ｺ
            ${counts.nodate > 0 ? `<span style="margin-left:16px;"><i class="fa-solid fa-circle-info" style="color:#c5a059;margin-right:4px;"></i>譛滄剞譛ｪ險ｭ螳・${counts.nodate} 莉ｶ・壼･醍ｴ・嶌繧定ｧ｣譫舌☆繧九→AI縺瑚・蜍輔〒譛滄剞繧呈歓蜃ｺ縺励∪縺吶ょ､ｱ謨励＠縺溯ｧ｣譫仙屓謨ｰ縺ｯ豸郁励＠縺ｾ縺帙ｓ縲・/span>` : ''}
        </div>`;

        const lockOverlay = deadlineLocked ? `<div style="position:fixed;top:0;right:0;bottom:0;left:240px;display:flex;align-items:center;justify-content:center;background:rgba(245,247,250,0.85);backdrop-filter:blur(3px);z-index:1000;"><div style="background:#fff;border-radius:12px;padding:32px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.13);max-width:300px;width:90%;"><i class="fa-solid fa-crown" style="color:#c19b4a;font-size:2rem;margin-bottom:12px;display:block;"></i><div style="display:inline-block;background:#f3f0ea;color:#c5a059;border:1px solid #e8d9b8;border-radius:10px;padding:3px 12px;font-size:11px;font-weight:700;margin-bottom:12px;">Business / Pro繝励Λ繝ｳ髯仙ｮ・/div><div style="font-weight:700;font-size:15px;margin-bottom:8px;color:#2b2623;">譛滄剞繝ｻ繧｢繝ｩ繝ｼ繝育ｮ｡逅・/div><p style="font-size:12px;color:#888;line-height:1.6;margin-bottom:20px;">螂醍ｴ・悄髯舌・閾ｪ蜍墓歓蜃ｺ繝ｻ繧｢繝ｩ繝ｼ繝磯夂衍縺ｯBusiness繝励Λ繝ｳ莉･荳翫〒縺泌茜逕ｨ縺・◆縺�縺代∪縺吶・/p><button onclick="window.app.navigate('plan')" style="width:100%;padding:10px;border:none;border-radius:8px;background:#c5a059;color:#fff;font-size:13px;font-weight:700;cursor:pointer;">繧｢繝・・繧ｰ繝ｬ繝ｼ繝峨☆繧・/button></div></div>` : '';

        return `<div style="position:relative;">${pageHtml}${lockOverlay}</div>`;
    }

    ensureDiffLibrary() {
        return loadExternalScriptOnce(
            'https://cdnjs.cloudflare.com/ajax/libs/jsdiff/5.1.0/diff.min.js',
            () => typeof window.Diff !== 'undefined'
        );
    }

    async ensurePdfLibraries() {
        await Promise.all([
            loadExternalScriptOnce(
                'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
                () => typeof window.jspdf !== 'undefined'
            ),
            loadExternalScriptOnce(
                'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
                () => typeof window.html2canvas !== 'undefined'
            )
        ]);
    }

    can(action) {
        if (!this.userRole) return false;

        switch (action) {
            case 'manage_team':
                return this.userRole === '邂｡逅・・;
            case 'operate_contract':
                return this.userRole === '邂｡逅・・ || this.userRole === '菴懈･ｭ閠・;
            case 'view_only':
                return true;
            default:
                return false;
        }
    }

    updateRegistrationButtonVisibility(viewId = this.currentView) {
        const regBtn = document.getElementById('open-registration-btn');
        if (!regBtn) return;
        const canShowOnView = viewId === 'dashboard' || viewId === 'contracts';
        regBtn.style.display = (this.can('operate_contract') && canShowOnView) ? 'inline-flex' : 'none';
    }

    updateActiveMenu(viewId = this.currentView) {
        const groupedViewId = ['sign', 'sign-editor', 'sign-recipient', 'sign-viewer'].includes(viewId)
            ? 'sign'
            : viewId;
        const navItems = document.querySelectorAll('.nav-item');
        navItems.forEach((item) => item.classList.remove('active'));
        navItems.forEach((item) => {
            const onclick = item.getAttribute('onclick') || '';
            if (onclick.includes(`navigate('${groupedViewId}')`)) {
                item.classList.add('active');
            }
        });
    }

    async init() {
        try {
            // --- Local Mock Mode Support ---
            const params = new URLSearchParams(window.location.search);
            const planParam = params.get('plan');
            if (planParam) {
                console.log(`[MockMode] Plan: ${planParam}`);
                window.isMockMode = true;
                this.userPlan = planParam;
                this.user = { uid: 'mock-uid', email: 'mock@example.com', plan: planParam };
                
                // --- DATA MOCKS ---
                if (window.dbService) {
                    window.dbService.setCurrentUser('mock-uid');
                    window.dbService.getStats = () => ({ pending: 5, highRisk: 2, total: 10 });
                    window.dbService.syncContractsFromApi = async () => { console.log('[Mock] Skipping API sync'); return true; };
                }
                
                // Bypassing real network calls
                this.loadContracts = async () => { console.log('[Mock] Skipping real contracts fetch'); return []; };
                this.loadAlerts = async () => { console.log('[Mock] Skipping real alerts fetch'); return []; };
                this.fetchPaymentConfig = async () => { console.log('[Mock] Skipping real payment config fetch'); return {}; };
                
                // --- BOOTSTRAP MOCK ---
                this.bindEvents();
                this.registration.init();
                this.updateSubscriptionUI();
                
                // Navigate to dashboard
                this.navigate('dashboard');
                return;
            }
            console.log('Dashboard App Initializing...');
            const initStartMs = performance.now();
            if ('scrollRestoration' in window.history) {
                window.history.scrollRestoration = 'manual';
            }
            this.renderInitialSkeleton('dashboard');
            const planNav = document.getElementById('nav-plan');
            if (planNav) planNav.style.display = '';

            // Get current user UID first for data isolation.
            // On localhost, avoid blocking dashboard startup on Firebase auth state.
            try {
                const isLocalDev = window.location.protocol === 'file:'
                    || window.location.hostname === 'localhost'
                    || window.location.hostname === '127.0.0.1';
                if (!isLocalDev) {
                    const { auth } = await import('./firebase-config.js');
                    const { onAuthStateChanged } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
                    const user = auth.currentUser;
                    if (user) {
                        dbService.setCurrentUser(user.uid);
                    } else {
                        // Wait for auth state
                        await new Promise((resolve) => {
                            const unsubscribe = onAuthStateChanged(auth, (u) => {
                                unsubscribe();
                                if (u) dbService.setCurrentUser(u.uid);
                                resolve();
                            });
                        });
                    }
                }
            } catch (e) {
                console.warn('Could not get UID for data isolation:', e);
            }

            dbService.init();
            this.bindEvents();
            this.registration.init();

            // UI繧貞・譛滓Φ螳夲ｼ・ro・峨〒譖ｴ譁ｰ
            this.updateSubscriptionUI();

            const urlParams = new URLSearchParams(window.location.search);
            const shouldStartPayment = urlParams.get('start_payment') === '1';
            const paymentPlan = urlParams.get('plan');
            const paymentBilling = urlParams.get('billing');
            const fromTrialExpired = urlParams.get('reason') === 'trial_expired';
            // Critical UI first: route immediately, data bootstrap in background
            const hash = window.location.hash;
            if (hash && hash.startsWith('#diff/')) {
                const contractId = parseInt(hash.replace('#diff/', ''), 10);
                if (!isNaN(contractId)) {
                    this.navigate('diff', contractId);
                } else {
                    this.navigate('dashboard');
                }
            } else if (shouldStartPayment) {
                this.navigate('plan');
            } else {
                this.navigate('dashboard');
            }
            const firstUiMs = Math.round(performance.now() - initStartMs);
            console.log(`[perf] initial UI rendered in ${firstUiMs}ms`);

            const bootstrapPromise = this.checkAndRegisterAdmin()
                .then(async () => {
                    this.bootstrapCompleted = true;
                    await this.reloadPlanData({ silent: true });
                })
                .catch((error) => {
                    console.error('Bootstrap initialization failed:', error);
                });

            // 辟｡譁呎悄髢鍋ｵゆｺ・ｾ後・豎ｺ貂磯幕蟋九ヵ繝ｭ繝ｼ
            if (shouldStartPayment) {
                this.forceSubscriptionPayment = fromTrialExpired;
                await bootstrapPromise;
                await this.startSubscriptionCheckout(
                    paymentPlan || this.subscription?.plan || 'starter',
                    paymentBilling || this.subscription?.billingCycle || 'monthly',
                    fromTrialExpired
                );

                history.replaceState(null, '', window.location.pathname);
                console.log('Redirected to payment flow from select-plan');
                return;
            }

            bootstrapPromise.finally(() => {
                const fullLoadMs = Math.round(performance.now() - initStartMs);
                console.log(`[perf] dashboard bootstrap completed in ${fullLoadMs}ms`);
            });
            console.log('Dashboard App Initialized Successfully');
        } catch (error) {
            console.error('Initialization Error:', error);
            Notify.error('繝繝・す繝･繝懊・繝峨・蛻晄悄蛹紋ｸｭ縺ｫ繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆縲りｩｳ邏ｰ縺ｯ繧ｳ繝ｳ繧ｽ繝ｼ繝ｫ繧堤｢ｺ隱阪＠縺ｦ縺上□縺輔＞縲・);
        }
    }

    async checkAndRegisterAdmin() {
        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken(); // Ensure auth is ready

            const fbConfig = await import('./firebase-config.js');
            const auth = fbConfig.auth;
            const user = auth.currentUser;

            if (user) {
                this.currentUser = user; // Store for later use

                // Fetch role and team info from backend (Firestore-backed, reliable)
                let ownerUid = user.uid; // Default: own data
                this.isTeamMember = false;
                try {
                    const roleRes = await fetch(`${aiService.API_BASE}/user/role`, {
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    if (roleRes.ok) {
                        const roleData = await roleRes.json();
                        if (roleData.success) {
                            this.userRole = roleData.data.role;
                            this.isTeamMember = roleData.data.isTeamMember || false;
                            if (roleData.data.ownerUid) {
                                ownerUid = roleData.data.ownerUid;
                            }
                            console.log('User role from backend:', this.userRole, 'ownerUid:', ownerUid, 'isTeamMember:', this.isTeamMember);
                        }
                    }
                } catch (roleErr) {
                    console.warn('Could not fetch role from backend, defaulting to 邂｡逅・・', roleErr);
                    // API螟ｱ謨玲凾縺ｯ繧ｪ繝ｼ繝翫・・育ｮ｡逅・・ｼ峨→縺励※繝・ヵ繧ｩ繝ｫ繝亥虚菴懶ｼ医ヰ繝・け繧ｨ繝ｳ繝峨→蜷後§繝ｭ繧ｸ繝・け・・
                    this.userRole = '邂｡逅・・;
                    this.isTeamMember = false;
                }

                // If team member, switch data scope to owner's UID
                if (this.isTeamMember && ownerUid !== user.uid) {
                    console.log('Switching data scope to owner UID:', ownerUid);
                    dbService.setCurrentUser(ownerUid);
                }

                // Register user in local localStorage if not present
                const users = dbService.getUsers();
                const matchedUser = users.find(u => u.email === user.email);
                if (!matchedUser) {
                    const displayName = user.displayName || user.email.split('@')[0];
                    dbService.addUser(displayName, user.email, this.userRole);
                } else if (matchedUser.role !== this.userRole) {
                    // Sync local role with backend
                    dbService.updateUserRole(user.email, this.userRole);
                }


                this.setCachedItem(DASHBOARD_CACHE_KEYS.USER_META, {
                    role: this.userRole,
                    isTeamMember: this.isTeamMember,
                    ownerUid,
                    email: user.email,
                    name: user.displayName || user.email.split('@')[0]
                });

                const emailEl = document.getElementById('user-email-display');
                if (emailEl) emailEl.textContent = user.email || '';
                const nameEl = document.getElementById('user-name-display');
                if (nameEl) nameEl.textContent = user.displayName || user.email?.split('@')[0] || '繝ｦ繝ｼ繧ｶ繝ｼ';

                // Fetch real subscription status from backend (parallel)
                await Promise.all([
                    this.fetchSubscriptionStatus(token),
                    this.fetchPaymentStatus(token),
                    this.fetchPaymentConfig()
                ]);

                // Check if user just selected a plan from signup flow
                const selectedPlan = localStorage.getItem('diffsense_selected_plan');
                const selectedBillingCycle = localStorage.getItem('diffsense_selected_billing_cycle') || 'monthly';
                const signupFlowFlag = localStorage.getItem('diffsense_signup_flow') === '1';

                if (selectedPlan && signupFlowFlag) {
                    // Guard: Don't overwrite paid plan with free/starter if user already has a paid plan
                    const currentPlan = (this.subscription?.plan || 'free').toLowerCase();
                    const isDowngradeToFree = (selectedPlan === 'free' && currentPlan !== 'free' && currentPlan !== 'starter');
                    
                    if (isDowngradeToFree) {
                        console.log('Signup flow detected for existing paid user - skipping plan overwrite');
                    } else {
                        await this.registerSelectedPlan(token, selectedPlan, selectedBillingCycle);
                    }
                    
                    localStorage.removeItem('diffsense_selected_plan');
                    localStorage.removeItem('diffsense_selected_billing_cycle');
                    localStorage.removeItem('diffsense_signup_flow');
                }

                const urlParams = new URLSearchParams(window.location.search);
                const paymentState = urlParams.get('payment');

                // PayPal驕ｷ遘ｻ謌ｻ繧翫・遒ｺ螳壼・逅・
                if (paymentState === 'success') {
                    const returnedPlan = urlParams.get('plan') || this.subscription?.plan || 'starter';
                    const returnedBillingCycle = urlParams.get('billing') || this.subscription?.billingCycle || 'monthly';
                    const returnedSubscriptionId =
                        urlParams.get('subscription_id') ||
                        urlParams.get('ba_token') ||
                        urlParams.get('token');

                    if (returnedSubscriptionId) {
                        const confirmed = await this.confirmPayPalSubscription(
                            returnedSubscriptionId,
                            returnedPlan,
                            returnedBillingCycle,
                            { redirectOnSuccess: true }
                        );
                        if (confirmed) return;
                    } else if (this.paymentStatus?.hasPaymentMethod) {
                        window.location.replace(`${window.location.origin}/thanks-payment.html?plan=${returnedPlan}&billing=${returnedBillingCycle}`);
                        return;
                    }
                }

                if (paymentState === 'stripe_success') {
                    const returnedPlan = urlParams.get('plan') || this.subscription?.plan || 'starter';
                    const returnedBillingCycle = urlParams.get('billing') || this.subscription?.billingCycle || 'monthly';
                    const sessionId = urlParams.get('session_id');
                    if (sessionId) {
                        const confirmed = await this.confirmStripeSession(sessionId, returnedPlan, returnedBillingCycle, { redirectOnSuccess: true });
                        if (confirmed) return;
                    }
                }

                this.checkTrialExpired();

                // Clean payment URL params
                if (paymentState) {
                    history.replaceState(null, '', window.location.pathname);
                }

                console.log('Current User Role:', this.userRole);

                // Show Plan menu for all users, Team menu only for admins
                const planNav = document.getElementById('nav-plan');
                if (planNav) planNav.style.display = '';

                if (this.can('manage_team')) {
                    const teamNav = document.getElementById('nav-team');
                    if (teamNav) teamNav.style.display = '';
                }

                this.updateRegistrationButtonVisibility(this.currentView);

                // Show role badge in header for team members
                if (this.isTeamMember) {
                    const roleBadge = document.getElementById('user-role-badge');
                    if (roleBadge) {
                        const roleColors = {
                            '邂｡逅・・: '#4CAF50',
                            '菴懈･ｭ閠・: '#2196F3',
                            '髢ｲ隕ｧ縺ｮ縺ｿ': '#FF9800'
                        };
                        roleBadge.textContent = this.userRole;
                        roleBadge.style.cssText = `display:inline-block; background:${roleColors[this.userRole] || '#999'}; color:#fff; padding:2px 10px; border-radius:12px; font-size:11px; font-weight:600; margin-left:8px;`;
                    }
                }
            }
        } catch (e) {
            console.error('Admin Check Error:', e);
        }
    }

    async registerSelectedPlan(token, plan, billingCycle = 'monthly') {
        const selectedBillingCycle = billingCycle === 'annual' ? 'annual' : 'monthly';
        try {
            const apiUrl = `${aiService.API_BASE}/user/select-plan`;

            await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ plan, billingCycle: selectedBillingCycle })
            });
            console.log('Selected plan registered:', plan, selectedBillingCycle);
        } catch (error) {
            console.error('Failed to register selected plan:', error);
        }
    }

    async reloadPlanData(options = {}) {
        const silent = options.silent === true;
        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
            
            if (!token && !isLocalDev) {
                if (!silent) Notify.warning('繝ｭ繧ｰ繧､繝ｳ迥ｶ諷九ｒ遒ｺ隱阪〒縺阪∪縺帙ｓ縺ｧ縺励◆縲・);
                return false;
            }

            await Promise.all([
                this.fetchSubscriptionStatus(token),
                this.fetchPaymentStatus(token),
                this.fetchPaymentConfig()
            ]);

            if (this.currentView === 'plan') {
                this.navigate('plan');
            }
            return true;
        } catch (error) {
            console.error('reloadPlanData error:', error);
            if (!silent) Notify.error('蛻ｩ逕ｨ迥ｶ豕√・蜀榊叙蠕励↓螟ｱ謨励＠縺ｾ縺励◆縲・);
            return false;
        }
    }

    async refreshSubscriptionStatusSafe() {
        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            if (token) {
                await this.fetchSubscriptionStatus(token);
            }
        } catch (error) {
            console.warn('Failed to refresh subscription:', error);
        }
    }

    async fetchSubscriptionStatus(token) {
        try {
            const apiUrl = `${aiService.API_BASE}/user/subscription`;

            const response = await fetch(apiUrl, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            const result = await response.json();

            if (result.success) {
                this.subscription = {
                    ...result.data,
                    billingCycle: result.data?.billingCycle === 'annual' ? 'annual' : 'monthly'
                };
                this.userPlan = result.data.plan;
                this.setCachedItem(DASHBOARD_CACHE_KEYS.SUBSCRIPTION, this.subscription);
                if (!this.planViewBillingCycle) {
                    this.planViewBillingCycle = this.subscription.billingCycle;
                }
                this.updateSubscriptionUI();
            }
        } catch (error) {
            console.error('Failed to fetch subscription status:', error);
            // API謗･邯壼､ｱ謨玲凾・嗔ro繧偵ョ繝輔か繝ｫ繝医↓縺吶ｋ
            this.subscription = { plan: 'pro', billingCycle: 'monthly', usageCount: 0, usageLimit: 999999, daysRemaining: null, planLimit: 999999 };
            this.userPlan = 'pro';
            this.setCachedItem(DASHBOARD_CACHE_KEYS.SUBSCRIPTION, this.subscription);
            if (!this.planViewBillingCycle) {
                this.planViewBillingCycle = 'monthly';
            }
            this.updateSubscriptionUI();
        }
    }

    async fetchPaymentStatus(token) {
        try {
            const apiUrl = `${aiService.API_BASE}/payment/status`;

            const response = await fetch(apiUrl, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const result = await response.json();

            if (result.success) {
                this.paymentStatus = result.data;
                this.setCachedItem(DASHBOARD_CACHE_KEYS.USER_META, {
                    ...(this.getCachedItem(DASHBOARD_CACHE_KEYS.USER_META, 30 * 60 * 1000) || {}),
                    hasPaymentMethod: Boolean(result.data?.hasPaymentMethod)
                });
            }
        } catch (error) {
            console.error('Failed to fetch payment status:', error);
            this.paymentStatus = { hasPaymentMethod: false };
        }
    }

    async fetchPaymentConfig(forceRefresh = false) {
        if (this.paymentConfig && !forceRefresh) {
            return this.paymentConfig;
        }

        const previousConfig = this.paymentConfig;

        try {
            const response = await fetch(`${aiService.API_BASE}/payment/config`);
            const result = await response.json();

            if (result.success && result.data) {
                const config = result.data;
                const planIds = config.planIds || {};
                const monthlyPlanIds = planIds.monthly || {};
                const annualPlanIds = planIds.annual || {};
                const stripeConfig = config.stripe || {};
                const planKeys = ['starter', 'business', 'pro'];
                const stripeEnabled = Boolean(stripeConfig.enabled);

                const monthlyAvailability = {};
                const annualAvailability = {};

                planKeys.forEach((key) => {
                    monthlyAvailability[key] = stripeEnabled
                        ? true
                        : Boolean(monthlyPlanIds[key] || planIds[key]);
                    annualAvailability[key] = stripeEnabled
                        ? true
                        : Boolean(annualPlanIds[key]);
                });

                this.paymentConfig = config;
                this.paymentPlanAvailability = {
                    monthly: monthlyAvailability,
                    annual: annualAvailability
                };
                // Annual is available only when at least one annual plan ID is configured.
                this.hasAnnualBillingPlans = Object.values(annualAvailability).some(Boolean);
                this.stripeEnabled = stripeEnabled;
                this.stripePublishableKey = stripeConfig.publishableKey || '';

                return this.paymentConfig;
            }
        } catch (error) {
            console.error('Failed to fetch payment config:', error);
        }

        if (!previousConfig) {
            this.paymentConfig = null;
            this.paymentPlanAvailability = null;
            this.hasAnnualBillingPlans = null;
            this.stripeEnabled = false;
            this.stripePublishableKey = '';
        }

        return previousConfig || null;
    }

    setPlanBillingCycle(billingCycle = 'monthly') {
        const selectedBillingCycle = billingCycle === 'annual' ? 'annual' : 'monthly';
        if (selectedBillingCycle === 'annual' && this.hasAnnualBillingPlans === false && this.subscription?.billingCycle !== 'annual') {
            Notify.info('蟷ｴ鬘阪・繝ｩ繝ｳ縺ｯ迴ｾ蝨ｨ貅門ｙ荳ｭ縺ｧ縺吶・);
            return;
        }

        this.planViewBillingCycle = selectedBillingCycle;
        if (this.currentView === 'plan') {
            this.navigate('plan');
        }
    }

    async startSubscriptionCheckout(plan, billingCycle = this.subscription?.billingCycle || 'monthly', forcePayment = this.forceSubscriptionPayment) {
        if (!this.stripeEnabled) {
            Notify.error('Stripe豎ｺ貂医・險ｭ螳壹′譛ｪ螳御ｺ・〒縺吶ら腸蠅・､画焚繧偵＃遒ｺ隱阪￥縺�縺輔＞縲・);
            // 蛻・ｊ謌ｻ縺礼畑・域ｮ狗ｽｮ・・
            // await this.startPayPalSubscription(plan, billingCycle, forcePayment);
            return;
        }
        await this.startStripeCheckout(plan, billingCycle, forcePayment);
    }

    showStripeCheckoutModal(plan, billingCycle = this.subscription?.billingCycle || 'monthly', forcePayment = this.forceSubscriptionPayment) {
        const targetPlan = plan || this.subscription?.plan || 'starter';
        const cycle = billingCycle === 'annual' ? 'annual' : 'monthly';
        const existing = document.getElementById('stripe-modal-overlay');
        if (existing) existing.remove();

        const planNames = { starter: 'Starter', business: 'Business', pro: 'Pro' };
        const billingLabel = cycle === 'annual' ? '蟷ｴ鬘搾ｼ井ｸ諡ｬ・・ : '譛磯｡・;
        const planPrices = {
            monthly: { starter: 'ﾂ･1,480 / 譛茨ｼ育ｨ手ｾｼ・・, business: 'ﾂ･4,980 / 譛茨ｼ育ｨ手ｾｼ・・, pro: 'ﾂ･9,800 / 譛茨ｼ育ｨ手ｾｼ・・ },
            annual: { starter: 'ﾂ･14,800 / 蟷ｴ・育ｨ手ｾｼ・・, business: 'ﾂ･49,800 / 蟷ｴ・育ｨ手ｾｼ・・, pro: 'ﾂ･98,000 / 蟷ｴ・育ｨ手ｾｼ・・ }
        };

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay active';
        overlay.id = 'stripe-modal-overlay';
        overlay.innerHTML = `
        <div class="modal-content" style="max-width:480px;">
            <div class="modal-header">
                <h3 style="margin:0; font-size:1.1rem;">
                    <i class="fa-solid fa-credit-card" style="margin-right:8px; color:#B8860B;"></i>縺頑髪謇輔＞譁ｹ豕輔ｒ逋ｻ骭ｲ
                </h3>
                ${forcePayment ? '' : '<button class="btn-close" onclick="document.getElementById(\'stripe-modal-overlay\').remove()">&times;</button>'}
            </div>
            <div class="modal-body" style="padding:24px;">
                <div style="background:#faf8f5; border:1px solid #e8e0d4; border-radius:8px; padding:16px; margin-bottom:16px; text-align:center;">
                    <div style="font-size:0.8rem; color:#888; margin-bottom:4px;">驕ｸ謚槭・繝ｩ繝ｳ</div>
                    <div style="font-size:1.1rem; font-weight:700; color:#24292E;">${planNames[targetPlan] || targetPlan}</div>
                    <div style="font-size:0.8rem; color:#8a6f40; margin-top:4px;">隲区ｱゅし繧､繧ｯ繝ｫ: ${billingLabel}</div>
                    <div style="font-size:1.3rem; font-weight:700; color:#B8860B; margin-top:4px;">${planPrices[cycle]?.[targetPlan] || ''}</div>
                </div>
                <button class="btn-dashboard full-width" style="background:#B8860B; color:#fff; border:none; font-weight:700;" onclick="window.app.startStripeCheckout('${targetPlan}', '${cycle}', ${forcePayment ? 'true' : 'false'})">
                    縺頑髪謇輔＞繧堤匳骭ｲ縺吶ｋ
                </button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
    }

    async startStripeCheckout(plan, billingCycle = this.subscription?.billingCycle || 'monthly', forcePayment = this.forceSubscriptionPayment) {
        const targetPlan = plan || this.subscription?.plan || 'starter';
        const selectedBillingCycle = billingCycle === 'annual' ? 'annual' : 'monthly';
        this.planViewBillingCycle = selectedBillingCycle;
        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
            if (!token && !isLocalDev) {
                Notify.error('繝ｭ繧ｰ繧､繝ｳ迥ｶ諷九ｒ遒ｺ隱阪〒縺阪∪縺帙ｓ縺ｧ縺励◆縲ょ・繝ｭ繧ｰ繧､繝ｳ縺励※縺上□縺輔＞縲・);
                return;
            }
            const headers = {
                'Content-Type': 'application/json'
            };
            if (token) {
                headers.Authorization = `Bearer ${token}`;
            }
            const stripeModal = document.getElementById('stripe-modal-overlay');
            if (stripeModal) stripeModal.remove();

            const response = await fetch(`${aiService.API_BASE}/api/createCheckoutSession`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    plan: targetPlan,
                    billingCycle: selectedBillingCycle,
                    email: this.currentUser?.email || '',
                    userId: this.currentUser?.uid || ''
                })
            });
            const result = await response.json();
            if (!result.success || !result.data?.url) {
                Notify.error(result.error || 'Stripe豎ｺ貂医・繝ｼ繧ｸ縺ｮ菴懈・縺ｫ螟ｱ謨励＠縺ｾ縺励◆縲・);
                if (forcePayment) {
                    window.location.replace(`${window.location.origin}/select-plan-preview.html&billing=${selectedBillingCycle}`);
                }
                return;
            }
            sessionStorage.setItem('stripe_checkout_started', 'true');
            window.location.href = result.data.url;
        } catch (error) {
            console.error('Stripe checkout error:', error);
            Notify.error('Stripe豎ｺ貂医・髢句ｧ九↓螟ｱ謨励＠縺ｾ縺励◆縲・);
            if (forcePayment) {
                window.location.replace(`${window.location.origin}/select-plan-preview.html&billing=${selectedBillingCycle}`);
            }
        }
    }

    async confirmStripeSession(sessionId, plan, billingCycle = 'monthly', options = {}) {
        const redirectOnSuccess = options.redirectOnSuccess !== false;
        const selectedBillingCycle = billingCycle === 'annual' ? 'annual' : 'monthly';
        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
            if (!token && !isLocalDev) {
                Notify.error('繝ｭ繧ｰ繧､繝ｳ迥ｶ諷九ｒ遒ｺ隱阪〒縺阪∪縺帙ｓ縺ｧ縺励◆縲ょ・繝ｭ繧ｰ繧､繝ｳ縺励※縺上□縺輔＞縲・);
                return false;
            }
            const headers = {
                'Content-Type': 'application/json'
            };
            if (token) {
                headers.Authorization = `Bearer ${token}`;
            }
            const response = await fetch(`${aiService.API_BASE}/payment/confirm-stripe-session`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ sessionId, plan, billingCycle: selectedBillingCycle })
            });
            const result = await response.json();
            if (result.success) {
                this.forceSubscriptionPayment = false;

                await this.fetchSubscriptionStatus(token);
                await this.fetchPaymentStatus(token);
                if (redirectOnSuccess) {
                    const confirmedPlan = result.data.plan || plan || this.subscription?.plan || 'starter';
                    const confirmedBillingCycle = result.data.billingCycle || selectedBillingCycle;
                    window.location.replace(`${window.location.origin}/thanks-payment.html?plan=${confirmedPlan}&billing=${confirmedBillingCycle}`);
                }
                return true;
            }
            Notify.error(result.error || 'Stripe豎ｺ貂医・遒ｺ螳壹↓螟ｱ謨励＠縺ｾ縺励◆縲・);
        } catch (error) {
            console.error('Confirm Stripe session error:', error);
            Notify.error('Stripe豎ｺ貂医・遒ｺ螳壼・逅・〒繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆縲・);
        }
        return false;
    }

    async startPayPalSubscription(plan, billingCycle = this.subscription?.billingCycle || 'monthly', forcePayment = this.forceSubscriptionPayment) {
        const targetPlan = plan || this.subscription?.plan || 'starter';
        const selectedBillingCycle = billingCycle === 'annual' ? 'annual' : 'monthly';
        this.planViewBillingCycle = selectedBillingCycle;
        try {
            const config = await this.fetchPaymentConfig(true);
            if (!config) {
                Notify.error('PayPal險ｭ螳壹・蜿門ｾ励↓螟ｱ謨励＠縺ｾ縺励◆縲・);
                if (forcePayment) {
                    window.location.replace(`${window.location.origin}/select-plan-preview.html`);
                }
                return;
            }
            const { clientId, planIds } = config;
            const paypalPlanId = planIds?.[selectedBillingCycle]?.[targetPlan] || planIds?.[targetPlan];
            if (!paypalPlanId) {
                Notify.error(selectedBillingCycle === 'annual' ? '蟷ｴ鬘阪・繝ｩ繝ｳ縺ｯ迴ｾ蝨ｨ貅門ｙ荳ｭ縺ｧ縺吶・ : '繝励Λ繝ｳID縺瑚ｦ九▽縺九ｊ縺ｾ縺帙ｓ縲・);
                if (forcePayment) {
                    window.location.replace(`${window.location.origin}/select-plan-preview.html&billing=${selectedBillingCycle}`);
                }
                return;
            }

            // If user has existing active subscription and is changing plan/cycle, cancel old one first
            const currentCycle = this.subscription?.billingCycle || 'monthly';
            if (this.paymentStatus?.hasPaymentMethod && (this.subscription?.plan !== targetPlan || currentCycle !== selectedBillingCycle)) {
                const authModule = await import('./auth.js');
                const token = await authModule.getIdToken();
                try {
                    await fetch(`${aiService.API_BASE}/payment/cancel-subscription`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
                    });
                } catch (e) {
                    console.warn('Failed to cancel old subscription:', e);
                }
            }

            // Show modal with PayPal button container
            this.showPayPalModal(targetPlan, selectedBillingCycle, forcePayment);

            // Load PayPal JS SDK dynamically
            await this.loadPayPalSDK(clientId);

            // Render PayPal Buttons inside the modal
            const container = document.getElementById('paypal-button-container');
            if (!container) return;
            // Clear loading spinner
            container.innerHTML = '';
            container.style = '';

            paypal.Buttons({
                style: {
                    shape: 'rect',
                    color: 'gold',
                    layout: 'vertical',
                    label: 'pay'
                },
                createSubscription: (data, actions) => {
                    return actions.subscription.create({
                        plan_id: paypalPlanId
                    });
                },
                onApprove: async (data) => {
                    console.log('Subscription approved:', data.subscriptionID);
                    // Close the PayPal modal
                    const modal = document.getElementById('paypal-modal-overlay');
                    if (modal) modal.remove();
                    this.forceSubscriptionPayment = false;
    

                    // Confirm with backend
                    await this.confirmPayPalSubscription(data.subscriptionID, targetPlan, selectedBillingCycle);
                },
                onCancel: () => {
                    console.log('User cancelled PayPal subscription');
                    if (forcePayment) {
                        Notify.warning('邯咏ｶ壼茜逕ｨ縺ｫ縺ｯ縺頑髪謇輔＞譁ｹ豕輔・逋ｻ骭ｲ縺悟ｿ・ｦ√〒縺吶・);
                        return;
                    }
                    const modal = document.getElementById('paypal-modal-overlay');
                    if (modal) modal.remove();
                    Notify.info('縺頑髪謇輔＞縺後く繝｣繝ｳ繧ｻ繝ｫ縺輔ｌ縺ｾ縺励◆縲・);
                },
                onError: (err) => {
                    console.error('PayPal Buttons error:', err);
                    if (forcePayment) {
                        Notify.error('縺頑髪謇輔＞蜃ｦ逅・〒繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆縲ょ・蠎ｦ縺願ｩｦ縺励￥縺�縺輔＞縲・);
                        return;
                    }
                    const modal = document.getElementById('paypal-modal-overlay');
                    if (modal) modal.remove();
                    Notify.error('縺頑髪謇輔＞蜃ｦ逅・〒繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆縲・);
                }
            }).render('#paypal-button-container');

        } catch (error) {
            console.error('PayPal subscription error:', error);
            Notify.error('縺頑髪謇輔＞蜃ｦ逅・〒繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆縲・);
            if (forcePayment) {
                window.location.replace(`${window.location.origin}/select-plan-preview.html&billing=${selectedBillingCycle}`);
            }
        }
    }

    showPayPalModal(plan, billingCycle = 'monthly', forcePayment = this.forceSubscriptionPayment) {
        // Remove existing modal if any
        const existing = document.getElementById('paypal-modal-overlay');
        if (existing) existing.remove();

        const planNames = { starter: 'Starter', business: 'Business', pro: 'Pro' };
        const cycle = billingCycle === 'annual' ? 'annual' : 'monthly';
        const billingLabel = cycle === 'annual' ? '蟷ｴ鬘搾ｼ井ｸ諡ｬ・・ : '譛磯｡・;
        const planPrices = {
            monthly: { starter: 'ﾂ･1,480 / 譛茨ｼ育ｨ手ｾｼ・・, business: 'ﾂ･4,980 / 譛茨ｼ育ｨ手ｾｼ・・, pro: 'ﾂ･9,800 / 譛茨ｼ育ｨ手ｾｼ・・ },
            annual: { starter: 'ﾂ･14,800 / 蟷ｴ・育ｨ手ｾｼ・・, business: 'ﾂ･49,800 / 蟷ｴ・育ｨ手ｾｼ・・, pro: 'ﾂ･98,000 / 蟷ｴ・育ｨ手ｾｼ・・ }
        };

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay active';
        overlay.id = 'paypal-modal-overlay';
        overlay.innerHTML = `
        <div class="modal-content" style="max-width:480px;">
            <div class="modal-header">
                <h3 style="margin:0; font-size:1.1rem;">
                    <i class="fa-solid fa-credit-card" style="margin-right:8px; color:#c19b4a;"></i>縺頑髪謇輔＞譁ｹ豕輔ｒ逋ｻ骭ｲ
                </h3>
                ${forcePayment ? '' : '<button class="btn-close" onclick="document.getElementById(\'paypal-modal-overlay\').remove()">&times;</button>'}
            </div>
            <div class="modal-body" style="padding:24px;">
                <div style="background:#faf8f5; border:1px solid #e8e0d4; border-radius:8px; padding:16px; margin-bottom:20px; text-align:center;">
                    <div style="font-size:0.8rem; color:#888; margin-bottom:4px;">驕ｸ謚槭・繝ｩ繝ｳ</div>
                    <div style="font-size:1.1rem; font-weight:700; color:#24292E;">${planNames[plan] || plan}</div>
                    <div style="font-size:0.8rem; color:#8a6f40; margin-top:4px;">隲区ｱゅし繧､繧ｯ繝ｫ: ${billingLabel}</div>
                    <div style="font-size:1.3rem; font-weight:700; color:#c19b4a; margin-top:4px;">${planPrices[cycle]?.[plan] || ''}</div>
                </div>
                <p style="font-size:0.82rem; color:#666; margin-bottom:16px; text-align:center;">
                    繧ｯ繝ｬ繧ｸ繝・ヨ繧ｫ繝ｼ繝・繝・ン繝・ヨ繧ｫ繝ｼ繝峨〒豎ｺ貂医〒縺阪∪縺吶・
                </p>
                <div id="paypal-button-container" style="min-height:150px; display:flex; align-items:center; justify-content:center;">
                    <div style="color:#999; font-size:0.85rem;"><i class="fa-solid fa-spinner fa-spin" style="margin-right:8px;"></i>豎ｺ貂医・繧ｿ繝ｳ繧定ｪｭ縺ｿ霎ｼ縺ｿ荳ｭ...</div>
                </div>
                ${forcePayment ? `
                        <div style="margin-top:12px;">
                            <button onclick="window.location.replace('${window.location.origin}/index.html')" class="btn-dashboard full-width" style="background:#fff; color:#333; border:1px solid #ddd;">
                                TOP縺ｸ謌ｻ繧・
                            </button>
                        </div>
                    ` : ''}
            </div>
        </div>
        `;
        document.body.appendChild(overlay);
    }

    loadPayPalSDK(clientId) {
        return new Promise((resolve, reject) => {
            // If already loaded, resolve immediately
            if (window.paypal) {
                resolve();
                return;
            }
            // Remove any existing PayPal script
            const existingScript = document.getElementById('paypal-sdk-script');
            if (existingScript) existingScript.remove();

            const script = document.createElement('script');
            script.id = 'paypal-sdk-script';
            script.src = `https://www.paypal.com/sdk/js?client-id=${clientId}&vault=true&intent=subscription&locale=ja_JP`;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('PayPal SDK縺ｮ隱ｭ縺ｿ霎ｼ縺ｿ縺ｫ螟ｱ謨励＠縺ｾ縺励◆'));
            document.head.appendChild(script);
        });
    }

    async confirmPayPalSubscription(subscriptionId, plan, billingCycle = 'monthly', options = {}) {
        const redirectOnSuccess = options.redirectOnSuccess !== false;
        const selectedBillingCycle = billingCycle === 'annual' ? 'annual' : 'monthly';
        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            const apiUrl = `${aiService.API_BASE}/payment/confirm-subscription`;

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ subscriptionId, plan, billingCycle: selectedBillingCycle })
            });
            const result = await response.json();

            if (result.success) {
                const confirmedPlan = result.data.plan || plan || this.subscription?.plan || 'starter';
                const confirmedBillingCycle = result.data.billingCycle || selectedBillingCycle;
                // Redirect to thanks page for GA conversion tracking
                if (redirectOnSuccess) {
                    window.location.replace(`${window.location.origin}/thanks-payment.html?plan=${confirmedPlan}&billing=${confirmedBillingCycle}`);
                }
                return true;
            }
            return false;
        } catch (error) {
            console.error('Confirm subscription error:', error);
            return false;
        }
    }

    checkTrialExpired() {
        const sub = this.subscription;
        if (!sub) return;
        const urlParams = new URLSearchParams(window.location.search);
        const skipGateForPaymentFlow = urlParams.get('start_payment') === '1';
        if (skipGateForPaymentFlow) return;

        if (this.requiresPaymentRegistration()) {
            this.redirectToPlanSelection('payment_required');
        }
    }

    requiresPaymentRegistration() {
        return false;
    }

    isSignLimitReached() {
        const sub = this.subscription;
        if (!sub) return false;
        // Pro繝励Λ繝ｳ縺ｪ繧臥┌蛻ｶ髯・
        if (sub.plan === 'pro') return false;
        
        const count = Number(sub.signUsageCount || 0);
        const limit = Number(sub.signUsageLimit || 1); // 繝・ヵ繧ｩ繝ｫ繝・蝗・
        return count >= limit;
    }

    redirectToPlanSelection(reason = 'upgrade') {
        const billing = this.subscription?.billingCycle === 'annual' ? 'annual' : 'monthly';
        window.location.replace(`${window.location.origin}/select-plan-preview.html?billing=${billing}`);
    }

    ensurePaymentAccess(featureLabel = '讖溯・') {
        if (!this.requiresPaymentRegistration()) {
            return true;
        }
        Notify.warning(`${featureLabel}繧貞茜逕ｨ縺吶ｋ縺ｫ縺ｯ縲√♀謾ｯ謇輔＞譁ｹ豕輔・逋ｻ骭ｲ縺悟ｿ・ｦ√〒縺吶ゅ・繝ｩ繝ｳ驕ｸ謚樒判髱｢縺ｸ遘ｻ蜍輔＠縺ｾ縺吶Ａ);
        this.redirectToPlanSelection('upgrade');
        return false;
    }

    renderNotificationSettings(settings, apiBase = '', plan = 'pro') {
        const emailEnabled = settings?.email?.crawlAlert !== false;
        const slack = settings?.slack || {};
        const slackEnabled = slack.enabled === true;
        const slackConnected = Boolean(slack.webhookUrl);
        const channelName = slack.channelName || '';
        const teamName = slack.teamName || '';
        const deadlineEmailEnabled = settings?.email?.deadlineAlert !== false;
        const deadlineSlackEnabled = settings?.slack?.deadlineAlert !== false && slackConnected;
        const crawlerLocked = plan !== 'pro';
        const deadlineLocked = plan === 'free';
        const lockOverlayCrawler = '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(245,247,250,0.82);backdrop-filter:blur(2px);border-radius:8px;z-index:1"><div style="background:#fff;border-radius:10px;padding:24px 32px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.1);max-width:280px"><i class=\'fa-solid fa-crown\' style=\'color:#c19b4a;font-size:1.8rem;margin-bottom:10px;display:block\'></i><div style=\'font-weight:700;font-size:15px;margin-bottom:8px\'>Pro繝励Λ繝ｳ髯仙ｮ・/div><p style=\'font-size:12px;color:#888;line-height:1.6;margin-bottom:16px\'>繧ｯ繝ｭ繝ｼ繝ｩ繝ｼ騾夂衍縺ｯPro繝励Λ繝ｳ縺ｮ讖溯・縺ｧ縺・/p><button class=\'btn-dashboard btn-primary-action\' style=\'width:100%;padding:10px;font-size:13px\' onclick=\'window.app.navigate("plan")\'>繧｢繝・・繧ｰ繝ｬ繝ｼ繝峨☆繧・/button></div></div>';
        const lockOverlayDeadline = '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(245,247,250,0.82);backdrop-filter:blur(2px);border-radius:8px;z-index:1"><div style="background:#fff;border-radius:10px;padding:24px 32px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.1);max-width:280px"><i class=\'fa-solid fa-crown\' style=\'color:#c19b4a;font-size:1.8rem;margin-bottom:10px;display:block\'></i><div style=\'font-weight:700;font-size:15px;margin-bottom:8px\'>Business / Pro繝励Λ繝ｳ髯仙ｮ・/div><p style=\'font-size:12px;color:#888;line-height:1.6;margin-bottom:16px\'>譛滄剞繧｢繝ｩ繝ｼ繝磯夂衍縺ｯBusiness繝励Λ繝ｳ莉･荳翫・讖溯・縺ｧ縺・/p><button class=\'btn-dashboard btn-primary-action\' style=\'width:100%;padding:10px;font-size:13px\' onclick=\'window.app.navigate("plan")\'>繧｢繝・・繧ｰ繝ｬ繝ｼ繝峨☆繧・/button></div></div>';

        const slackStatus = slackConnected
            ? `<div style="display:flex;align-items:center;gap:8px;margin-top:12px;padding:10px 14px;background:#f0faf4;border:1px solid #b7dfc7;border-radius:6px">
                <i class="fa-brands fa-slack" style="color:#4a154b;font-size:16px"></i>
                <i class="fa-solid fa-circle-check" style="color:#28a745;font-size:13px"></i>
                <span style="font-size:13px;color:#1a6b35;font-weight:500">${channelName}</span>
                <span style="font-size:12px;color:var(--text-muted)">${teamName ? `・・{teamName}・荏 : ''}</span>
                <button onclick="window.app.disconnectSlack()"
                    style="margin-left:auto;font-size:12px;color:var(--text-muted);background:none;border:none;cursor:pointer;padding:2px 8px;border-radius:4px;transition:background .15s"
                    onmouseover="this.style.background='#fee'" onmouseout="this.style.background='none'">
                    騾｣謳ｺ隗｣髯､
                </button>
               </div>`
            : '';

        return `
            <div class="plan-section">
                <div style="position:relative">
                <div style="margin-bottom:28px">
                    <h2 class="section-title" style="margin-bottom:6px">繧ｯ繝ｭ繝ｼ繝ｩ繝ｼ騾夂衍險ｭ螳・/h2>
                    <p style="color:var(--text-muted);font-size:13px;margin:0">URL繧ｯ繝ｭ繝ｼ繝ｪ繝ｳ繧ｰ縺ｧ螟画峩縺梧､懃衍縺輔ｌ縺滄圀縺ｮ騾夂衍蜈医ｒ險ｭ螳壹＠縺ｾ縺・/p>
                </div>

                <div style="display:flex;flex-direction:column;gap:12px;max-width:640px">

                    <!-- 繝｡繝ｼ繝ｫ騾夂衍 -->
                    <div style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:8px;padding:20px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px">
                        <div style="display:flex;align-items:center;gap:14px">
                            <div style="width:36px;height:36px;border-radius:8px;background:var(--color-primary-dim);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                                <i class="fa-solid fa-envelope" style="color:var(--color-primary);font-size:15px"></i>
                            </div>
                            <div>
                                <div style="font-weight:600;font-size:14px;color:var(--text-main);margin-bottom:2px">繝｡繝ｼ繝ｫ騾夂衍</div>
                                <div style="font-size:12px;color:var(--text-muted)">螟画峩讀懃衍譎ゅ↓逋ｻ骭ｲ繝｡繝ｼ繝ｫ繧｢繝峨Ξ繧ｹ縺ｸ騾夂衍</div>
                            </div>
                        </div>
                        <label class="toggle-switch" style="flex-shrink:0">
                            <input type="checkbox" id="notif-email-toggle" ${emailEnabled ? 'checked' : ''}
                                onchange="window.app.saveNotificationSettings()">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>

                    <!-- Slack騾夂衍 -->
                    <div style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:8px;padding:20px 24px">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:16px">
                            <div style="display:flex;align-items:center;gap:14px">
                                <div style="width:36px;height:36px;border-radius:8px;background:var(--color-primary-dim);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                                    <i class="fa-brands fa-slack" style="color:var(--color-primary);font-size:16px"></i>
                                </div>
                                <div>
                                    <div style="font-weight:600;font-size:14px;color:var(--text-main);margin-bottom:2px">Slack騾夂衍</div>
                                    <div style="font-size:12px;color:var(--text-muted)">螟画峩讀懃衍譎ゅ↓謖・ｮ壹メ繝｣繝ｳ繝阪Ν縺ｸ騾夂衍</div>
                                </div>
                            </div>
                            ${slackConnected
                                ? `<label class="toggle-switch" style="flex-shrink:0">
                                    <input type="checkbox" id="notif-slack-toggle" ${slackEnabled ? 'checked' : ''}
                                        onchange="window.app.saveNotificationSettings()">
                                    <span class="toggle-slider"></span>
                                </label>`
                                : `<button onclick="window.app.connectSlack()"
                                    style="display:inline-flex;align-items:center;gap:7px;padding:8px 16px;background:#4a154b;color:#fff;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:600;flex-shrink:0;transition:opacity .2s"
                                    onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'">
                                    <i class="fa-brands fa-slack"></i>騾｣謳ｺ縺吶ｋ
                                </button>`}
                        </div>
                        ${slackStatus}
                    </div>

                </div>
                ${crawlerLocked ? lockOverlayCrawler : ''}
                </div>

                <!-- 譛滄剞繧｢繝ｩ繝ｼ繝磯夂衍 -->
                <div style="position:relative;margin-top:36px">
                <div style="margin-bottom:12px">
                    <h2 class="section-title" style="margin-bottom:6px">譛滄剞繧｢繝ｩ繝ｼ繝磯夂衍</h2>
                    <p style="color:var(--text-muted);font-size:13px;margin:0">螂醍ｴ・・譛滄剞・・0譌･蜑阪・7譌･蜑阪・蠖捺律・峨↓騾夂衍縺励∪縺・/p>
                </div>

                <div style="display:flex;flex-direction:column;gap:12px;max-width:640px">

                    <!-- 譛滄剞繧｢繝ｩ繝ｼ繝・ 繝｡繝ｼ繝ｫ -->
                    <div style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:8px;padding:20px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px">
                        <div style="display:flex;align-items:center;gap:14px">
                            <div style="width:36px;height:36px;border-radius:8px;background:var(--color-primary-dim);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                                <i class="fa-solid fa-envelope" style="color:var(--color-primary);font-size:15px"></i>
                            </div>
                            <div>
                                <div style="font-weight:600;font-size:14px;color:var(--text-main);margin-bottom:2px">繝｡繝ｼ繝ｫ騾夂衍・域悄髯舌い繝ｩ繝ｼ繝茨ｼ・/div>
                                <div style="font-size:12px;color:var(--text-muted)">螂醍ｴ・悄髯舌・30譌･蜑阪・7譌･蜑阪・蠖捺律縺ｫ逋ｻ骭ｲ繝｡繝ｼ繝ｫ縺ｸ騾∽ｿ｡</div>
                            </div>
                        </div>
                        <label class="toggle-switch" style="flex-shrink:0">
                            <input type="checkbox" id="notif-deadline-email-toggle" ${deadlineEmailEnabled ? 'checked' : ''}
                                onchange="window.app.saveNotificationSettings()">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>

                    <!-- 譛滄剞繧｢繝ｩ繝ｼ繝・ Slack -->
                    <div style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:8px;padding:20px 24px">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:16px">
                            <div style="display:flex;align-items:center;gap:14px">
                                <div style="width:36px;height:36px;border-radius:8px;background:var(--color-primary-dim);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                                    <i class="fa-brands fa-slack" style="color:var(--color-primary);font-size:16px"></i>
                                </div>
                                <div>
                                    <div style="font-weight:600;font-size:14px;color:var(--text-main);margin-bottom:2px">Slack騾夂衍・域悄髯舌い繝ｩ繝ｼ繝茨ｼ・/div>
                                    <div style="font-size:12px;color:var(--text-muted)">${slackConnected ? `騾｣謳ｺ貂医メ繝｣繝ｳ繝阪Ν・・{channelName}・峨∈譛滄剞繧｢繝ｩ繝ｼ繝医ｒ騾∽ｿ｡` : '譛滄剞繧｢繝ｩ繝ｼ繝医ｒSlack縺ｸ騾夂衍縺励∪縺・}</div>
                                </div>
                            </div>
                            ${slackConnected
                                ? `<label class="toggle-switch" style="flex-shrink:0">
                                    <input type="checkbox" id="notif-deadline-slack-toggle" ${deadlineSlackEnabled ? 'checked' : ''}
                                        onchange="window.app.saveNotificationSettings()">
                                    <span class="toggle-slider"></span>
                                </label>`
                                : `<button onclick="window.app.connectSlack()"
                                    style="display:inline-flex;align-items:center;gap:7px;padding:8px 16px;background:#4a154b;color:#fff;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:600;flex-shrink:0;transition:opacity .2s"
                                    onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'">
                                    <i class="fa-brands fa-slack"></i>騾｣謳ｺ縺吶ｋ
                                </button>`}
                        </div>
                        ${slackConnected ? '' : ''}
                    </div>

                </div>
                ${deadlineLocked ? lockOverlayDeadline : ''}
                </div>
            </div>
        `;
    }

    async saveNotificationSettings() {
        const emailToggle = document.getElementById('notif-email-toggle');
        const slackToggle = document.getElementById('notif-slack-toggle');

        const deadlineEmailToggle = document.getElementById('notif-deadline-email-toggle');
        const deadlineSlackToggle = document.getElementById('notif-deadline-slack-toggle');

        const settings = {
            email: {
                crawlAlert: emailToggle?.checked !== false,
                deadlineAlert: deadlineEmailToggle?.checked !== false,
            },
            slack: {
                enabled: slackToggle?.checked === true,
                deadlineAlert: deadlineSlackToggle?.checked === true,
            }
        };

        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            if (!token) return; // 繝ｭ繝ｼ繧ｫ繝ｫ迺ｰ蠅・〒縺ｯ繧ｵ繧､繝ｬ繝ｳ繝医↓繧ｹ繧ｭ繝・・

            const apiBase = (await import('./api-base.js')).getApiBaseUrl();
            const res = await fetch(`${apiBase}/api/notifications/settings`, {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
            });
            const data = await res.json();
            if (data.success) {
                Notify.success('騾夂衍險ｭ螳壹ｒ菫晏ｭ倥＠縺ｾ縺励◆');
            } else {
                Notify.error(data.error || '菫晏ｭ倥↓螟ｱ謨励＠縺ｾ縺励◆');
            }
        } catch (err) {
            Notify.error('菫晏ｭ倥↓螟ｱ謨励＠縺ｾ縺励◆: ' + err.message);
        }
    }

    async connectSlack() {
        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            if (!token) {
                Notify.error('繝ｭ繧ｰ繧､繝ｳ縺悟ｿ・ｦ√〒縺・);
                return;
            }
            const apiBase = (await import('./api-base.js')).getApiBaseUrl();
            const res = await fetch(`${apiBase}/api/slack/oauth/start`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json'
                }
            });
            const data = await res.json();
            if (data.success && data.url) {
                window.location.href = data.url;
            } else {
                Notify.error(data.error || 'Slack騾｣謳ｺ縺ｮ髢句ｧ九↓螟ｱ謨励＠縺ｾ縺励◆');
            }
        } catch (err) {
            Notify.error('Slack騾｣謳ｺ縺ｮ髢句ｧ九↓螟ｱ謨励＠縺ｾ縺励◆: ' + err.message);
        }
    }

    async disconnectSlack() {
        if (!await Notify.confirm('Slack騾｣謳ｺ繧定ｧ｣髯､縺励∪縺吶°・・, { title: '遒ｺ隱・, type: 'warning' })) return;
        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            if (!token) return;
            const apiBase = (await import('./api-base.js')).getApiBaseUrl();
            await fetch(`${apiBase}/api/slack/oauth/disconnect`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            Notify.success('Slack騾｣謳ｺ繧定ｧ｣髯､縺励∪縺励◆');
            this.loadAndRenderNotificationSettings();
        } catch (err) {
            Notify.error('隗｣髯､縺ｫ螟ｱ謨励＠縺ｾ縺励◆: ' + err.message);
        }
    }

    async loadAndRenderNotificationSettings() {
        const main = this.mainContent;
        if (!main) return;

        const plan = this.subscription?.plan || 'free';
        if (plan === 'free') {
            main.innerHTML = this.renderNotificationSettings({}, '', plan);
            return;
        }

        // Slack OAuth邨先棡繧偵メ繧ｧ繝・け
        const urlParams = new URLSearchParams(window.location.search);
        const slackConnected = urlParams.get('slack_connected');
        const slackError = urlParams.get('slack_error');
        const slackChannel = urlParams.get('channel');
        if (slackConnected === '1') {
            Notify.success('Slack騾｣謳ｺ縺悟ｮ御ｺ・＠縺ｾ縺励◆');
            history.replaceState(null, '', window.location.pathname);
        } else if (slackError) {
            Notify.error(`Slack騾｣謳ｺ縺ｫ螟ｱ謨励＠縺ｾ縺励◆: ${decodeURIComponent(slackError)}`);
            history.replaceState(null, '', window.location.pathname);
        }

        main.innerHTML = '<div style="padding:40px;color:#888;">隱ｭ縺ｿ霎ｼ縺ｿ荳ｭ...</div>';

        let apiBase = '';
        try {
            apiBase = (await import('./api-base.js')).getApiBaseUrl();
        } catch (_) { /* fallback to empty */ }

        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            if (!token) {
                // 繝ｭ繝ｼ繧ｫ繝ｫ髢狗匱迺ｰ蠅・↑縺ｩ繝医・繧ｯ繝ｳ縺ｪ縺励・蝣ｴ蜷医・繝・ヵ繧ｩ繝ｫ繝郁ｨｭ螳壹ｒ陦ｨ遉ｺ
                main.innerHTML = this.renderNotificationSettings({}, apiBase, plan);
                return;
            }
            const res = await fetch(`${apiBase}/api/notifications/settings`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            const settings = data.success ? data.data : {};
            main.innerHTML = this.renderNotificationSettings(settings, apiBase, plan);
        } catch (err) {
            main.innerHTML = this.renderNotificationSettings({}, apiBase, plan);
        }
    }

    showCancelModal() {
        console.log('showCancelModal called');
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay active';
        overlay.id = 'cancel-modal-overlay';
        overlay.innerHTML = `
        <div class="modal-content" style="max-width:480px;">
            <div class="modal-header" style="background:#fef2f2; border-bottom:1px solid #fecaca;">
                <h3 style="color:#991b1b; margin:0; font-size:1.1rem;">
                    <i class="fa-solid fa-triangle-exclamation" style="margin-right:8px;"></i>繝励Λ繝ｳ縺ｮ繧ｭ繝｣繝ｳ繧ｻ繝ｫ
                </h3>
                <button class="btn-close" onclick="document.getElementById('cancel-modal-overlay').remove()">ﾃ・/button>
            </div>
            <div class="modal-body" style="padding:24px;">
                <p style="margin-bottom:16px; color:#333;">譛ｬ蠖薙↓繝励Λ繝ｳ繧偵く繝｣繝ｳ繧ｻ繝ｫ縺励∪縺吶°・・/p>
                <ul style="font-size:0.85rem; color:#666; margin-bottom:20px; padding-left:20px;">
                    <li style="margin-bottom:6px;">繧ｵ繝悶せ繧ｯ繝ｪ繝励す繝ｧ繝ｳ縺悟●豁｢縺輔ｌ縺ｾ縺・/li>
                    <li style="margin-bottom:6px;">Free繝励Λ繝ｳ・育┌譁呻ｼ峨↓謌ｻ繧翫∪縺・/li>
                    <li style="margin-bottom:6px;">AI隗｣譫仙屓謨ｰ縺梧怦3蝗槭↓蛻ｶ髯舌＆繧後∪縺・/li>
                </ul>
                <div style="display:flex; gap:12px; justify-content:flex-end;">
                    <button onclick="document.getElementById('cancel-modal-overlay').remove()" class="btn-dashboard" style="padding:8px 20px;">繧ｭ繝｣繝ｳ繧ｻ繝ｫ縺励↑縺・/button>
                    <button onclick="window.app.executeCancelSubscription()" class="btn-dashboard" style="background:#d73a49; color:#fff; border:none; padding:8px 20px;">隗｣邏・☆繧・/button>
                </div>
            </div>
        </div>
        `;
        document.body.appendChild(overlay);
    }

    async executeCancelSubscription() {
        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            const apiUrl = `${aiService.API_BASE}/payment/cancel-subscription`;

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            const result = await response.json();

            // Close modal
            const modal = document.getElementById('cancel-modal-overlay');
            if (modal) modal.remove();

            if (result.success) {
                this.paymentStatus = { hasPaymentMethod: false };
                this.subscription.plan = 'free';
                this.subscription.billingCycle = 'monthly';
                this.userPlan = 'free';
                this.planViewBillingCycle = 'monthly';
                this.updateSubscriptionUI();
                Notify.success('繝励Λ繝ｳ縺後く繝｣繝ｳ繧ｻ繝ｫ縺輔ｌ縺ｾ縺励◆縲ら┌譁吶・繝ｩ繝ｳ縺ｫ遘ｻ陦後＠縺ｾ縺励◆縲・);
                this.navigate('plan');
            } else {
                Notify.error('繧ｭ繝｣繝ｳ繧ｻ繝ｫ蜃ｦ逅・〒繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆縲・);
            }
        } catch (error) {
            console.error('Cancel subscription error:', error);
            Notify.error('繧ｭ繝｣繝ｳ繧ｻ繝ｫ蜃ｦ逅・〒繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆縲・);
        }
    }

    updateSubscriptionUI() {
        const container = document.getElementById('plan-status-container');
        if (!container) return;

        const sub = this.subscription;
        if (!sub) return;

        const planNames = {
            'free': 'Free',
            'starter': 'Starter',
            'business': 'Business',
            'pro': 'Pro'
        };

        const usagePercent = Math.min(100, (sub.usageCount / sub.usageLimit) * 100);
        const planName = planNames[sub.plan] || sub.plan;
        const billingCycleLabel = sub.billingCycle === 'annual' ? '蟷ｴ鬘・ : '譛磯｡・;

        let upgradeAdvice = '';
        if (sub.usageCount >= sub.usageLimit) {
            if (sub.plan === 'free') {
                upgradeAdvice = '<div class="upgrade-advice">譛磯俣荳企剞縺ｫ驕斐＠縺ｾ縺励◆縲４tarter莉･荳翫・繝励Λ繝ｳ縺ｫ縺吶ｋ縺ｨ隗｣譫仙屓謨ｰ縺悟｢励∴縺ｾ縺吶・/div>';
            } else if (sub.plan === 'starter') {
                upgradeAdvice = '<div class="upgrade-advice">譛磯俣荳企剞縺ｫ驕斐＠縺ｾ縺励◆縲らｿ梧怦縺ｾ縺ｧ蠕・▽縺九。usiness莉･荳翫・繝励Λ繝ｳ縺ｫ縺吶ｋ縺ｨ蝗樊焚縺悟｢励∴縺ｾ縺吶・/div>';
            } else if (sub.plan === 'business') {
                upgradeAdvice = '<div class="upgrade-advice">譛磯俣荳企剞縺ｫ驕斐＠縺ｾ縺励◆縲らｿ梧怦縺ｾ縺ｧ蠕・▽縺九￣ro繝励Λ繝ｳ縺ｫ繧｢繝・・繧ｰ繝ｬ繝ｼ繝峨☆繧九→蝗樊焚縺悟｢励∴縺ｾ縺吶・/div>';
            } else if (sub.plan === 'pro') {
                upgradeAdvice = '<div class="upgrade-advice">譛磯俣荳企剞縺ｫ驕斐＠縺ｾ縺励◆縲らｿ梧怦縺ｾ縺ｧ縺雁ｾ・■縺・◆縺�縺上°縲∬ｿｽ蜉�譫�縺ｫ縺､縺・※縺雁撫縺・粋繧上○縺上□縺輔＞縲・/div>';
            }
        }

        let statusHtml = `
        <div class="plan-status-card">
            <div class="plan-badge plan-badge-${sub.plan}">${planName}・・{billingCycleLabel}・・/div>
            <div class="plan-info-text">
                AI隗｣譫・ <strong style="${(({'free':3,'starter':50,'business':120,'pro':400}[sub.plan] || sub.usageLimit) - sub.usageCount) <= 1 ? 'color:#f59e0b;' : ''}">${sub.usageCount}</strong> / ${{'free':3,'starter':50,'business':120,'pro':400}[sub.plan] || sub.usageLimit}蝗・
                <br>髮ｻ蟄千ｽｲ蜷・ <strong>${sub.signUsageCount || 0}</strong> / ${sub.plan === 'pro' ? '辟｡蛻ｶ髯・ : `${{'free':10,'starter':25,'business':100}[sub.plan] || sub.signUsageLimit || 0}蝗杼}
                ${sub.renewalDate ? `<br><span style="font-size:0.75rem; opacity:0.8;">谺｡蝗樊峩譁ｰ: <strong>${new Date(sub.renewalDate).toLocaleDateString('ja-JP')}</strong></span>` : ''}
            </div>
            ${upgradeAdvice}
            ${this.isSignLimitReached() ? `
                <div style="margin-top:10px; padding:8px 10px; background:rgba(234,67,53,0.08); border:1px solid rgba(234,67,53,0.2); border-radius:6px; font-size:0.72rem; color:#c2410c;">
                    莉頑怦縺ｮ髮ｻ蟄千ｽｲ蜷堺ｸ企剞縺ｫ驕斐＠縺ｾ縺励◆縲らｿ梧怦縺ｾ縺ｧ縺雁ｾ・■縺・◆縺�縺上°縲∽ｸ贋ｽ阪・繝ｩ繝ｳ縺ｸ縺ｮ繧｢繝・・繧ｰ繝ｬ繝ｼ繝峨ｒ縺疲､懆ｨ弱￥縺�縺輔＞縲・
                </div>
            ` : ''}
        </div>
        `;

        container.innerHTML = statusHtml;
        this.updateUIByPlan();
    }

    updateUIByPlan() {
        if (!this.subscription) return;
        const plan = this.subscription.plan;
        // --- Navigation Logic ---
        // Team Management: Business+
        const navTeam = document.querySelector('.nav-item[onclick*="navigate(\'team\')"]');
        if (navTeam) {
            navTeam.classList.remove('feature-locked');
            navTeam.style.display = 'flex';
        }

        // Notification Settings: Pro only
        const navNotif = document.getElementById('nav-notifications');
        if (plan !== 'pro') {
            if (navNotif) navNotif.classList.add('feature-locked');
        } else {
            if (navNotif) navNotif.classList.remove('feature-locked');
        }

        // Deadline Alert Management: Business+ only
        const navDeadlines = document.getElementById('nav-deadlines');
        if (!['business', 'pro'].includes(plan)) {
            if (navDeadlines) navDeadlines.classList.add('feature-locked');
        } else {
            if (navDeadlines) navDeadlines.classList.remove('feature-locked');
        }
    }



    bindEvents() {
        const toggle = document.getElementById('sidebar-toggle');
        const sidebar = document.getElementById('app-sidebar');
        const overlay = document.getElementById('sidebar-overlay');

        const closeSidebar = () => {
            sidebar?.classList.remove('active');
            overlay?.classList.remove('active');
        };

        if (toggle && sidebar) {
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                sidebar.classList.toggle('active');
                overlay?.classList.toggle('active');
            });
        }

        if (overlay) {
            overlay.addEventListener('click', closeSidebar);
        }

        // URL Modal Submit Binding
        const submitUrlBtn = document.getElementById('submit-url-btn');
        if (submitUrlBtn) {
            submitUrlBtn.onclick = () => {
                const urlInput = document.getElementById('new-version-url');
                const url = urlInput ? urlInput.value.trim() : "";
                if (!url) {
                    Notify.warning('URL繧貞・蜉帙＠縺ｦ縺上□縺輔＞');
                    return;
                }
                const contractId = submitUrlBtn.getAttribute('data-contract-id');
                this.handleUrlVersionSubmit(contractId, url);
            };
        }
    }

    async navigate(viewId, params = null) {
        console.log(`Navigating to ${viewId}`, params);

        if (viewId !== 'diff') {
            this.clearHistoryComparisonContext();
            this.clearDocumentCompareState();
        }

        // Auto-close sidebar on mobile
        document.getElementById('app-sidebar')?.classList.remove('active');
        document.getElementById('sidebar-overlay')?.classList.remove('active');

        if (viewId === 'diff' && !this.ensurePaymentAccess('蟾ｮ蛻・ｩ溯・')) {
            return;
        }

        // --- FIX: Update UI state early before any branches return ---
        this.currentView = viewId;
        this.updateActiveMenu(viewId);
        this.updateRegistrationButtonVisibility(viewId);
        
        // Toggle Fluid Layout Mode for Detail View
        if (viewId === 'diff') {
            this.mainContent.classList.add('is-detail-view');
        } else {
            this.mainContent.classList.remove('is-detail-view');
        }

        if (viewId !== 'contracts') {
            this.searchQuery = "";
            this.currentPage = 1;
        }

        if (viewId === 'sign') {
            await dbService.syncContractsFromApi();
            console.trace('Routing to sign');
            const { SignUI } = await import('./sign-ui.js?v=20260321a');
            this.mainContent.innerHTML = await SignUI.renderSignView(this);
            SignUI.refreshList(this);
            return;
        }

        if (viewId === 'sign-viewer') {
            const { SignUI } = await import('./sign-ui.js?v=20260321a');
            const { SignViewer } = await import('./sign-viewer.js?v=20260321az');
            this.mainContent.innerHTML = await SignUI.renderSignViewer(this, params);
            await SignViewer.init(this, params);
            return;
        }
        
        if (viewId === 'sign-editor') {
            const { SignUI } = await import('./sign-ui.js?v=20260321a');
            const { SignEditor } = await import('./sign-editor.js?v=20260321b');
            this.mainContent.innerHTML = await SignUI.renderSignEditor(this, params);
            await SignEditor.init(this, params);
            return;
        }

        if (viewId === 'sign-recipient') {
            const { SignUI } = await import('./sign-ui.js?v=20260321a');
            const { SignRecipient } = await import('./sign-recipient.js?v=20260320aa');
            this.mainContent.innerHTML = await SignUI.renderSignRecipient(this, params);
            await SignRecipient.init(this, params);
            return;
        }

        // RBAC: Protect team view - Business+縺ｮ縺ｿ
        if (viewId === 'team' && this.subscription?.plan === 'starter') {
            const upgradeModal = document.getElementById('upgrade-modal');
            if (upgradeModal) {
                upgradeModal.classList.add('active');
            }
            return;
        }

        if (viewId === 'deadlines') {
            await dbService.syncContractsFromApi();
            this.mainContent.innerHTML = this.renderDeadlinesView(params && typeof params === 'object' ? params : {});
            this.updateDeadlinesBadge();
            return;
        }

        if (viewId === 'history') {
            dbService.cleanupLogs(this.userPlan || 'starter');
            this.cacheRecentHistorySnapshot();
        }

        let renderParams = params;
        if (viewId === 'dashboard' || viewId === 'contracts') {
            await dbService.syncContractsFromApi();
        }
        if (viewId === 'contracts') {
            renderParams = {
                page: this.currentPage,
                ...this.filters,
                ...params
            };
        }
        if (viewId === 'diff') {
            const normalizedDiffId = normalizeDiffContractId(params);
            if (!normalizedDiffId) {
                Notify.error('蟇ｾ雎｡縺ｮ螂醍ｴИD繧貞叙蠕励〒縺阪∪縺帙ｓ縺ｧ縺励◆縲ゆｸ隕ｧ縺九ｉ蜀榊ｺｦ髢九＞縺ｦ縺上□縺輔＞縲・);
                return;
            }
            renderParams = normalizedDiffId;
            // Auto-switch to 'original' tab for new contracts (no history)
            const isNewContract = normalizedDiffId !== this.currentViewParams;
            if (isNewContract && !this.historyComparisonContext) {
                const _c = dbService.getContractById(normalizedDiffId);
                const historyCount = (_c && Array.isArray(_c.history)) ? _c.history.length : 0;
                
                // If no history exists, always show 'original' tab first
                if (historyCount === 0) {
                    this.activeDetailTab = 'original';
                } else if (!this.currentViewParams) {
                    // Initial load with history -> show 'diff'
                    this.activeDetailTab = 'diff';
                }
            }
            this.currentViewParams = normalizedDiffId;
        }
        if (viewId === 'diff' && this.activeDetailTab === 'diff') {
            this.renderInitialSkeleton('diff');
            this.ensureDiffLibrary()
                .then(() => {
                    if (this.currentView === 'diff' && this.activeDetailTab === 'diff') {
                        try {
                            this.mainContent.innerHTML = Views.diff(this.currentViewParams);
                            this.resetDetailPaneScroll();
                            this.enforceDetailScrollLayout();
                            this.setupClauseNavAutoSync();
                        } catch (error) {
                            console.warn('Deferred diff rerender failed:', error);
                        }
                    }
                })
                .catch((error) => {
                    console.warn('Diff library lazy load failed:', error);
                });
        }
        if (viewId === 'plan') {
            if (!this.planViewBillingCycle) {
                this.planViewBillingCycle = this.subscription?.billingCycle === 'annual' ? 'annual' : 'monthly';
            }
            if (!this.paymentConfig) {
                this.fetchPaymentConfig().then((config) => {
                    if (config && this.currentView === 'plan') {
                        this.navigate('plan');
                    }
                }).catch((error) => {
                    console.warn('Failed to prefetch payment config for plan view:', error);
                });
            }
        }

        if (viewId === 'notifications') {
            this.loadAndRenderNotificationSettings();
            return;
        }

        const navMap = {
            'dashboard': 0, 'contracts': 1, 'history': 2, 'sign': 3, 'team': 4, 'plan': 5
        };

        // Update active menu state
        // (Moved to top of navigate)
        const navItems = document.querySelectorAll('.nav-item');
        // Find by content or click handler match
        navItems.forEach(item => {
            const onclick = item.getAttribute('onclick');
            if (onclick && onclick.includes(`navigate('${viewId}')`)) {
                item.classList.add('active');
            }
        });

        if (Views[viewId]) {
            try {
                this.mainContent.innerHTML = Views[viewId](renderParams);

                const titles = {
                    'dashboard': '繝繝・す繝･繝懊・繝・,
                    'plan': '繝励Λ繝ｳ邂｡逅・,
                    'contracts': '螂醍ｴ・・隕冗ｴ・ｮ｡逅・,
                    'diff': '隗｣譫占ｩｳ邏ｰ',
                    'history': '螻･豁ｴ繝ｻ繝ｭ繧ｰ',
                    'team': '繝√・繝�險ｭ螳・,
                    'sign': '鄂ｲ蜷咲ｮ｡逅・,
                    'sign-viewer': '鄂ｲ蜷阪ン繝･繝ｼ繝ｯ繝ｼ'
                };
                if (this.pageTitle) {
                    this.pageTitle.textContent = titles[viewId] || 'DIFFsense';
                }

                window.scrollTo(0, 0);

                // Ensure detail panes always start from top.
                if (viewId === 'diff') {
                    this.resetDetailPaneScroll();
                }
                this.enforceDetailScrollLayout();
                if (viewId === 'diff') {
                    this.setupClauseNavAutoSync();
                } else {
                    this.teardownClauseNavAutoSync();
                }
                if (viewId === 'dashboard' || viewId === 'history') {
                    this.cacheRecentHistorySnapshot();
                }

                if (viewId === 'contracts' && this.filters.query) {
                    const searchInput = document.getElementById('contract-search');
                    if (searchInput) {
                        searchInput.focus();
                        searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
                    }
                }
            } catch (error) {
                console.error(`View Render Error (${viewId}):`, error);
                if (viewId === 'diff') {
                    const contractId = typeof renderParams === 'object' ? renderParams?.id : renderParams;
                    const contract = dbService.getContractById(contractId);
                    const safeTitle = escapeHtmlText(contract?.name || '隗｣譫占ｩｳ邏ｰ');
                    const safeFile = escapeHtmlText(contract?.original_filename || '');
                    const safeBody = escapeHtmlText(contentToComparableText(contract?.original_content || '') || '蜴滓悽繝・・繧ｿ縺後≠繧翫∪縺帙ｓ');
                    this.mainContent.innerHTML = `
                        <div class="detail-split-container">
                            <div class="detail-split-header flex justify-between items-center">
                                <div class="detail-header-main">
                                    <h2 style="font-size:18px; font-weight:700; color:var(--text-main); margin:0;">${safeTitle}</h2>
                                    ${safeFile ? `<div class="detail-header-meta" style="font-size:12px; color:#666; margin-top:4px;"><span class="detail-header-meta-item"><i class="fa-solid fa-file-lines"></i> Original File: ${safeFile}</span></div>` : ''}
                                </div>
                            </div>
                            <div style="padding:24px;">
                                <div style="margin-bottom:16px; color:#b42318; font-size:13px;">豈碑ｼ・判髱｢縺ｮ謠冗判縺ｧ繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺溘◆繧√∝ｮ牙・陦ｨ遉ｺ縺ｫ蛻・ｊ譖ｿ縺医∪縺励◆縲・/div>
                                <div style="background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:20px; white-space:pre-wrap; line-height:1.9;">${safeBody}</div>
                            </div>
                        </div>
                    `;
                } else {
                    this.mainContent.innerHTML = '<div class="p-md text-danger">逕ｻ髱｢縺ｮ陦ｨ遉ｺ荳ｭ縺ｫ繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆縲・/div>';
                }
            }
        }
    }

    setDashboardFilter(filter) {
        this.dashboardFilter = filter;
        const filteredItems = dbService.getFilteredContracts(filter);

        const titleEl = document.getElementById('dashboard-section-title');
        if (titleEl) {
            let sectionTitle = "隕∫｢ｺ隱阪い繧､繝・Β (蜆ｪ蜈亥ｺｦ鬆・";
            if (filter === 'pending') sectionTitle = "譛ｪ蜃ｦ逅・・繧｢繧､繝・Β (譁ｰ逹繝ｻ螟画峩讀懃衍)";
            if (filter === 'risk') sectionTitle = "繝ｪ繧ｹ繧ｯ隕∝愛螳壹い繧､繝・Β";
            if (filter === 'total') sectionTitle = "蜈ｨ逶｣隕門ｯｾ雎｡・域怙譁ｰ鬆・ｼ・;
            titleEl.textContent = sectionTitle;
        }

        const tableBody = document.getElementById('dashboard-table-body');
        if (tableBody) {
            const rows = filteredItems.length > 0 ? filteredItems.slice(0, 10).map(c => {
                let riskBadgeClass = 'badge-neutral';
                if (c.risk_level === 'High') riskBadgeClass = 'badge-danger';
                else if (c.risk_level === 'Medium') riskBadgeClass = 'badge-warning';
                else if (c.risk_level === 'Low') riskBadgeClass = 'badge-success';

                let statusBadge = '';
                if (c.status === '譛ｪ隗｣譫・) statusBadge = '<span class="badge badge-info">譛ｪ隗｣譫・(譁ｰ隕・</span>';
                else if (c.status === '譛ｪ蜃ｦ逅・) statusBadge = '<span class="badge badge-info">譛ｪ蜃ｦ逅・/span>';
                else if (c.status === '譛ｪ遒ｺ隱・) statusBadge = '<span class="badge badge-warning">隕∫｢ｺ隱・(螟画峩)</span>';
                else if (c.status === '遒ｺ隱肴ｸ・) statusBadge = '<span class="badge badge-neutral"><i class="fa-solid fa-check"></i> 遒ｺ隱肴ｸ・/span>';

                const actionBtn = window.app.can('operate_contract')
                    ? `<button class="btn-dashboard">${c.status === '遒ｺ隱肴ｸ・ ? '螻･豁ｴ繧定ｦ九ｋ' : '遒ｺ隱阪☆繧・}</button>`
                    : `<button class="btn-dashboard">隧ｳ邏ｰ繧定ｦ九ｋ</button>`;

                return `
        <tr onclick="window.app.navigate('diff', ${c.id})">
            <td><span class="badge ${riskBadgeClass}">${c.risk_level}</span></td>
            <td class="col-name" title="${c.name}">${c.name}</td>
            <td>${c.last_updated_at}</td>
            <td>${statusBadge}</td>
            <td>${actionBtn}</td>
        </tr>
        `;
            }).join('') : '<tr><td colspan="5" class="text-center text-muted" style="padding:40px;">隧ｲ蠖薙☆繧九い繧､繝・Β縺ｯ縺ゅｊ縺ｾ縺帙ｓ</td></tr>';
            tableBody.innerHTML = rows;
        }

        document.querySelectorAll('.stat-card').forEach(card => {
            card.classList.remove('active');
            const isActive = (filter === 'pending' && card.textContent.includes('譛ｪ蜃ｦ逅・)) ||
                (filter === 'risk' && card.textContent.includes('繝ｪ繧ｹ繧ｯ隕∝愛螳・)) ||
                (filter === 'total' && card.textContent.includes('逶｣隕紋ｸｭ'));
            if (isActive) card.classList.add('active');
        });
    }

    // --- Action Handlers ---

    updateFilter(key, value) {
        this.filters[key] = value;
        this.currentPage = 1;

        if (key === 'query') {
            clearTimeout(this.searchTimeout);
            this.searchTimeout = setTimeout(() => this.navigate('contracts'), 300);
        } else {
            this.navigate('contracts');
        }
    }

    async setDetailTab(tab) {
        this.activeDetailTab = tab;
        await this.navigate('diff', this.currentViewParams);

        // Reset scroll positions when switching tabs in detail view.
        this.resetDetailPaneScroll();
        this.setupClauseNavAutoSync();
    }

    getDetailHeaderOffset(scrollArea = null) {
        const appHeader = document.getElementById('app-header');
        const appHeaderHeight = appHeader ? appHeader.offsetHeight : 0;

        if (!scrollArea) {
            return appHeaderHeight + 10;
        }

        const pane = scrollArea.closest('.pane');
        const paneHeader = pane ? pane.querySelector('.pane-header') : null;
        const tabsRow = pane ? pane.querySelector('.tabs-row') : null;
        const paneHeaderHeight = paneHeader ? paneHeader.offsetHeight : 0;
        const tabsHeight = tabsRow ? tabsRow.offsetHeight : 0;

        return paneHeaderHeight + tabsHeight + 10;
    }

    setActiveClauseNavItem(clauseId) {
        const navItems = document.querySelectorAll('.detail-split-body .pane:nth-child(2) .clause-nav-item');
        if (!navItems.length) return;
        navItems.forEach((item) => {
            const isActive = item.getAttribute('data-clause-id') === clauseId;
            item.classList.toggle('active', isActive);
        });
    }

    getDetailContentScrollContainer(rightPane) {
        if (!rightPane) return null;
        // Single scroll container for detail right pane.
        return rightPane.querySelector('.pane-scroll-area');
    }

    updateClauseNavByScroll(scrollContainer) {
        if (!scrollContainer) return;
        if (this.clauseNavManualLockUntil && Date.now() < this.clauseNavManualLockUntil && this.clauseNavManualTargetId) {
            this.setActiveClauseNavItem(this.clauseNavManualTargetId);
            return;
        }
        const cards = Array.from(scrollContainer.querySelectorAll('.clause-card[id]'));
        if (!cards.length) return;

        const containerTop = scrollContainer.getBoundingClientRect().top;
        const offset = scrollContainer.classList.contains('clause-cards-container')
            ? 8
            : this.getDetailHeaderOffset(scrollContainer);
        const threshold = containerTop + offset;

        let activeCard = cards[0];
        for (const card of cards) {
            const top = card.getBoundingClientRect().top;
            if (top <= threshold) {
                activeCard = card;
            } else {
                break;
            }
        }

        this.setActiveClauseNavItem(activeCard.id);
    }

    setupClauseNavAutoSync() {
        this.teardownClauseNavAutoSync();

        if (this.currentView !== 'diff') return;
        if (this.activeDetailTab !== 'original') return;

        const rightPane = document.querySelector('.detail-split-body .pane:nth-child(2)');
        if (!rightPane) return;
        const scrollArea = this.getDetailContentScrollContainer(rightPane);
        const navItems = Array.from(rightPane.querySelectorAll('.clause-nav-item[data-clause-id]'));
        if (!scrollArea || !navItems.length) return;

        // In original tab, keep TOC fixed and scroll only document cards area.
        scrollArea.style.overflowY = 'auto';
        scrollArea.style.overflowX = 'hidden';
        scrollArea.style.pointerEvents = 'auto';
        scrollArea.style.overscrollBehavior = 'contain';
        scrollArea.style.webkitOverflowScrolling = 'touch';

        const onScroll = () => {
            if (this.detailClauseNavRaf) return;
            this.detailClauseNavRaf = requestAnimationFrame(() => {
                this.detailClauseNavRaf = null;
                this.updateClauseNavByScroll(scrollArea);
            });
        };

        scrollArea.addEventListener('scroll', onScroll, { passive: true });
        const navBox = rightPane.querySelector('.clause-nav');
        const navList = rightPane.querySelector('.clause-nav-list');
        const onWheelForward = (event) => {
            if (!event || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
            scrollArea.scrollTop += event.deltaY;
        };
        // Keep native wheel behavior on cards container itself (main scroll target).
        // Only forward wheel from TOC to the content scroll container.
        if (navBox) {
            navBox.addEventListener('wheel', onWheelForward, { passive: true });
        }
        if (navList) {
            navList.addEventListener('wheel', onWheelForward, { passive: true });
        }
        let observer = null;
        const cardsForObserver = Array.from(scrollArea.querySelectorAll('.clause-card[id]'));
        if (cardsForObserver.length > 0 && typeof IntersectionObserver === 'function') {
            observer = new IntersectionObserver((entries) => {
                if (this.clauseNavManualLockUntil && Date.now() < this.clauseNavManualLockUntil && this.clauseNavManualTargetId) {
                    this.setActiveClauseNavItem(this.clauseNavManualTargetId);
                    return;
                }
                const visible = entries
                    .filter((entry) => entry.isIntersecting)
                    .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
                if (visible.length > 0) {
                    const activeId = visible[0].target?.id;
                    if (activeId) this.setActiveClauseNavItem(activeId);
                }
            }, {
                root: scrollArea,
                threshold: [0.35, 0.55, 0.75],
                rootMargin: '-8px 0px -55% 0px'
            });

            cardsForObserver.forEach((card) => observer.observe(card));
        }

        this.detailClauseNavScrollCleanup = () => {
            scrollArea.removeEventListener('scroll', onScroll);
            if (navBox) {
                navBox.removeEventListener('wheel', onWheelForward);
            }
            if (navList) {
                navList.removeEventListener('wheel', onWheelForward);
            }
            if (this.detailClauseNavRaf) {
                cancelAnimationFrame(this.detailClauseNavRaf);
                this.detailClauseNavRaf = null;
            }
            if (observer) {
                observer.disconnect();
                observer = null;
            }
        };

        this.updateClauseNavByScroll(scrollArea);
    }

    teardownClauseNavAutoSync() {
        if (typeof this.detailClauseNavScrollCleanup === 'function') {
            this.detailClauseNavScrollCleanup();
        }
        this.detailClauseNavScrollCleanup = null;
        if (this.detailClauseNavRaf) {
            cancelAnimationFrame(this.detailClauseNavRaf);
            this.detailClauseNavRaf = null;
        }
    }

    scrollToClause(clauseId, options = {}) {
        const behavior = options.behavior || 'smooth';
        const target = document.getElementById(clauseId);
        if (!target) return;
        // Cancel pending auto-reset timers once user explicitly navigates by clause.
        this.detailResetToken = 0;
        this.clauseNavManualTargetId = clauseId;
        this.clauseNavManualLockUntil = Date.now() + 900;

        const paneScrollArea = target.closest('.pane-scroll-area');
        if (paneScrollArea) {
            const offset = this.getDetailHeaderOffset(paneScrollArea);
            const cardsContainer = target.closest('.clause-cards-container');
            const containerTop = cardsContainer ? (cardsContainer.offsetTop || 0) : 0;
            const targetTop = target.offsetTop || 0;
            const topWithinPane = containerTop + targetTop;
            const nextTop = topWithinPane - offset;
            paneScrollArea.scrollTo({ top: Math.max(0, Math.round(nextTop)), behavior });
            this.setActiveClauseNavItem(clauseId);
            return;
        }

        const offset = this.getDetailHeaderOffset(null);
        const elementPosition = target.getBoundingClientRect().top + window.pageYOffset;
        const offsetPosition = Math.max(0, elementPosition - offset);
        window.scrollTo({ top: offsetPosition, behavior });
        this.setActiveClauseNavItem(clauseId);
    }

    enforceDetailScrollLayout() {
        if (!this.mainContent) return;

        if (this.currentView !== 'diff') {
            this.mainContent.style.display = '';
            this.mainContent.style.flexDirection = '';
            this.mainContent.style.minHeight = '';
            this.mainContent.style.height = '';
            this.mainContent.style.overflowY = '';
            this.mainContent.style.overflowX = '';
            return;
        }

        // Single-scroll layout chain for detail view (stable at browser zoom 100%).
        this.mainContent.style.display = 'flex';
        this.mainContent.style.flexDirection = 'column';
        this.mainContent.style.minHeight = '0';
        this.mainContent.style.height = '100%';
        this.mainContent.style.overflowY = 'hidden';
        this.mainContent.style.overflowX = 'hidden';

        const detailContainer = this.mainContent.querySelector('.detail-split-container');
        if (detailContainer) {
            detailContainer.style.display = 'flex';
            detailContainer.style.flexDirection = 'column';
            detailContainer.style.flex = '1 1 auto';
            detailContainer.style.minHeight = '0';
            detailContainer.style.height = '100%';
        }

        const detailBody = this.mainContent.querySelector('.detail-split-body');
        if (detailBody) {
            detailBody.style.display = 'flex';
            detailBody.style.flex = '1 1 auto';
            detailBody.style.minHeight = '0';
            detailBody.style.height = 'auto';
            detailBody.style.overflow = 'hidden';
        }

        this.mainContent.querySelectorAll('.detail-split-body .pane').forEach((pane) => {
            pane.style.display = 'flex';
            pane.style.flexDirection = 'column';
            pane.style.flex = '1 1 0';
            pane.style.minHeight = '0';
            pane.style.overflow = 'hidden';
        });

        this.mainContent.querySelectorAll('.pane-scroll-area').forEach((area) => {
            area.style.display = 'block';
            area.style.flex = '1 1 auto';
            area.style.overflowY = 'auto';
            area.style.overflowX = 'hidden';
            area.style.minHeight = '0';
            area.style.height = 'auto';
            area.style.scrollPaddingTop = '8px';
        });

        this.mainContent.querySelectorAll('.clause-card').forEach((card) => {
            card.style.scrollMarginTop = '100px';
        });
    }

    resetDetailPaneScroll() {
        const resetToken = Date.now();
        this.detailResetToken = resetToken;
        const resetScrollAreaToTop = (scrollArea) => {
            if (!scrollArea) return;
            scrollArea.scrollTop = 0;
            scrollArea.scrollLeft = 0;
            scrollArea.scrollTo({ top: 0, left: 0, behavior: 'auto' });
        };

        const runReset = () => {
            if (this.detailResetToken !== resetToken) return;
            const rightPane = document.querySelectorAll('.detail-split-body .pane')[1];
            if (!rightPane) return;

            const scrollArea = rightPane.querySelector('.pane-scroll-area');
            const detailBody = document.querySelector('.detail-split-body');
            const documentContent = rightPane.querySelector('.document-content-full');
            const structuredView = rightPane.querySelector('.contract-structured-container');
            const navBox = rightPane.querySelector('.clause-nav');
            const navList = rightPane.querySelector('.clause-nav-list');
            const clauseCards = rightPane.querySelector('.clause-cards-container');

            if (scrollArea) {
                scrollArea.style.scrollBehavior = 'auto';
                resetScrollAreaToTop(scrollArea);
            }
            if (detailBody) {
                detailBody.scrollTop = 0;
            }
            if (documentContent) {
                documentContent.scrollTop = 0;
            }
            if (structuredView) {
                structuredView.scrollTop = 0;
            }
            if (navBox) {
                navBox.scrollTop = 0;
            }
            if (navList) {
                navList.scrollTop = 0;
                navList.scrollTo({ top: 0, left: 0, behavior: 'auto' });
            }
            if (clauseCards) {
                clauseCards.scrollTop = 0;
                clauseCards.scrollTo({ top: 0, left: 0, behavior: 'auto' });
            }

            if (this.activeDetailTab === 'original' && scrollArea) {
                const firstNavItem = rightPane.querySelector('.clause-nav-item[data-clause-id]');
                const firstClauseId = firstNavItem ? firstNavItem.getAttribute('data-clause-id') : null;
                if (firstClauseId) {
                    this.setActiveClauseNavItem(firstClauseId);
                }
            }
        };

        requestAnimationFrame(() => {
            runReset();

            const rightPane = document.querySelectorAll('.detail-split-body .pane')[1];
            const scrollArea = rightPane ? rightPane.querySelector('.pane-scroll-area') : null;
            const delayedResets = [120, 420, 900];
            delayedResets.forEach((delayMs) => {
                setTimeout(() => {
                    if (this.detailResetToken !== resetToken) return;
                    runReset();
                }, delayMs);
            });

            if (scrollArea) {
                // Keep nav static (no independent scrolling) and always route wheel to content pane.
                const navBox = rightPane ? rightPane.querySelector('.clause-nav') : null;
                const navList = rightPane ? rightPane.querySelector('.clause-nav-list') : null;
                if (navBox) {
                    navBox.scrollTop = 0;
                    navBox.style.overflow = 'hidden';
                }
                if (navList) {
                    navList.scrollTop = 0;
                    navList.style.overflowY = 'hidden';
                }
            }
        });
    }

    changePage(newPage) {
        this.currentPage = newPage;
        this.navigate('contracts', { page: newPage });
    }

    confirmContract(id) {
        if (!this.can('operate_contract')) {
            Notify.warning('髢ｲ隕ｧ縺ｮ縺ｿ縺ｮ讓ｩ髯舌〒縺ｯ繧ｹ繝・・繧ｿ繧ｹ繧貞､画峩縺ｧ縺阪∪縺帙ｓ');
            return;
        }
        if (dbService.updateContractStatus(id, '遒ｺ隱肴ｸ・)) {
            // Switch to 'Monitoring' (Total) view and go back to dashboard
            this.dashboardFilter = 'total';
            this.navigate('dashboard');
        }
    }

    async analyzeContract(id) {
        if (!this.can('operate_contract')) {
            Notify.warning('髢ｲ隕ｧ縺ｮ縺ｿ縺ｮ讓ｩ髯舌〒縺ｯAI隗｣譫舌ｒ螳溯｡後〒縺阪∪縺帙ｓ');
            return;
        }
        const count = Number(this.subscription?.usageCount || 0);
        const limit = Number(this.subscription?.usageLimit || 0);
        if (count >= limit) {
            this.showAnalysisLimitError({ currentUsage: count, limit: limit });
            return;
        }
        if (!this.ensurePaymentAccess('蟾ｮ蛻・ｧ｣譫・)) {
            return;
        }
        const contract = dbService.getContractById(id);
        if (!contract) {
            Notify.error('螂醍ｴ・′隕九▽縺九ｊ縺ｾ縺帙ｓ');
            return;
        }

        if (!contract.original_content) {
            Notify.error('蜈・・繝・く繧ｹ繝医′隕九▽縺九ｊ縺ｾ縺帙ｓ縲ょ・蠎ｦ逋ｻ骭ｲ縺励※縺上□縺輔＞縲・);
            return;
        }

        // 遒ｺ隱阪ム繧､繧｢繝ｭ繧ｰ
        if (!await Notify.confirm(`縲・{contract.name}縲阪・蟾ｮ蛻・ｧ｣譫舌ｒ螳溯｡後＠縺ｾ縺吶°・歃n\nAI隗｣譫舌↓繧医ｊ縲√Μ繧ｹ繧ｯ蛻､螳壹→螟画峩邂・園縺ｮ謚ｽ蜃ｺ繧定｡後＞縺ｾ縺吶Ａ, { title: '遒ｺ隱・, type: 'info' })) {
            return;
        }

        try {
            // 繝ｭ繝ｼ繝・ぅ繝ｳ繧ｰ陦ｨ遉ｺ
            const loadingMsg = document.createElement('div');
            loadingMsg.style.cssText = 'position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); background:white; padding:30px; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.3); z-index:10000; text-align:center;';
            loadingMsg.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="font-size:32px; color:#4CAF50;"></i><br><br><strong>AI隗｣譫蝉ｸｭ...</strong><br><span style="font-size:12px; color:#666;">謨ｰ遘偵♀蠕・■縺上□縺輔＞</span>';
            document.body.appendChild(loadingMsg);

            // AI隗｣譫舌ｒ螳溯｡鯉ｼ域立繝舌・繧ｸ繝ｧ繝ｳ縺後≠繧後・蟾ｮ蛻・ｯ碑ｼ・Δ繝ｼ繝会ｼ・
            const previousVersion = (contract.history && contract.history.length > 0)
                ? contract.history[contract.history.length - 1].content
                : null;
            const result = await aiService.analyzeContract(
                id,
                'text',  // 繝・く繧ｹ繝医→縺励※騾∽ｿ｡
                contract.original_content,
                previousVersion
            );

            // 繝ｭ繝ｼ繝・ぅ繝ｳ繧ｰ蜑企勁
            document.body.removeChild(loadingMsg);

            if (result.success) {
                // 隗｣譫千ｵ先棡繧奪B縺ｫ菫晏ｭ・
                const analysisPayloadAi = {
                    extractedText: contract.original_content,  // 譌｢蟄倥・繝・く繧ｹ繝医ｒ菫晄戟
                    changes: result.data.changes,
                    riskLevel: result.data.riskLevel,
                    riskReason: result.data.riskReason,
                    summary: result.data.summary,
                    isFallback: result.data.isFallback === true,
                    aiFailed: result.data.aiFailed === true,
                    status: '譛ｪ遒ｺ隱・  // 隗｣譫仙ｮ御ｺ・∫｢ｺ隱榊ｾ・■
                };
                // contract_meta・域悄髯先ュ蝣ｱ・峨′霑斐▲縺ｦ縺阪◆蝣ｴ蜷医・繝槭・繧ｸ縺励※菫晏ｭ・
                if (result.data.contract_meta) {
                    const m = result.data.contract_meta;
                    analysisPayloadAi.expiry_date = m.expiry_date || null;
                    analysisPayloadAi.renewal_deadline = m.renewal_deadline || null;
                    analysisPayloadAi.contract_start = m.contract_start || null;
                    analysisPayloadAi.auto_renewal = m.auto_renewal === true;
                    analysisPayloadAi.notice_period_days = m.notice_period_days || null;
                    analysisPayloadAi.contract_category = m.contract_category || null;
                    analysisPayloadAi.date_confidence = m.date_confidence || 'unknown';
                }
                dbService.updateContractAnalysis(id, analysisPayloadAi);

                // 繧ｵ繝悶せ繧ｯ繝ｪ繝励す繝ｧ繝ｳ諠・�ｱ繧貞・蜿門ｾ暦ｼ井ｽｿ逕ｨ蝗樊焚繧呈峩譁ｰ・・
                await this.refreshSubscriptionStatusSafe();

                // 逕ｻ髱｢繧貞・隱ｭ縺ｿ霎ｼ縺ｿ
                this.navigate('diff', id);

                // AI隗｣譫仙､ｱ謨励メ繧ｧ繝・け
                if (result.data.aiFailed) {
                    Notify.error('AI隗｣譫舌↓螟ｱ謨励＠縺ｾ縺励◆縲ょ茜逕ｨ蝗樊焚縺ｯ豸郁ｲｻ縺輔ｌ縺ｦ縺・∪縺帙ｓ縲ょ・蠎ｦ縺願ｩｦ縺励￥縺�縺輔＞縲・);
                } else {
                    Notify.success('AI隗｣譫舌′螳御ｺ・＠縺ｾ縺励◆・√Μ繧ｹ繧ｯ蛻､螳壹→蟾ｮ蛻・歓蜃ｺ縺悟ｮ御ｺ・＠縺ｾ縺励◆縲・);
                }
            } else {
                throw new Error(result.error || '隗｣譫舌↓螟ｱ謨励＠縺ｾ縺励◆');
            }

        } catch (error) {
            console.error('AI隗｣譫舌お繝ｩ繝ｼ:', error);
            if (error.code === 'ANALYSIS_LIMIT_EXCEEDED') {
                this.showAnalysisLimitError(error);
            } else {
                Notify.error(`AI隗｣譫蝉ｸｭ縺ｫ繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆: ${error.message}`);
            }
        }
    }

    uploadNewVersion(id) {
        if (!this.ensurePaymentAccess('譁ｰ縺励＞繝舌・繧ｸ繝ｧ繝ｳ隗｣譫・)) {
            return;
        }
        const contract = dbService.getContractById(id);
        if (!contract) {
            Notify.error('螂醍ｴ・′隕九▽縺九ｊ縺ｾ縺帙ｓ');
            return;
        }

        // URL蠖｢蠑上・蝣ｴ蜷医・URL蜈･蜉帙Δ繝ｼ繝繝ｫ繧定｡ｨ遉ｺ
        if (contract.source_url || contract.source_type === 'URL') {
            const urlModal = document.getElementById('url-input-modal');
            const urlInput = document.getElementById('new-version-url');
            const submitUrlBtn = document.getElementById('submit-url-btn');

            if (urlModal) {
                if (urlInput) urlInput.value = contract.source_url || "";
                if (submitUrlBtn) submitUrlBtn.setAttribute('data-contract-id', id);
                urlModal.classList.add('active');
            }
            return;
        }

        // 縺昴ｌ莉･螟厄ｼ・DF/Word・峨・繝輔ぃ繧､繝ｫ驕ｸ謚槭ム繧､繧｢繝ｭ繧ｰ繧定｡ｨ遉ｺ
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.pdf,.docx';

        // input.click() 繧偵ヨ繝ｪ繧ｬ繝ｼ縺吶ｋ蜑阪↓繧､繝吶Φ繝医ワ繝ｳ繝峨Λ繧定ｨｭ螳・
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const isPdf = file.name.toLowerCase().endsWith('.pdf');
            const isDocx = file.name.toLowerCase().endsWith('.docx');

            if (!isPdf && !isDocx) {
                Notify.warning('PDF縺ｾ縺溘・Word繝輔ぃ繧､繝ｫ繧帝∈謚槭＠縺ｦ縺上□縺輔＞');
                return;
            }

            const analysisMethod = isPdf ? 'pdf' : 'docx';
            const methodLabel = isPdf ? 'PDF' : 'Word';
            if (isPdf) {
                this.setRuntimePdfPreviewUrl(id, file);
            }

            const performAnalysis = async (retryCount = 0) => {
                try {
                    // 繝ｭ繝ｼ繝・ぅ繝ｳ繧ｰ陦ｨ遉ｺ
                    const loadingMsg = document.createElement('div');
                    loadingMsg.id = 'analysis-loading';
                    loadingMsg.style.cssText = 'position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); background:white; padding:30px; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.3); z-index:10000; text-align:center; min-width:300px;';
                    loadingMsg.innerHTML = `<div class="custom-loader"></div><br><strong>${methodLabel}繝峨く繝･繝｡繝ｳ繝医ｒ隗｣譫蝉ｸｭ...${retryCount > 0 ? '(蜀崎ｩｦ陦御ｸｭ)' : ''}</strong><br><span style="font-size:12px; color:#666;">繝・く繧ｹ繝医ョ繝ｼ繧ｿ縺ｨ繝ｬ繧､繧｢繧ｦ繝医ｒ謚ｽ蜃ｺ縺励※縺・∪縺・br>窶ｻ繧ｹ繧ｭ繝｣繝ｳ繝・・繧ｿ縺ｪ縺ｩ縺ｯ譎る俣縺後°縺九ｋ蝣ｴ蜷医′縺ゅｊ縺ｾ縺・/span>`;
                    document.body.appendChild(loadingMsg);

                    // 閭梧勹繧ｪ繝ｼ繝舌・繝ｬ繧､
                    let overlay = document.getElementById('analysis-overlay');
                    if (!overlay) {
                        overlay = document.createElement('div');
                        overlay.id = 'analysis-overlay';
                        overlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:9999;';
                        document.body.appendChild(overlay);
                    }

                    // UI謠冗判蠕・■
                    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 50)));

                    // 莠句燕縺ｫ繝医・繧ｯ繝ｳ繧偵Μ繝輔Ξ繝・す繝･・亥ｿｵ縺ｮ縺溘ａ・・
                    try {
                        const { getIdToken } = await import('./auth.js');
                        await getIdToken();
                        console.log("Token refreshed before upload");
                    } catch (e) {
                        console.warn("Token pre-refresh failed:", e);
                    }

                    // PDF繧達ase64縺ｫ螟画鋤
                    const base64Data = await aiService.convertFileToBase64(file);

                    // 譌ｧ繝舌・繧ｸ繝ｧ繝ｳ縺ｮ繝・く繧ｹ繝医ｒ蜿門ｾ・
                    const previousVersion = contract.original_content;
                    const isFirstUpload = !previousVersion;

                    // AI隗｣譫舌ｒ螳溯｡鯉ｼ亥燕繝舌・繧ｸ繝ｧ繝ｳ縺ｪ縺暦ｼ晏・蝗槫叙繧願ｾｼ縺ｿ縺ｯAI繧偵せ繧ｭ繝・・・・
                    const result = await aiService.analyzeContract(
                        id,
                        analysisMethod,
                        base64Data,
                        previousVersion,
                        isFirstUpload ? { skipAI: true } : {}
                    );

                    // 繝ｭ繝ｼ繝・ぅ繝ｳ繧ｰ蜑企勁
                    if (document.getElementById('analysis-loading')) document.getElementById('analysis-loading').remove();
                    if (document.getElementById('analysis-overlay')) document.getElementById('analysis-overlay').remove();

                    if (result.success) {
                        const extractedContent = resolveExtractedContentPayload(result.data);
                        if (!extractedContent) {
                            throw new Error('隗｣譫千ｵ先棡縺ｫ譛ｬ譁・ョ繝ｼ繧ｿ縺悟性縺ｾ繧後※縺・∪縺帙ｓ');
                        }
                        // 隗｣譫千ｵ先棡繧奪B縺ｫ菫晏ｭ・
                        const analysisPayload = {
                            extractedText: extractedContent,
                            rawExtractedText: result.data.rawExtractedText,
                            extractedTextHash: result.data.extractedTextHash,
                            extractedTextLength: result.data.extractedTextLength,
                            sourceType: result.data.sourceType,
                            pdfStoragePath: result.data.pdfStoragePath,
                            pdfUrl: result.data.pdfUrl,
                            status: '譛ｪ遒ｺ隱・,
                            originalFilename: file.name
                        };
                        // 蛻晏屓蜿悶ｊ霎ｼ縺ｿ縺ｯAI邨先棡縺ｪ縺励・蝗樒岼莉･髯阪・蟾ｮ蛻・・繝ｪ繧ｹ繧ｯ諠・�ｱ繧ゆｿ晏ｭ・
                        if (!isFirstUpload) {
                            analysisPayload.changes = result.data.changes;
                            analysisPayload.riskLevel = result.data.riskLevel;
                            analysisPayload.riskReason = result.data.riskReason;
                            analysisPayload.summary = result.data.summary;
                            analysisPayload.isFallback = result.data.isFallback === true;
                            analysisPayload.aiFailed = result.data.aiFailed === true;
                        }
                        dbService.updateContractAnalysis(id, analysisPayload);
                        if (!isFirstUpload) {
                            await this.refreshSubscriptionStatusSafe();
                        }

                        // 蛻晏屓蜿悶ｊ霎ｼ縺ｿ縺ｯ蜴滓悽蜈ｨ譁・ち繝悶・蝗樒岼莉･髯搾ｼ亥ｷｮ蛻・・螻･豁ｴ縺ゅｊ・峨・蟾ｮ蛻・ち繝・
                        const updatedContract = dbService.getContractById(id);
                        const hasHistory = updatedContract && updatedContract.history && updatedContract.history.length > 0;
                        this.activeDetailTab = hasHistory ? 'diff' : 'original';
                        this.syncLatestDocumentCompareState(id);
                        this.navigate('diff', id);

                        if (isFirstUpload) {
                            this.showToast('笨・蜿悶ｊ霎ｼ縺ｿ縺悟ｮ御ｺ・＠縺ｾ縺励◆', 'success', 5000);
                        } else {
                            // 驛ｨ蛻・噪縺ｪ螟ｱ謨暦ｼ・I隗｣譫舌・縺ｿ螟ｱ謨暦ｼ峨・繝√ぉ繝・け
                            const aiFailed = result.data.aiFailed || (result.data.riskReason && result.data.riskReason.includes("AI隗｣譫舌し繝ｼ繝舌・縺九ｉ縺ｮ蠢懃ｭ斐′縺ゅｊ縺ｾ縺帙ｓ縺ｧ縺励◆"));
                            if (aiFailed) {
                                if (await Notify.confirm('AI隗｣譫舌↓螟ｱ謨励＠縺ｾ縺励◆縲・n\n繝・く繧ｹ繝医ョ繝ｼ繧ｿ縺ｮ蜿悶ｊ霎ｼ縺ｿ縺ｯ螳御ｺ・＠縺ｾ縺励◆縺後、I縺ｫ繧医ｋ繝ｪ繧ｹ繧ｯ蛻､螳壹′縺ｧ縺阪∪縺帙ｓ縺ｧ縺励◆縲・n\n窶ｻ 隗｣譫仙､ｱ謨玲凾縺ｯ蛻ｩ逕ｨ蝗樊焚繧呈ｶ郁ｲｻ縺励∪縺帙ｓ縲・n繧ゅ≧荳蠎ｦ隗｣譫舌ｒ隧ｦ縺ｿ縺ｾ縺吶°・・, { title: '遒ｺ隱・, type: 'warning' })) {
                                    await performAnalysis(retryCount + 1);
                                    return;
                                } else {
                                    this.showToast('笞�・・隗｣譫舌・荳榊ｮ悟・縺ｧ縺吶′菫晏ｭ倥＠縺ｾ縺励◆', 'warning', 5000);
                                }
                            } else {
                                this.showToast(isPdf ? '笨・PDF縺ｮ蜿悶ｊ霎ｼ縺ｿ縺ｨ隗｣譫舌′螳御ｺ・＠縺ｾ縺励◆' : '笨・蟾ｮ蛻・ｧ｣譫舌′螳御ｺ・＠縺ｾ縺励◆', 'success', 5000);
                            }
                        }

                    } else {
                        const err = new Error(result.error || '隗｣譫舌↓螟ｱ謨励＠縺ｾ縺励◆');
                        if (result.error === 'ANALYSIS_LIMIT_EXCEEDED') {
                            err.code = 'ANALYSIS_LIMIT_EXCEEDED';
                            err.currentUsage = result.currentUsage;
                            err.limit = result.limit;
                            err.nextPlan = result.nextPlan;
                        }
                        throw err;
                    }

                } catch (error) {
                    console.error('AI隗｣譫舌お繝ｩ繝ｼ:', error);
                    if (document.getElementById('analysis-loading')) document.getElementById('analysis-loading').remove();
                    if (document.getElementById('analysis-overlay')) document.getElementById('analysis-overlay').remove();

                    let friendlyMsg = error.message;
                    if (friendlyMsg.includes('ADM-ZIP') || friendlyMsg.includes('zip format')) {
                        friendlyMsg = 'Word繝輔ぃ繧､繝ｫ縺ｮ隗｣譫舌↓螟ｱ謨励＠縺ｾ縺励◆縲よｭ｣蟶ｸ縺ｪWord繝峨く繝･繝｡繝ｳ繝・.docx)縺ｧ縺ゅｋ縺薙→繧堤｢ｺ隱阪＠縺ｦ縺上□縺輔＞縲・;
                    } else if (friendlyMsg.includes('譎る俣縺後°縺九ｊ縺吶℃') || friendlyMsg.includes('timeout') || friendlyMsg.includes('Timeout') || friendlyMsg.includes('Failed to fetch')) {
                        friendlyMsg = '蜿悶ｊ霎ｼ縺ｿ縺ｫ譎る俣縺後°縺九ｊ縺吶℃縺ｾ縺励◆縲ゅｂ縺・ｸ蠎ｦ縺願ｩｦ縺励￥縺�縺輔＞縲・;
                    } else if (friendlyMsg.includes('繝舌ャ繧ｯ繧ｨ繝ｳ繝陰PI') || friendlyMsg.includes('謗･邯壹〒縺阪∪縺帙ｓ')) {
                        friendlyMsg = '蜿悶ｊ霎ｼ縺ｿ縺ｫ螟ｱ謨励＠縺ｾ縺励◆縲ゅｂ縺・ｸ蠎ｦ縺願ｩｦ縺励￥縺�縺輔＞縲・;
                    }
                    if (error.code === 'ANALYSIS_LIMIT_EXCEEDED') {
                        this.showAnalysisLimitError(error);
                    } else if (await Notify.confirm(`隗｣譫蝉ｸｭ縺ｫ蝠城｡後′逋ｺ逕溘＠縺ｾ縺励◆:\n${friendlyMsg}\n\n繧ゅ≧荳蠎ｦ隧ｦ縺励∪縺吶°・歔, { title: '隗｣譫舌お繝ｩ繝ｼ', type: 'error' })) {
                        await performAnalysis(retryCount + 1);
                    }
                }
            };

            await performAnalysis();
        };

        // 繝輔ぃ繧､繝ｫ驕ｸ謚槭ム繧､繧｢繝ｭ繧ｰ繧定｡ｨ遉ｺ
        input.click();
    }

    /**
     * URL迚医・譁ｰ縺励＞繝舌・繧ｸ繝ｧ繝ｳ繧定ｧ｣譫舌＠縺ｦ菫晏ｭ・
     */
    async handleUrlVersionSubmit(id, url) {
        if (!this.can('operate_contract')) {
            Notify.warning('髢ｲ隕ｧ縺ｮ縺ｿ縺ｮ讓ｩ髯舌〒縺ｯ繝舌・繧ｸ繝ｧ繝ｳ譖ｴ譁ｰ繧貞ｮ溯｡後〒縺阪∪縺帙ｓ');
            return;
        }
        if (!this.ensurePaymentAccess('URL蟾ｮ蛻・ｧ｣譫・)) {
            return;
        }
        const urlModal = document.getElementById('url-input-modal');
        const contract = dbService.getContractById(id);

        const performUrlAnalysis = async (retryCount = 0) => {
            try {
                // 繝ｭ繝ｼ繝・ぅ繝ｳ繧ｰ陦ｨ遉ｺ
                const loadingMsg = document.createElement('div');
                loadingMsg.id = 'analysis-loading';
                loadingMsg.style.cssText = 'position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); background:white; padding:30px; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.3); z-index:10000; text-align:center; min-width:300px;';
                loadingMsg.innerHTML = `<div class="custom-loader"></div><br><strong>謖・ｮ壹＆繧後◆URL繧定ｧ｣譫蝉ｸｭ...${retryCount > 0 ? '(蜀崎ｩｦ陦御ｸｭ)' : ''}</strong><br><span style="font-size:12px; color:#666;">譛譁ｰ縺ｮ繧ｳ繝ｳ繝・Φ繝・ｒ蜿門ｾ励＠縺ｦ蟾ｮ蛻・ｒ謚ｽ蜃ｺ縺励※縺・∪縺・/span>`;
                document.body.appendChild(loadingMsg);

                // 閭梧勹繧ｪ繝ｼ繝舌・繝ｬ繧､
                let overlay = document.getElementById('analysis-overlay');
                if (!overlay) {
                    overlay = document.createElement('div');
                    overlay.id = 'analysis-overlay';
                    overlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:9999;';
                    document.body.appendChild(overlay);
                }

                if (urlModal) urlModal.classList.remove('active');

                // UI謠冗判蠕・■
                await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 50)));

                // AI隗｣譫舌ｒ螳溯｡鯉ｼ・RL繝｡繧ｽ繝・ラ・・
                const result = await aiService.analyzeContract(
                    id,
                    'url',
                    url,
                    contract.original_content // 譌ｧ繝舌・繧ｸ繝ｧ繝ｳ縺ｮ繝・く繧ｹ繝・
                );

                // 繝ｭ繝ｼ繝・ぅ繝ｳ繧ｰ蜑企勁
                if (document.getElementById('analysis-loading')) document.getElementById('analysis-loading').remove();
                if (document.getElementById('analysis-overlay')) document.getElementById('analysis-overlay').remove();

                if (result.success) {
                    const extractedContent = resolveExtractedContentPayload(result.data);
                    if (!extractedContent) {
                        throw new Error('隗｣譫千ｵ先棡縺ｫ譛ｬ譁・ョ繝ｼ繧ｿ縺悟性縺ｾ繧後※縺・∪縺帙ｓ');
                    }
                    // 隗｣譫千ｵ先棡繧奪B縺ｫ菫晏ｭ・
                    dbService.updateContractAnalysis(id, {
                        extractedText: extractedContent,
                        sourceUrl: url,
                        sourceType: 'URL',
                        changes: result.data.changes,
                        riskLevel: result.data.riskLevel,
                        riskReason: result.data.riskReason,
                        summary: result.data.summary,
                        isFallback: result.data.isFallback === true,
                        aiFailed: result.data.aiFailed === true,
                        status: '譛ｪ遒ｺ隱・
                    });

                    // 繧ｵ繝悶せ繧ｯ繝ｪ繝励す繝ｧ繝ｳ諠・�ｱ繧貞・蜿門ｾ暦ｼ井ｽｿ逕ｨ蝗樊焚繧呈峩譁ｰ・・
                    await this.refreshSubscriptionStatusSafe();

                    // 逕ｻ髱｢繧貞・隱ｭ縺ｿ霎ｼ縺ｿ (螻･豁ｴ縺後≠繧後・蟾ｮ蛻・∝・蝗槭↑繧牙次譛ｬ)
                    const updatedContract = dbService.getContractById(id);
                    const hasHistory = updatedContract && updatedContract.history && updatedContract.history.length > 0;
                    this.activeDetailTab = hasHistory ? 'diff' : 'original';
                    this.syncLatestDocumentCompareState(id);
                    this.navigate('diff', id);

                    if (result.data.aiFailed) {
                        Notify.error('AI隗｣譫舌↓螟ｱ謨励＠縺ｾ縺励◆縲ょ茜逕ｨ蝗樊焚縺ｯ豸郁ｲｻ縺輔ｌ縺ｦ縺・∪縺帙ｓ縲ょ・蠎ｦ縺願ｩｦ縺励￥縺�縺輔＞縲・);
                    } else {
                        Notify.success('譛譁ｰ繝舌・繧ｸ繝ｧ繝ｳ縺ｮ蜿悶ｊ霎ｼ縺ｿ縺ｨAI隗｣譫舌′螳御ｺ・＠縺ｾ縺励◆・・);
                    }
                } else {
                    const err = new Error(result.error || '隗｣譫舌↓螟ｱ謨励＠縺ｾ縺励◆');
                    if (result.error === 'ANALYSIS_LIMIT_EXCEEDED') {
                        err.code = 'ANALYSIS_LIMIT_EXCEEDED';
                        err.currentUsage = result.currentUsage;
                        err.limit = result.limit;
                        err.nextPlan = result.nextPlan;
                    }
                    throw err;
                }

            } catch (error) {
                console.error('URL AI Service Error:', error);
                if (document.getElementById('analysis-loading')) document.getElementById('analysis-loading').remove();
                if (document.getElementById('analysis-overlay')) document.getElementById('analysis-overlay').remove();

                let friendlyMsg = error.message;
                if (friendlyMsg.includes('ADM-ZIP') || friendlyMsg.includes('zip format')) {
                    friendlyMsg = 'Word繝輔ぃ繧､繝ｫ縺ｮ隱ｭ縺ｿ霎ｼ縺ｿ縺ｫ螟ｱ謨励＠縺ｾ縺励◆縲ゅヵ繧｡繧､繝ｫ縺檎�ｴ謳阪＠縺ｦ縺・ｋ縺九・撼蟇ｾ蠢懊・蠖｢蠑上〒縺ゅｋ蜿ｯ閭ｽ諤ｧ縺後≠繧翫∪縺吶・;
                }
                if (error.code === 'ANALYSIS_LIMIT_EXCEEDED') {
                    this.showAnalysisLimitError(error);
                } else if (await Notify.confirm(`隗｣譫蝉ｸｭ縺ｫ蝠城｡後′逋ｺ逕溘＠縺ｾ縺励◆:\n${friendlyMsg}\n\n繧ゅ≧荳蠎ｦ隧ｦ縺励∪縺吶°・歔, { title: '隗｣譫舌お繝ｩ繝ｼ', type: 'error' })) {
                    await performUrlAnalysis(retryCount + 1);
                }
            }
        };

        await performUrlAnalysis();
    }

    showSuccessModal(title, message) {
        // 譌｢蟄倥・繝｢繝繝ｫ縺後≠繧後・蜑企勁
        const existing = document.getElementById('success-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'success-modal';
        modal.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:11000; animation: fadeIn 0.3s;';

        modal.innerHTML = `
                    <div style="background:white; width:90%; max-width:450px; border-radius:12px; padding:32px; text-align:center; box-shadow:0 10px 40px rgba(0,0,0,0.1); animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);">
                        <div style="width:60px; height:60px; background:#f9f9f9; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 20px; color:#c5a059; font-size:30px;">
                            <i class="fa-solid fa-check"></i>
                        </div>
                        <h3 style="margin:0 0 12px; color:#24292E; font-size:20px; font-weight:700;">${title}</h3>
                        <p style="margin:0 0 24px; color:#586069; font-size:14px; line-height:1.6;">${message}</p>
                        <button class="btn-dashboard btn-primary-action" style="padding:10px 32px; font-size:14px;" onclick="document.getElementById('success-modal').remove()">OK</button>
                    </div>
                    `;
        document.body.appendChild(modal);

        // 繧｢繝九Γ繝ｼ繧ｷ繝ｧ繝ｳ逕ｨ繧ｹ繧ｿ繧､繝ｫ螳夂ｾｩ・医↑縺代ｌ縺ｰ霑ｽ蜉�・・
        if (!document.getElementById('modal-styles')) {
            const style = document.createElement('style');
            style.id = 'modal-styles';
            style.innerText = `
                    @keyframes fadeIn {from {opacity: 0; } to {opacity: 1; } }
                    @keyframes slideUp {from {transform: translateY(20px); opacity: 0; } to {transform: translateY(0); opacity: 1; } }
                    `;
            document.head.appendChild(style);
        }
    }

    addMemo(id) {
        const input = document.getElementById('modal-memo-input');
        if (input && input.value.trim()) {
            const contract = dbService.getContractById(id);
            dbService.addActivityLog(`Memo: ${input.value}`, contract.name);

            // 繝｢繝繝ｫ蜀・・繝ｪ繧ｹ繝医ｒ譖ｴ譁ｰ
            this.showHistoryModal(id);
        }
    }

    showHistoryModal(id) {
        const contract = dbService.getContractById(id);
        // system縺ｮ繝ｭ繧ｰ・郁・蜍慕函謌舌Ο繧ｰ・峨ｒ髯､螟悶＠縲√Θ繝ｼ繧ｶ繝ｼ縺ｮ繝｡繝｢繧・い繧ｯ繧ｷ繝ｧ繝ｳ縺ｮ縺ｿ繧定｡ｨ遉ｺ
        const logs = dbService.getActivityLogs().filter(l => l.target_name === contract.name && l.actor !== 'system');

        // 譌｢蟄倥・繝｢繝繝ｫ縺後≠繧後・蜑企勁
        const existing = document.getElementById('history-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'history-modal';
        modal.className = 'modal-overlay active';

        const logsHtml = logs.length > 0 ? logs.map(l => `
                    <div style="padding:12px; border-bottom:1px solid #eee;">
                        <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                            <span style="font-weight:600; font-size:12px; color:#333;">${l.actor}</span>
                            <span style="font-size:11px; color:#999;">${l.created_at}</span>
                        </div>
                        <div style="font-size:13px; color:#555;">${l.action}</div>
                    </div>
                    `).join('') : '<div style="padding:20px; text-align:center; color:#999;">螻･豁ｴ縺ｯ縺ゅｊ縺ｾ縺帙ｓ</div>';

        modal.innerHTML = `
                    <div class="modal-content" style="max-width:600px;">
                        <div class="modal-header">
                            <h3>繝｡繝｢</h3>
                            <button class="btn-close" onclick="document.getElementById('history-modal').remove()">&times;</button>
                        </div>
                        <div class="modal-body" style="padding:0;">
                            <div style="max-height:300px; overflow-y:auto; background:#f9f9f9;">
                                ${logsHtml}
                            </div>
                            <div style="padding:16px; border-top:1px solid #ddd; background:#fff;">
                                <textarea id="modal-memo-input" style="width:100%; border:1px solid #ddd; padding:10px; border-radius:4px; font-family:inherit; min-height:80px; resize:vertical; margin-bottom:10px;" placeholder="繝｡繝｢繧貞・蜉・.."></textarea>
                                <button class="btn-dashboard btn-primary-action" style="width:100%;" onclick="window.app.addMemo(${id})">繝｡繝｢繧定ｨ倬鹸</button>
                            </div>
                        </div>
                    </div>
                    `;
        document.body.appendChild(modal);
    }

    updateUserRole(email, newRole) {
        if (dbService.updateUserRole(email, newRole)) {
            console.log(`Role updated for ${email} to ${newRole} `);
        }
    }

    showLogDetails(logId) {
        const logs = dbService.getActivityLogs();
        const log = logs.find(l => l.id === logId);
        if (!log) return;

        const modalId = 'log-detail-modal';
        const existing = document.getElementById(modalId);
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = modalId;
        modal.classList.add('modal-overlay', 'active');
        modal.style.zIndex = '12000';

        let statusColor = '#586069';
        if (log.status === '謌仙粥') statusColor = '#28a745';
        else if (log.status === '螟ｱ謨・) statusColor = '#d73a49';
        else if (log.status === '繧ｹ繧ｭ繝・・') statusColor = '#005cc5';

        modal.innerHTML = `
                    <div class="modal-content" style="max-width: 500px; padding: 0; overflow: hidden; border-radius: 12px; border: none; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
                        <div style="background: #fafbfc; padding: 20px 24px; border-bottom: 1px solid #e1e4e8; display: flex; justify-content: space-between; align-items: center;">
                            <h3 style="margin: 0; font-size: 16px; color: #24292e; font-weight: 700;">繝ｭ繧ｰ隧ｳ邏ｰ・磯夢隕ｧ蟆ら畑・・/h3>
                            <button class="btn-close" onclick="document.getElementById('${modalId}').remove()">&times;</button>
                        </div>
                        <div style="padding: 24px;">
                            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                                <tr style="border-bottom: 1px solid #f6f8fa;">
                                    <td style="padding: 12px 0; color: #586069; width: 120px;">譌･譎・/td>
                                    <td style="padding: 12px 0; font-weight: 600;">${log.created_at}</td>
                                </tr>
                                <tr style="border-bottom: 1px solid #f6f8fa;">
                                    <td style="padding: 12px 0; color: #586069;">螳溯｡檎ｨｮ蛻･</td>
                                    <td style="padding: 12px 0; font-weight: 600;">${log.action}</td>
                                </tr>
                                <tr style="border-bottom: 1px solid #f6f8fa;">
                                    <td style="padding: 12px 0; color: #586069;">蟇ｾ雎｡</td>
                                    <td style="padding: 12px 0; font-weight: 600;">${log.target_name}</td>
                                </tr>
                                <tr style="border-bottom: 1px solid #f6f8fa;">
                                    <td style="padding: 12px 0; color: #586069;">螳溯｡瑚・/td>
                                    <td style="padding: 12px 0; font-weight: 600;">${log.actor}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 12px 0; color: #586069;">邨先棡繧ｹ繝・・繧ｿ繧ｹ</td>
                                    <td style="padding: 12px 0; font-weight: 600; color: ${statusColor};">
                                        <i class="fa-solid ${log.status === '謌仙粥' ? 'fa-circle-check' : (log.status === '螟ｱ謨・ ? 'fa-circle-xmark' : 'fa-circle-info')}" style="margin-right: 6px;"></i>
                                        ${log.status || '謌仙粥'}
                                    </td>
                                </tr>
                            </table>
                            <div style="margin-top: 24px; padding: 12px; background: #f8f9fa; border-radius: 6px; font-size: 12px; color: #586069; line-height: 1.5;">
                                <i class="fa-solid fa-circle-info"></i> 窶ｻ縺薙・逕ｻ髱｢縺ｯ險ｼ霍｡遒ｺ隱阪・縺ｿ蜿ｯ閭ｽ縺ｧ縺吶・I縺ｮ蜀榊ｮ溯｡後∝ｷｮ蛻・・蜀崎｡ｨ遉ｺ遲峨・鬮倥さ繧ｹ繝域桃菴懊・縺薙・逕ｻ髱｢縺九ｉ縺ｯ陦後∴縺ｾ縺帙ｓ縲ょｿ・ｦ√↑蝣ｴ蜷医・蜷・･醍ｴ・ュ蝣ｱ縺ｮ隧ｳ邏ｰ逕ｻ髱｢縺九ｉ謫堺ｽ懊＠縺ｦ縺上□縺輔＞縲・
                            </div>
                        </div>
                        <div style="padding: 16px 24px; background: #fafbfc; border-top: 1px solid #e1e4e8; text-align: right;">
                            <button class="btn-dashboard" onclick="document.getElementById('${modalId}').remove()" style="padding: 8px 24px;">髢峨§繧・/button>
                        </div>
                    </div>
                    `;

        document.body.appendChild(modal);

        // Handle click outside to close
        modal.onclick = (e) => {
            if (e.target === modal) modal.remove();
        };
    }

    // --- Team Management ---
    showInviteModal() {
        const users = dbService.getUsers();
        const limit = dbService.PLAN_LIMITS[this.userPlan] || 1;

        if (users.length >= limit) {
            const upgradeMessage = (this.userPlan === 'pro')
                ? '縺輔ｉ縺ｫ繝｡繝ｳ繝舌・繧定ｿｽ蜉�縺吶ｋ縺ｫ縺ｯ縲∵ｳ穂ｺｺ蜷代￠蛟句挨繧ｨ繝ｳ繧ｿ繝ｼ繝励Λ繧､繧ｺ繝励Λ繝ｳ縺ｮ縺皮嶌隲・ｒ謇ｿ繧翫∪縺吶ゅし繝昴・繝医∪縺ｧ縺雁撫縺・粋繧上○縺上□縺輔＞縲・
                : '縺輔ｉ縺ｫ繝｡繝ｳ繝舌・繧定ｿｽ蜉�縺吶ｋ縺ｫ縺ｯ繝励Λ繝ｳ繧偵い繝・・繧ｰ繝ｬ繝ｼ繝峨＠縺ｦ縺上□縺輔＞縲・;

            this.showAlertModal(
                '莠ｺ謨ｰ蛻ｶ髯・,
                `迴ｾ蝨ｨ縺ｮ繝励Λ繝ｳ・・{this.userPlan}・峨〒縺ｯ縲∵怙螟ｧ${limit}蜷阪∪縺ｧ縺励°逋ｻ骭ｲ縺ｧ縺阪∪縺帙ｓ縲・br>${upgradeMessage}`,
                'warning'
            );
            return;
        }

        document.getElementById('invite-name').value = '';
        document.getElementById('invite-email').value = '';
        document.getElementById('invite-role').value = '髢ｲ隕ｧ縺ｮ縺ｿ';
        document.getElementById('invite-member-modal').classList.add('active');
    }

    showBusinessFeatureModal() {
        const existing = document.getElementById('business-upgrade-modal');
        if (existing) existing.remove();
        const modal = document.createElement('div');
        modal.id = 'business-upgrade-modal';
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:11000;animation:fadeIn 0.3s;';
        modal.innerHTML = `
            <div style="background:white;width:90%;max-width:420px;border-radius:12px;padding:32px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,0.2);animation:slideUp 0.3s cubic-bezier(0.16,1,0.3,1);">
                <div style="width:60px;height:60px;background:#f3f0ea;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;color:#c5a059;font-size:28px;">
                    <i class="fa-solid fa-crown"></i>
                </div>
                <div style="display:inline-block;background:#f3f0ea;color:#c5a059;border:1px solid #e8d9b8;border-radius:10px;padding:3px 12px;font-size:11px;font-weight:700;margin-bottom:12px;">Business / Pro繝励Λ繝ｳ髯仙ｮ・/div>
                <h3 style="margin:0 0 12px;color:#24292E;font-size:18px;font-weight:700;">譛滄剞繝ｻ繧｢繝ｩ繝ｼ繝育ｮ｡逅・/h3>
                <p style="margin:0 0 24px;color:#586069;font-size:13px;line-height:1.7;">螂醍ｴ・悄髯舌・閾ｪ蜍墓歓蜃ｺ繝ｻ繧｢繝ｩ繝ｼ繝磯夂衍縺ｯBusiness繝励Λ繝ｳ莉･荳翫〒縺泌茜逕ｨ縺・◆縺�縺代∪縺吶・/p>
                <div style="display:flex;gap:10px;">
                    <button style="flex:1;padding:10px;border:1px solid #ddd;border-radius:8px;background:#fff;color:#666;font-size:13px;cursor:pointer;" onclick="document.getElementById('business-upgrade-modal').remove()">髢峨§繧・/button>
                    <button style="flex:1;padding:10px;border:none;border-radius:8px;background:#c5a059;color:#fff;font-size:13px;font-weight:700;cursor:pointer;" onclick="document.getElementById('business-upgrade-modal').remove();window.app.navigate('plan')">繝励Λ繝ｳ繧定ｦ九ｋ</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    }

    showProFeatureModal(message) {
        const existing = document.getElementById('pro-upgrade-modal');
        if (existing) existing.remove();
        const modal = document.createElement('div');
        modal.id = 'pro-upgrade-modal';
        modal.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:11000; animation: fadeIn 0.3s;';
        modal.innerHTML = `
            <div style="background:white; width:90%; max-width:420px; border-radius:12px; padding:32px; text-align:center; box-shadow:0 10px 40px rgba(0,0,0,0.2); animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);">
                <div style="width:60px; height:60px; background:#f3f0ea; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 20px; color:#c5a059; font-size:28px;">
                    <i class="fa-solid fa-satellite-dish"></i>
                </div>
                <div style="display:inline-block; background:#f3f0ea; color:#c5a059; border:1px solid #e8d9b8; border-radius:10px; padding:3px 12px; font-size:11px; font-weight:700; margin-bottom:12px;">Pro繝励Λ繝ｳ髯仙ｮ・/div>
                <h3 style="margin:0 0 12px; color:#24292E; font-size:18px; font-weight:700;">螳壽悄URL逶｣隕悶・Slack・上Γ繝ｼ繝ｫ騾夂衍</h3>
                <p style="margin:0 0 24px; color:#586069; font-size:13px; line-height:1.7;">${message}</p>
                <div style="display:flex; gap:10px;">
                    <button style="flex:1; padding:10px; border:1px solid #ddd; border-radius:8px; background:#fff; color:#666; font-size:13px; cursor:pointer;" onclick="document.getElementById('pro-upgrade-modal').remove()">髢峨§繧・/button>
                    <button style="flex:1; padding:10px; border:none; border-radius:8px; background:#c5a059; color:#fff; font-size:13px; font-weight:700; cursor:pointer;" onclick="document.getElementById('pro-upgrade-modal').remove(); window.app.registration?.close(); window.app.navigate('plan')">Pro繝励Λ繝ｳ繧定ｦ九ｋ</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    }

    showAlertModal(title, message, type = 'error') {
        const existing = document.getElementById('alert-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'alert-modal';
        modal.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:11000; animation: fadeIn 0.3s;';

        const iconColor = type === 'error' ? '#dc3545' : '#ffc107';
        const iconClass = type === 'error' ? 'fa-circle-xmark' : 'fa-triangle-exclamation';
        const bgColor = type === 'error' ? '#fde8e8' : '#fff3cd';

        modal.innerHTML = `
                        <div style="background:white; width:90%; max-width:450px; border-radius:12px; padding:32px; text-align:center; box-shadow:0 10px 40px rgba(0,0,0,0.2); animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);">
                            <div style="width:60px; height:60px; background:${bgColor}; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 20px; color:${iconColor}; font-size:30px;">
                                <i class="fa-solid ${iconClass}"></i>
                            </div>
                            <h3 style="margin:0 0 12px; color:#24292E; font-size:20px; font-weight:700;">${title}</h3>
                            <p style="margin:0 0 24px; color:#586069; font-size:14px; line-height:1.6;">${message}</p>
                            <button class="btn-dashboard btn-primary-action" style="padding:10px 32px; font-size:14px;" onclick="document.getElementById('alert-modal').remove()">OK</button>
                        </div>
                        `;
        document.body.appendChild(modal);
    }

    async submitInvite() {
        const name = document.getElementById('invite-name').value;
        const email = document.getElementById('invite-email').value;
        const role = document.getElementById('invite-role').value;

        if (!name || !email) {
            Notify.warning('蜷榊燕縺ｨ繝｡繝ｼ繝ｫ繧｢繝峨Ξ繧ｹ繧貞・蜉帙＠縺ｦ縺上□縺輔＞');
            return;
        }

        const result = dbService.addUser(name, email, role, this.userPlan);

        if (result.success) {
            document.getElementById('invite-member-modal').classList.remove('active');
            this.navigate('team');

            // Send Email via Backend
            try {
                const inviteResult = await aiService.sendInvite(email, name, role);
                if (inviteResult.emailSent) {
                    this.showSuccessModal('諡帛ｾ・∽ｿ｡螳御ｺ・, '繝｡繝ｳ繝舌・繧定ｿｽ蜉�縺励∵魚蠕・Γ繝ｼ繝ｫ繧帝∽ｿ｡縺励∪縺励◆縲・);
                } else {
                    this.showSuccessModal('繝｡繝ｳ繝舌・霑ｽ蜉�螳御ｺ・, `${name} 縺輔ｓ繧偵メ繝ｼ繝�縺ｫ霑ｽ蜉�縺励∪縺励◆縲・br><br><small style="color:#888;">窶ｻ 繝｡繝ｼ繝ｫ騾夂衍縺ｯ迴ｾ蝨ｨ險ｭ螳壹＆繧後※縺・∪縺帙ｓ縲・br>諡帛ｾ・・縺ｫ逶ｴ謗･繝繝・す繝･繝懊・繝蔚RL繧偵♀莨昴∴縺上□縺輔＞縲・/small>`);
                }
            } catch (error) {
                console.error('Email send failed:', error);
                this.showSuccessModal('繝｡繝ｳ繝舌・霑ｽ蜉�螳御ｺ・, `${name} 縺輔ｓ繧偵メ繝ｼ繝�縺ｫ霑ｽ蜉�縺励∪縺励◆縲・br><br><small style="color:#888;">窶ｻ 諡帛ｾ・Γ繝ｼ繝ｫ縺ｮ騾∽ｿ｡縺ｫ螟ｱ謨励＠縺ｾ縺励◆縲・br>諡帛ｾ・・縺ｫ逶ｴ謗･繝繝・す繝･繝懊・繝蔚RL繧偵♀莨昴∴縺上□縺輔＞縲・/small>`);
            }
        } else {
            if (result.error === 'already_exists') {
                this.showAlertModal('逋ｻ骭ｲ繧ｨ繝ｩ繝ｼ', '縺薙・繝｡繝ｼ繝ｫ繧｢繝峨Ξ繧ｹ縺ｯ譌｢縺ｫ逋ｻ骭ｲ縺輔ｌ縺ｦ縺・∪縺吶・br>蛻･縺ｮ繝｡繝ｼ繝ｫ繧｢繝峨Ξ繧ｹ繧剃ｽｿ逕ｨ縺吶ｋ縺九∵里蟄倥・繝｡繝ｳ繝舌・繧堤ｷｨ髮・＠縺ｦ縺上□縺輔＞縲・);
            } else if (result.error === 'limit_reached') {
                const upgradeMsg = (this.userPlan === 'pro')
                    ? '縺輔ｉ縺ｫ繝｡繝ｳ繝舌・繧定ｿｽ蜉�縺吶ｋ縺ｫ縺ｯ縲∵ｳ穂ｺｺ蜷代￠蛟句挨繧ｨ繝ｳ繧ｿ繝ｼ繝励Λ繧､繧ｺ繝励Λ繝ｳ縺ｮ縺皮嶌隲・ｒ縺雁女縺代＠縺ｾ縺吶・
                    : '縺輔ｉ縺ｫ繝｡繝ｳ繝舌・繧貞｢励ｄ縺吶↓縺ｯ縲∽ｸ贋ｽ阪・繝ｩ繝ｳ縺ｸ縺ｮ繧｢繝・・繧ｰ繝ｬ繝ｼ繝峨ｒ縺疲､懆ｨ弱￥縺�縺輔＞縲・;

                this.showAlertModal(
                    '逋ｻ骭ｲ繧ｨ繝ｩ繝ｼ',
                    `莠ｺ謨ｰ蛻ｶ髯撰ｼ・{result.limit}蜷搾ｼ峨↓驕斐＠縺ｾ縺励◆縲・{upgradeMsg}`,
                    'error'
                );
            } else {
                this.showAlertModal('逋ｻ骭ｲ繧ｨ繝ｩ繝ｼ', '繝｡繝ｳ繝舌・縺ｮ霑ｽ蜉�縺ｫ螟ｱ謨励＠縺ｾ縺励◆縲・);
            }
        }
    }

    showEditMemberModal(email) {
        const users = dbService.getUsers();
        const user = users.find(u => u.email === email);
        if (user) {
            document.getElementById('edit-original-email').value = user.email;
            // If name is same as email (default), show placeholder or empty
            document.getElementById('edit-name').value = (user.name === user.email) ? '' : user.name;
            document.getElementById('edit-email').value = user.email;
            document.getElementById('edit-role').value = user.role;

            // Protect current user from deletion
            const deleteBtn = document.querySelector('#edit-member-modal .btn-danger-action');
            if (this.currentUser && user.email === this.currentUser.email) {
                deleteBtn.style.display = 'none';
                // Optional: Disable role change for self to prevent lockout
                document.getElementById('edit-role').disabled = true;
            } else {
                deleteBtn.style.display = 'block';
                document.getElementById('edit-role').disabled = false;
            }

            document.getElementById('edit-member-modal').classList.add('active');
        }
    }

    updateMember() {
        const originalEmail = document.getElementById('edit-original-email').value;
        const name = document.getElementById('edit-name').value;
        const role = document.getElementById('edit-role').value;

        if (dbService.updateUser(originalEmail, { name, role })) {
            document.getElementById('edit-member-modal').classList.remove('active');
            this.navigate('team');
        } else {
            Notify.error('譖ｴ譁ｰ縺ｫ螟ｱ謨励＠縺ｾ縺励◆');
        }
    }

    deleteMember() {
        const email = document.getElementById('edit-original-email').value;

        // Final safeguard against self-deletion
        if (this.currentUser && email === this.currentUser.email) {
            Notify.warning('閾ｪ蛻・・霄ｫ縺ｮ繧｢繧ｫ繧ｦ繝ｳ繝医・蜑企勁縺ｧ縺阪∪縺帙ｓ縲・);
            return;
        }

        // Just show the confirmation modal
        document.getElementById('delete-confirm-modal').classList.add('active');
    }

    executeDeleteMember() {
        const email = document.getElementById('edit-original-email').value;
        if (dbService.deleteUser(email)) {
            document.getElementById('delete-confirm-modal').classList.remove('active'); // Close confirm modal
            document.getElementById('edit-member-modal').classList.remove('active');   // Close edit modal
            this.navigate('team');
        } else {
            Notify.error('蜑企勁縺ｫ螟ｱ謨励＠縺ｾ縺励◆・育ｮ｡逅・・・蜑企勁縺ｧ縺阪↑縺・�ｴ蜷医′縺ゅｊ縺ｾ縺呻ｼ・);
            document.getElementById('delete-confirm-modal').classList.remove('active');
        }
    }

    /**
     * 螳壽悄逶｣隕悶・ON/OFF繧貞・繧頑崛縺医ｋ
     */
    toggleMonitoring(id, enabled) {
        if (!this.can('operate_contract')) {
            Notify.warning('髢ｲ隕ｧ縺ｮ縺ｿ縺ｮ讓ｩ髯舌〒縺ｯ逶｣隕冶ｨｭ螳壹ｒ螟画峩縺ｧ縺阪∪縺帙ｓ');
            return;
        }
        if (enabled && this.subscription?.plan !== 'pro') {
            this.showAlertModal('繝励Λ繝ｳ蛻ｶ髯・, '螳壽悄URL逶｣隕厄ｼ郁・蜍輔メ繧ｧ繝・け・峨・Pro繝励Λ繝ｳ髯仙ｮ壹・讖溯・縺ｧ縺吶・, 'warning');
            return;
        }
        dbService.toggleMonitoring(id, enabled);
        this.navigate('diff', id);
    }

    /**
     * 謇句虚繧ｯ繝ｭ繝ｼ繝ｪ繝ｳ繧ｰ繧貞ｮ溯｡・
     */
    async manualCrawl(id) {
        const contract = dbService.getContractById(id);
        if (!contract || !contract.source_url) return;
        const count = Number(this.subscription?.usageCount || 0);
        const limit = Number(this.subscription?.usageLimit || 0);
        if (count >= limit) {
            this.showAnalysisLimitError({ currentUsage: count, limit: limit });
            return;
        }
        try {
            Notify.info('URL繧偵メ繧ｧ繝・け縺励※縺・∪縺・..');

            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();

            const response = await fetch(`${aiService.API_BASE}/crawl`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    url: contract.source_url,
                    lastHash: contract.last_hash
                })
            });

            const result = await response.json();
            // loading complete

            if (result.success) {
                dbService.updateCrawlResult(id, result);

                if (result.changed) {
                    if (await Notify.confirm('譖ｴ譁ｰ・亥ｷｮ蛻・ｼ峨′讀懃衍縺輔ｌ縺ｾ縺励◆縲・I隗｣譫舌ｒ螳溯｡後＠縺ｦ蜀・ｮｹ繧堤｢ｺ隱阪＠縺ｾ縺吶°・歃n・郁ｧ｣譫仙屓謨ｰ繧・蝗樊ｶ郁ｲｻ縺励∪縺呻ｼ・, { title: '遒ｺ隱・, type: 'info' })) {
                        await this.performAIAnalysis(id);
                    } else {
                        this.navigate('diff', id);
                    }
                } else {
                    Notify.info('譖ｴ譁ｰ縺ｯ縺ゅｊ縺ｾ縺帙ｓ縺ｧ縺励◆縲・);
                    this.navigate('diff', id);
                }
            } else {
                throw new Error(result.error || '繧ｯ繝ｭ繝ｼ繝ｪ繝ｳ繧ｰ縺ｫ螟ｱ謨励＠縺ｾ縺励◆');
            }
        } catch (error) {
            // loading complete
            console.error('Manual Crawl Error:', error);
            Notify.error('繧ｨ繝ｩ繝ｼ: ' + error.message);
        }
    }

    /**
     * AI隗｣譫舌ｒ螳溯｡鯉ｼ亥・騾壹Ο繧ｸ繝・け・・
     */
    async performAIAnalysis(id) {
        if (!this.ensurePaymentAccess('蟾ｮ蛻・ｧ｣譫・)) {
            return;
        }
        const contract = dbService.getContractById(id);
        const fbModule = await import('./firebase-config.js');
        const user = fbModule.auth.currentUser;

        if (!user) {
            Notify.warning('繧ｻ繝・す繝ｧ繝ｳ縺悟・繧後∪縺励◆縲ょ・繝ｭ繧ｰ繧､繝ｳ縺励※縺上□縺輔＞縲・);
            return;
        }

        const count = Number(this.subscription?.usageCount || 0);
        const limit = Number(this.subscription?.usageLimit || 0);
        if (count >= limit) {
            this.showAnalysisLimitError({ currentUsage: count, limit: limit });
            return;
        }

        try {
            Notify.info('AI隗｣譫舌ｒ螳溯｡御ｸｭ...');
            const idToken = await fbModule.auth.currentUser.getIdToken();

            // 螻･豁ｴ逕ｨ縺ｮ蜑阪ヰ繝ｼ繧ｸ繝ｧ繝ｳ蜀・ｮｹ繧貞叙蠕・
            const previousVersion = contract.original_content;

            const response = await fetch(`${aiService.API_BASE}/contracts/analyze`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${idToken}`
                },
                body: JSON.stringify({
                    contractId: contract.id,
                    method: 'url',
                    source: contract.source_url,
                    previousVersion: previousVersion
                })
            });

            const resData = await response.json();
            // loading complete

            if (resData.success) {
                dbService.updateContractAnalysis(id, resData.data);
                await this.refreshSubscriptionStatusSafe();
                this.navigate('diff', id);
            } else {
                const err = new Error(resData.error || '隗｣譫舌↓螟ｱ謨励＠縺ｾ縺励◆');
                if (resData.error === 'ANALYSIS_LIMIT_EXCEEDED') {
                    err.code = 'ANALYSIS_LIMIT_EXCEEDED';
                    err.currentUsage = resData.currentUsage;
                    err.limit = resData.limit;
                    err.nextPlan = resData.nextPlan;
                }
                throw err;
            }
        } catch (error) {
            console.error('AI Analysis Error:', error);
            if (error.code === 'ANALYSIS_LIMIT_EXCEEDED') {
                this.showAnalysisLimitError(error);
            } else {
                Notify.error(`AI隗｣譫蝉ｸｭ縺ｫ繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆: ${error.message}`);
            }
        }
    }




    async compareHistoryWithBase(contractId, version) {
        const contract = dbService.getContractById(contractId);
        if (!contract || !Array.isArray(contract.history)) return;

        const historyItem = contract.history.find((h) => h.version === version);
        if (!historyItem) return;

        const previousLabel = buildComparisonLabel(
            historyItem.original_filename || contract.original_filename || contract.name,
            historyItem.date,
            '豈碑ｼ・・雉・侭'
        );
        const currentLabel = buildComparisonLabel(
            contract.original_filename || contract.name,
            contract.last_analyzed_at || contract.last_updated_at,
            'BASE雉・侭'
        );

        const confirmed = await Notify.confirm(
            `BASE雉・侭縺ｨ縺ｮ豈碑ｼ・ｧ｣譫舌ｒ螳溯｡後＠縺ｾ縺吶°・・br><br><strong>豈碑ｼ・・:</strong> ${escapeHtmlText(previousLabel)}<br><strong>豈碑ｼ・・:</strong> ${escapeHtmlText(currentLabel)}<br><br>隗｣譫仙ｾ後・縺薙・豈碑ｼ・ｰら畑縺ｮ蟾ｮ蛻・判髱｢繧定｡ｨ遉ｺ縺励∪縺吶Ａ,
            { title: '豈碑ｼ・ｧ｣譫舌・遒ｺ隱・, type: 'info', okText: '隗｣譫舌☆繧・, cancelText: '繧ｭ繝｣繝ｳ繧ｻ繝ｫ' }
        );
        if (!confirmed) return;

        const comparisonContext = {
            contractId,
            historyVersion: version,
            historyItem,
            previousLabel,
            currentLabel
        };

        const sourceType = String(contract?.source_type || '').toUpperCase();
        const isPdfSource = sourceType === 'PDF' || (contract?.original_filename || '').toLowerCase().endsWith('.pdf');
        const isWordSource = isWordDocumentFilename(contract?.original_filename || '');

        try {
            Notify.info('豈碑ｼ・ｧ｣譫舌ｒ螳溯｡御ｸｭ...');
            let requestedRemoteAnalysis = false;

            if (contract.source_url) {
                requestedRemoteAnalysis = true;
                const result = await aiService.analyzeContract(contractId, 'url', contract.source_url, historyItem.content);
                if (!result.success) throw new Error(result.error || '豈碑ｼ・ｧ｣譫舌↓螟ｱ謨励＠縺ｾ縺励◆');
                comparisonContext.analysis = result.data;
            } else if (isPdfSource) {
                const pdfUrl = this.getRuntimePdfPreviewUrl(contractId) || contract.pdf_url;
                if (!pdfUrl) {
                    comparisonContext.analysisNotice = 'PDF蜴滓悽縺御ｿ晄戟縺輔ｌ縺ｦ縺・↑縺・◆繧√、I蜀崎ｧ｣譫舌・陦後ｏ縺壽ｯ碑ｼ・｡ｨ遉ｺ縺ｮ縺ｿ陦後＞縺ｾ縺吶・;
                } else {
                    const response = await fetch(pdfUrl);
                    if (!response.ok) throw new Error('PDF蜴滓悽縺ｮ蜿門ｾ励↓螟ｱ謨励＠縺ｾ縺励◆');
                    const blob = await response.blob();
                    const file = new File([blob], contract.original_filename || 'contract.pdf', { type: blob.type || 'application/pdf' });
                    const base64 = await aiService.convertFileToBase64(file);
                    requestedRemoteAnalysis = true;
                    const result = await aiService.analyzeContract(contractId, 'pdf', base64, historyItem.content);
                    if (!result.success) throw new Error(result.error || '豈碑ｼ・ｧ｣譫舌↓螟ｱ謨励＠縺ｾ縺励◆');
                    comparisonContext.analysis = result.data;
                }
            } else if (isWordSource) {
                comparisonContext.analysisNotice = 'Word蜴滓悽縺ｯ蜀榊叙蠕励〒縺阪↑縺・◆繧√、I蜀崎ｧ｣譫舌・陦後ｏ縺壽ｯ碑ｼ・｡ｨ遉ｺ縺ｮ縺ｿ陦後＞縺ｾ縺吶・;
            } else {
                comparisonContext.analysisNotice = '縺薙・雉・侭蠖｢蠑上〒縺ｯ蜀崎ｧ｣譫舌〒縺阪↑縺・◆繧√∵ｯ碑ｼ・｡ｨ遉ｺ縺ｮ縺ｿ陦後＞縺ｾ縺吶・;
            }

            if (requestedRemoteAnalysis) {
                await this.refreshSubscriptionStatusSafe();
            }
            this.setHistoryComparisonContext(comparisonContext);
            this.activeDetailTab = 'diff';
            await this.navigate('diff', contractId);
        } catch (error) {
            console.error('History comparison error:', error);
            Notify.error(`豈碑ｼ・ｧ｣譫舌↓螟ｱ謨励＠縺ｾ縺励◆: ${error.message}`);
        }
    }

    async handleDocumentCompareChange(contractId, field, value) {
        const docs = dbService.getDocumentsByContractId(contractId);
        const currentState = this.getDocumentCompareState(contractId) || {};
        const nextState = {
            contractId,
            docAId: field === 'docA' ? value : (currentState.docAId || ''),
            docBId: field === 'docB' ? value : (currentState.docBId || '')
        };

        if (nextState.docAId && nextState.docAId === nextState.docBId) {
            Notify.warning('豈碑ｼ・・縺ｨ豈碑ｼ・・縺ｫ縺ｯ蛻･縺ｮ譁・嶌繧帝∈謚槭＠縺ｦ縺上□縺輔＞縲・);
            return;
        }

        this.clearHistoryComparisonContext(contractId);
        this.setDocumentCompareState(nextState);

        if (!nextState.docAId || !nextState.docBId) {
            this.navigate('diff', contractId);
            return;
        }

        const sourceDoc = docs.find((doc) => doc.id === nextState.docAId);
        const targetDoc = docs.find((doc) => doc.id === nextState.docBId);
        if (!sourceDoc || !targetDoc) {
            Notify.error('驕ｸ謚槭＠縺滓枚譖ｸ縺瑚ｦ九▽縺九ｊ縺ｾ縺帙ｓ縲・);
            return;
        }

        const cached = dbService.getDiffResult(sourceDoc.id, targetDoc.id);
        const structuredFallbackAnalysis = buildStructuredFallbackAnalysis(sourceDoc.content, targetDoc.content);
        const hasStructuredDifferences = Boolean(structuredFallbackAnalysis?.changes?.length);
        const hasFallbackNoDiffCache = hasStructuredDifferences
            && cached?.diff_data?.isFallback === true
            && isExplicitNoDiffAnalysis(cached?.diff_data);
        const storedAnalysis = buildStoredContractAnalysis(dbService.getContractById(contractId));
        const canHydrateFromStoredAnalysis = isCurrentVsLatestHistoryPair(docs, sourceDoc, targetDoc)
            && isMeaningfulAnalysisPayload(storedAnalysis)
            && storedAnalysis?.isFallback !== true;
        if (isLocalDashboardMode()) {
            await this.analyzeDocumentPair(contractId, sourceDoc, targetDoc, { force: true, silent: true, auto: true });
            return;
        }
        if (cached && isReusableAnalysisPayload(cached.diff_data) && !hasFallbackNoDiffCache) {
            dbService.touchRecentDiff(sourceDoc.id, targetDoc.id);
            this.navigate('diff', contractId);
            return;
        }
        if (canHydrateFromStoredAnalysis) {
            const contract = dbService.getContractById(contractId);
            dbService.saveDiffResult({
                docA_id: sourceDoc.id,
                docB_id: targetDoc.id,
                diff_data: buildStoredContractAnalysis(contract),
                created_at: new Date().toISOString()
            });
            dbService.touchRecentDiff(sourceDoc.id, targetDoc.id);
            this.navigate('diff', contractId);
            return;
        }
        if (structuredFallbackAnalysis && Array.isArray(structuredFallbackAnalysis.changes) && structuredFallbackAnalysis.changes.length > 0) {
            if (isCurrentVsLatestHistoryPair(docs, sourceDoc, targetDoc)) {
                dbService.updateContractAnalysis(contractId, {
                    summary: structuredFallbackAnalysis.summary,
                    riskLevel: structuredFallbackAnalysis.riskLevel,
                    riskReason: structuredFallbackAnalysis.riskReason,
                    changes: structuredFallbackAnalysis.changes,
                    isFallback: true,
                    status: '譛ｪ遒ｺ隱・
                });
            }
            dbService.saveDiffResult({
                docA_id: sourceDoc.id,
                docB_id: targetDoc.id,
                diff_data: {
                    ...structuredFallbackAnalysis,
                    riskReason: structuredFallbackAnalysis.riskReason || '螟画峩轤ｹ繧定｡ｨ遉ｺ縺励※縺・∪縺・,
                    isFallback: true
                },
                created_at: new Date().toISOString()
            });
            dbService.touchRecentDiff(sourceDoc.id, targetDoc.id);
            this.navigate('diff', contractId);
            return;
        }

        this.navigate('diff', contractId);
    }

    async runSelectedPairAnalysis(contractId) {
        if (!this.can('operate_contract')) {
            Notify.warning('髢ｲ隕ｧ縺ｮ縺ｿ縺ｮ讓ｩ髯舌〒縺ｯ隗｣譫舌ｒ螳溯｡後〒縺阪∪縺帙ｓ');
            return;
        }
        const docs = dbService.getDocumentsByContractId(contractId);
        const compareState = this.getDocumentCompareState(contractId) || {};
        const fallbackSourceDoc = docs.length >= 2 ? docs[docs.length - 2] : null;
        const fallbackTargetDoc = docs.length >= 1 ? docs[docs.length - 1] : null;
        const sourceDoc = docs.find((doc) => doc.id === compareState.docAId) || fallbackSourceDoc;
        const targetDoc = docs.find((doc) => doc.id === compareState.docBId) || fallbackTargetDoc;

        if (!sourceDoc || !targetDoc || sourceDoc.id === targetDoc.id) {
            Notify.warning('豈碑ｼ・・縺ｨ豈碑ｼ・・繧帝∈謚槭＠縺ｦ縺上□縺輔＞縲・);
            return;
        }

        const confirmed = await Notify.confirm(
            `驕ｸ謚樔ｸｭ縺ｮ2譁・嶌縺ｫ蟇ｾ縺励※AI蟾ｮ蛻・ｧ｣譫舌ｒ螳溯｡後＠縺ｾ縺吶°・・br><br><strong>豈碑ｼ・・:</strong> ${escapeHtmlText(buildDocumentOptionLabel(sourceDoc))}<br><strong>豈碑ｼ・・:</strong> ${escapeHtmlText(buildDocumentOptionLabel(targetDoc))}`,
            { title: '隗｣譫宣幕蟋・, type: 'info', okText: '隗｣譫宣幕蟋・, cancelText: '繧ｭ繝｣繝ｳ繧ｻ繝ｫ' }
        );
        if (!confirmed) return;

        await this.analyzeDocumentPair(contractId, sourceDoc, targetDoc, { force: true });
    }

    async analyzeDocumentPair(contractId, sourceDoc, targetDoc, options = {}) {
        const contract = dbService.getContractById(contractId);
        if (!contract || !sourceDoc || !targetDoc) return;
        const force = options.force === true;
        const silent = options.silent === true;
        const docs = dbService.getDocumentsByContractId(contractId);
        const storedContractAnalysis = buildStoredContractAnalysis(contract);
        const structuredFallbackAnalysis = buildStructuredFallbackAnalysis(sourceDoc.content, targetDoc.content);
        const hasStructuredDifferences = Boolean(structuredFallbackAnalysis?.changes?.length);
        const canReuseStoredAnalysis = !force
            && isCurrentVsLatestHistoryPair(docs, sourceDoc, targetDoc)
            && isMeaningfulAnalysisPayload(storedContractAnalysis)
            && storedContractAnalysis?.isFallback !== true;

        const diffPayload = {
            summary: '驕ｸ謚槭＠縺・譁・嶌縺ｮ蟾ｮ蛻・ｵ先棡縺ｧ縺吶・,
            riskLevel: 1,
            riskReason: '蟾ｮ蛻・歓蜃ｺ貂医∩',
            changes: []
        };
        let requestedRemoteAnalysis = false;

        try {
            // Check Usage Limit (Only for manual, non-cached analysis)
            if (!canReuseStoredAnalysis && !silent) {
                const count = Number(this.subscription?.usageCount || 0);
                const limit = Number(this.subscription?.usageLimit || 0);
                if (count >= limit) {
                    this.showAnalysisLimitError({ currentUsage: count, limit: limit });
                    return;
                }
            }
            if (!silent) {
                Notify.info('AI蟾ｮ蛻・ｧ｣譫舌ｒ螳溯｡御ｸｭ...');
            }

            const sourceType = String(contract?.source_type || '').toUpperCase();
            const isPdfSource = sourceType === 'PDF' || (contract?.original_filename || '').toLowerCase().endsWith('.pdf');

            if (canReuseStoredAnalysis) {
                Object.assign(diffPayload, storedContractAnalysis);
            } else if (targetDoc.is_current && contract.source_url) {
                requestedRemoteAnalysis = true;
                const result = await aiService.analyzeContract(contractId, 'url', contract.source_url, sourceDoc.content);
                if (!result.success) throw new Error(result.error || '蟾ｮ蛻・ｧ｣譫舌↓螟ｱ謨励＠縺ｾ縺励◆');
                Object.assign(diffPayload, result.data || {});
            } else if (targetDoc.is_current && isPdfSource) {
                const pdfUrl = this.getRuntimePdfPreviewUrl(contractId) || contract.pdf_url;
                if (!pdfUrl) {
                    diffPayload.summary = 'PDF蜴滓悽縺御ｿ晄戟縺輔ｌ縺ｦ縺・↑縺・◆繧√、I蟾ｮ蛻・ｧ｣譫舌・螳溯｡後○縺壽ｧ矩�蛹匁ｯ碑ｼ・・縺ｿ陦ｨ遉ｺ縺励∪縺吶・;
                    diffPayload.riskReason = '蜴滓悽譛ｪ菫晄戟';
                } else {
                    const response = await fetch(pdfUrl);
                    if (!response.ok) throw new Error('PDF蜴滓悽縺ｮ蜿門ｾ励↓螟ｱ謨励＠縺ｾ縺励◆');
                    const blob = await response.blob();
                    const file = new File([blob], targetDoc.document_name || contract.original_filename || 'contract.pdf', { type: blob.type || 'application/pdf' });
                    const base64 = await aiService.convertFileToBase64(file);
                    requestedRemoteAnalysis = true;
                    const result = await aiService.analyzeContract(contractId, 'pdf', base64, sourceDoc.content);
                    if (!result.success) throw new Error(result.error || '蟾ｮ蛻・ｧ｣譫舌↓螟ｱ謨励＠縺ｾ縺励◆');
                    Object.assign(diffPayload, result.data || {});
                }
            } else {
                const currentPayload = isStructuredDocumentContent(targetDoc.content)
                    ? targetDoc.content
                    : contentToComparableText(targetDoc.content);
                requestedRemoteAnalysis = true;
                const result = await aiService.analyzeContract(contractId, 'text', currentPayload, sourceDoc.content);
                if (!result.success) throw new Error(result.error || '蟾ｮ蛻・ｧ｣譫舌↓螟ｱ謨励＠縺ｾ縺励◆');
                Object.assign(diffPayload, result.data || {});
            }

            const diffChanges = Array.isArray(diffPayload.changes) ? diffPayload.changes.filter(Boolean) : [];
            if (hasStructuredDifferences) {
                diffPayload.changes = mergeStructuredChangesWithAnalysis(structuredFallbackAnalysis.changes, diffChanges);
                if (
                    isExplicitNoDiffAnalysis(diffPayload)
                    || diffPayload.isFallback === true
                    || diffPayload.aiFailed === true
                    || !hasMeaningfulAiSummary(diffPayload)
                ) {
                    diffPayload.summary = structuredFallbackAnalysis.summary;
                    diffPayload.riskLevel = structuredFallbackAnalysis.riskLevel;
                    diffPayload.riskReason = structuredFallbackAnalysis.riskReason || '螟画峩轤ｹ繧定｡ｨ遉ｺ縺励※縺・∪縺・;
                    diffPayload.isFallback = true;
                } else {
                    diffPayload.isFallback = false;
                }
            }

            if (!isMeaningfulAnalysisPayload(diffPayload) && canReuseStoredAnalysis) {
                Object.assign(diffPayload, storedContractAnalysis);
            }

            dbService.saveDiffResult({
                docA_id: sourceDoc.id,
                docB_id: targetDoc.id,
                diff_data: diffPayload,
                created_at: new Date().toISOString()
            });
            if (isCurrentVsLatestHistoryPair(docs, sourceDoc, targetDoc)) {
                dbService.updateContractAnalysis(contractId, {
                    summary: diffPayload.summary,
                    riskLevel: diffPayload.riskLevel,
                    riskReason: diffPayload.riskReason,
                    changes: Array.isArray(diffPayload.changes) ? diffPayload.changes : [],
                    isFallback: diffPayload.isFallback === true,
                    aiFailed: diffPayload.aiFailed === true,
                    status: '譛ｪ遒ｺ隱・
                });
            }
            if (requestedRemoteAnalysis) {
                await this.refreshSubscriptionStatusSafe();
            }
            dbService.touchRecentDiff(sourceDoc.id, targetDoc.id);
            this.setDocumentCompareState({
                contractId,
                docAId: sourceDoc.id,
                docBId: targetDoc.id
            });
            this.navigate('diff', contractId);
        } catch (error) {
            console.error('analyzeDocumentPair error:', error);
            if (error.code === 'ANALYSIS_LIMIT_EXCEEDED') {
                this.showAnalysisLimitError(error);
            } else if (!silent) {
                Notify.error(`AI隗｣譫蝉ｸｭ縺ｫ繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆: ${error.message}`);
            }
        }
    }

    viewHistory(contractId, version) {
        const contract = dbService.getContractById(contractId);
        if (!contract || !Array.isArray(contract.history)) return;

        const historyItem = contract.history.find(h => h.version === version);
        if (!historyItem) return;

        document.querySelectorAll('.modal').forEach(m => m.remove());

        const panes = document.querySelectorAll('.pane');
        if (panes.length < 2) {
            this.navigate('diff', contractId);
            setTimeout(() => this.viewHistory(contractId, version), 300);
            return;
        }

        const rightPane = panes[1];
        const rightHeader = rightPane.querySelector('.pane-header');
        if (rightHeader) {
            rightHeader.classList.add('history-preview-header');
            rightHeader.style.background = '#f7f2e4';
            rightHeader.style.borderBottom = '1px solid #eadfbe';
            rightHeader.innerHTML = `
                <div class="history-preview-bar">
                    <div class="history-preview-copy">
                        <div class="history-preview-eyebrow">
                            <i class="fa-solid fa-clock-rotate-left"></i>
                            螻･豁ｴ繝励Ξ繝薙Η繝ｼ
                        </div>
                        <div class="history-preview-name" title="${escapeHtmlText(historyItem.original_filename || contract.original_filename || contract.name || '螻･豁ｴ雉・侭')}">
                            ${escapeHtmlText(historyItem.original_filename || contract.original_filename || contract.name || '螻･豁ｴ雉・侭')}
                        </div>
                        <div class="history-preview-meta">
                            蜿冶ｾｼ譌･譎・ ${escapeHtmlText(formatDisplayTimestamp(historyItem.date) || '-')}
                        </div>
                    </div>
                    <div class="history-preview-actions">
                        <button class="btn-dashboard history-preview-primary" onclick="window.app.compareHistoryWithBase(${contractId}, ${version})">
                            <i class="fa-solid fa-code-compare"></i> BASE雉・侭縺ｨ豈碑ｼ・
                        </button>
                        <button class="btn-dashboard history-preview-secondary" onclick="window.app.clearHistoryComparisonContext(${contractId}); window.app.navigate('diff', ${contractId})">
                            <i class="fa-solid fa-rotate-left"></i> 譛譁ｰ迚医↓謌ｻ縺・
                        </button>
                    </div>
                </div>
            `;
        }

        const tabsRow = rightPane.querySelector('.tabs-row');
        if (tabsRow) tabsRow.style.display = 'none';

        const scrollArea = rightPane.querySelector('.pane-scroll-area');
        if (scrollArea) {
            scrollArea.scrollTop = 0;
            scrollArea.style.background = '#f6f7f9';

            const historyContentHtml = isStructuredDocumentContent(historyItem.content)
                ? `<div class="is-structured">${renderStructuredView(historyItem.content, `hist-${contractId}-${version}`)}</div>`
                : `<div class="document-content-full is-frameless">${escapeHtmlText(historyItem.content).replace(/\r?\n/g, '<br>')}</div>`;

            scrollArea.innerHTML = `
                <div style="padding:18px;">
                    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; margin-bottom:16px;">
                        <div style="background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:14px;">
                            <div style="font-size:11px; color:#7b8794; margin-bottom:6px;">螻･豁ｴ雉・侭</div>
                            <div style="font-size:14px; font-weight:700; color:#1f2937; word-break:break-word;">${escapeHtmlText(historyItem.original_filename || contract.original_filename || contract.name || '-')}</div>
                        </div>
                        <div style="background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:14px;">
                            <div style="font-size:11px; color:#7b8794; margin-bottom:6px;">蜿冶ｾｼ譌･譎・/div>
                            <div style="font-size:14px; font-weight:700; color:#1f2937;">${escapeHtmlText(formatDisplayTimestamp(historyItem.date) || '-')}</div>
                        </div>
                        <div style="background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:14px;">
                            <div style="font-size:11px; color:#7b8794; margin-bottom:6px;">豈碑ｼ・・(BASE)</div>
                            <div style="font-size:14px; font-weight:700; color:#1f2937; word-break:break-word;">${escapeHtmlText(contract.original_filename || contract.name || '-')}</div>
                        </div>
                    </div>
                    <div class="document-paper-container is-frameless">
                        <div class="document-content-full">
                            <div class="document-top-anchor" aria-hidden="true"></div>
                            ${historyContentHtml || '<div class="text-center text-muted" style="padding:40px;">螻･豁ｴ繝・・繧ｿ縺後≠繧翫∪縺帙ｓ</div>'}
                        </div>
                    </div>
                </div>
            `;
        }
    }


    exportCSV() {
        if (this.subscription?.plan !== 'pro') return;

        // Get filters from current state
        const filters = this.filters || {};
        const contracts = dbService.getContracts().filter(c => {
            if (filters.query) {
                const q = filters.query.toLowerCase();
                const match = c.name.toLowerCase().includes(q) ||
                    c.type.toLowerCase().includes(q) ||
                    c.assignee_name.toLowerCase().includes(q);
                if (!match) return false;
            }
            if (filters.risk && filters.risk !== 'all') {
                if (c.risk_level !== filters.risk) return false;
            }
            if (filters.status && filters.status !== 'all') {
                if (c.status !== filters.status) return false;
            }
            if (filters.type && filters.type !== 'all') {
                if (c.type !== filters.type) return false;
            }
            return true;
        });

        // CSV Generation with Escaping
        const headers = ["螂醍ｴ・錐", "繧ｹ繝・・繧ｿ繧ｹ", "繝ｪ繧ｹ繧ｯ繝ｬ繝吶Ν", "譛邨よ峩譁ｰ譌･"];
        const rows = contracts.map(c => [
            c.name,
            c.status,
            c.risk_level || '-',
            c.last_updated_at
        ]);

        const escapeCSV = (str) => {
            if (str === null || str === undefined) return '';
            const s = String(str);
            if (s.includes(',') || s.includes('"') || s.includes('\n')) {
                return `"${s.replace(/"/g, '""')}"`;
            }
            return s;
        };

        let csvContent = "\uFEFF"; // UTF-8 BOM for Excel
        csvContent += headers.map(escapeCSV).join(",") + "\n";
        csvContent += rows.map(row => row.map(escapeCSV).join(",")).join("\n");

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", `螂醍ｴ・ｸ隕ｧ_${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    async shareReport(contractId) {
        const contract = dbService.getContractById(contractId);
        if (!contract) return;

        const riskLabel = contract.risk_level || 'Low';
        const summary = contract.ai_summary || '隗｣譫舌ョ繝ｼ繧ｿ縺ｪ縺・;
        const name = contract.original_filename || contract.name || '螂醍ｴ・嶌';
        const shareUrl = `${window.location.origin}/dashboard.html#diff/${contractId}`;

        const shareText = `縲織IFFsense 隗｣譫舌Ξ繝昴・繝医曾n�塘 ${name}\n笞�・・繝ｪ繧ｹ繧ｯ: ${riskLabel}\n\n${summary}\n\n${shareUrl}`;

        // Web Share API縺御ｽｿ縺医ｋ蝣ｴ蜷医・繝阪う繝・ぅ繝門・譛・
        if (navigator.share) {
            try {
                await navigator.share({
                    title: `DIFFsense - ${name}`,
                    text: shareText,
                    url: shareUrl
                });
                return;
            } catch (e) {
                // 繝ｦ繝ｼ繧ｶ繝ｼ縺後く繝｣繝ｳ繧ｻ繝ｫ縺励◆蝣ｴ蜷医・菴輔ｂ縺励↑縺・
                if (e.name === 'AbortError') return;
            }
        }

        // 繝輔か繝ｼ繝ｫ繝舌ャ繧ｯ: 繧ｯ繝ｪ繝・・繝懊・繝峨↓繧ｳ繝斐・
        try {
            await navigator.clipboard.writeText(shareText);
            Notify.success('繝ｬ繝昴・繝亥・螳ｹ繧偵け繝ｪ繝・・繝懊・繝峨↓繧ｳ繝斐・縺励∪縺励◆');
        } catch (e) {
            // clipboard API繧ゆｽｿ縺医↑縺・�ｴ蜷・
            const textarea = document.createElement('textarea');
            textarea.value = shareText;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            Notify.success('繝ｬ繝昴・繝亥・螳ｹ繧偵け繝ｪ繝・・繝懊・繝峨↓繧ｳ繝斐・縺励∪縺励◆');
        }
    }

    async exportPDF(contractId) {
        if (!['pro', 'business'].includes(this.subscription?.plan)) return;
        const contract = dbService.getContractById(contractId);
        if (!contract) return;

        this.showToast('PDF繝ｬ繝昴・繝医ｒ逕滓・荳ｭ...', 'info');

        try {
            await this.ensurePdfLibraries();

            // 1. Create a structured report in a hidden container
            const reportId = 'pdf-export-container';
            let container = document.getElementById(reportId);
            if (!container) {
                container = document.createElement('div');
                container.id = reportId;
                // Off-screen but visible to the renderer
                container.style.position = 'absolute';
                container.style.left = '-9999px';
                container.style.width = '800px';
                container.style.background = 'white';
                container.style.color = '#333';
                container.style.fontFamily = "'Noto Sans JP', sans-serif";
                document.body.appendChild(container);
            }

            // 2. Build Report Content (Japanese text included)
            const riskColor = contract.risk_level === 'High' ? '#D73A49' : (contract.risk_level === 'Medium' ? '#f1c40f' : '#2ecc71');
            const analysisDate = new Date().toLocaleString('ja-JP');

            // Each direct child div = one section for page-break control
            container.innerHTML = `
                            <div style="padding: 40px; line-height: 1.6;">
                                <!-- Section: Header -->
                                <div style="border-bottom: 2px solid #c19b4a; padding-bottom: 10px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-end;">
                                    <h1 style="margin: 0; color: #c19b4a; font-size: 24px;">DIFFsense AI隗｣譫舌Ξ繝昴・繝・/h1>
                                    <span style="font-size: 12px; color: #888;">蜃ｺ蜉帶律: ${analysisDate}</span>
                                </div>

                                <!-- Section: Document Info -->
                                <div style="margin-bottom: 20px; padding: 15px; background: #f9f9f9; border-radius: 4px;">
                                    <div style="margin-bottom: 8px;"><strong>蟇ｾ雎｡繝峨く繝･繝｡繝ｳ繝・</strong> ${contract.original_filename || contract.name}</div>
                                    ${contract.source_url ? `<div style="margin-bottom: 8px;"><strong>蟇ｾ雎｡URL:</strong> ${contract.source_url}</div>` : ''}
                                    <div style="display: flex; align-items: center; gap: 10px;">
                                        <strong>AI繝ｪ繧ｹ繧ｯ蛻､螳・</strong>
                                        <span style="padding: 2px 10px; border-radius: 4px; background: ${riskColor}; color: white; font-weight: bold;">${contract.risk_level || 'Low'}</span>
                                    </div>
                                </div>

                                <!-- Section: AI Summary -->
                                <div style="margin-bottom: 20px;">
                                    <h2 style="font-size: 18px; border-left: 4px solid #c19b4a; padding-left: 10px; margin: 0 0 15px;">縲占ｧ｣譫占ｦ∫ｴ・・/h2>
                                    <div style="white-space: pre-wrap;">${contract.ai_summary || '隗｣譫舌ョ繝ｼ繧ｿ縺ｪ縺・}</div>
                                </div>

                                <!-- Section: Risk Reason -->
                                <div style="margin-bottom: 20px;">
                                    <h2 style="font-size: 18px; border-left: 4px solid #c19b4a; padding-left: 10px; margin: 0 0 15px;">縲植I繝ｪ繧ｹ繧ｯ蛻､螳夂ｵ先棡繝ｻ逅・罰縲・/h2>
                                    <div style="white-space: pre-wrap;">${contract.ai_risk_reason || '蛻､螳壹ョ繝ｼ繧ｿ縺ｪ縺・}</div>
                                </div>

                                <!-- Section: Each change as separate section -->
                                <div style="margin-bottom: 10px;">
                                    <h2 style="font-size: 18px; border-left: 4px solid #c19b4a; padding-left: 10px; margin: 0 0 15px;">縲蝉ｸｻ隕√↑蟾ｮ蛻・ｮ・園縲・/h2>
                                </div>
                                ${(contract.ai_changes || []).map(c => `
                    <div style="margin-bottom: 15px; border: 1px solid #eee; border-radius: 4px;">
                        <div style="background: #f5f5f5; padding: 8px 12px; font-weight: bold; border-bottom: 1px solid #eee;">${c.section}</div>
                        <div style="padding: 12px;">
                            <div style="background: #fff5f5; padding: 8px; margin-bottom: 5px; border-radius: 2px;"><span style="color: #D73A49; font-weight:600;">蜴滓枚:</span> ${c.old}</div>
                            <div style="background: #f0fff4; padding: 8px; border-radius: 2px;"><span style="color: #2ecc71; font-weight:600;">菫ｮ豁｣蠕・</span> ${c.new}</div>
                            <div style="margin-top: 10px; font-size: 12px; color: #666;">
                                <strong>豕慕噪蠖ｱ髻ｿ:</strong> ${c.impact || '-'}<br>
                                <strong>諛ｸ蠢ｵ轤ｹ:</strong> ${c.concern || '-'}
                            </div>
                        </div>
                    </div>
                    `).join('') || '<div style="margin-bottom:20px;"><p style="color:#999;">蟾ｮ蛻・ョ繝ｼ繧ｿ縺ｯ縺ゅｊ縺ｾ縺帙ｓ</p></div>'}

                                <!-- Section: Original Content -->
                                <div style="margin-bottom: 20px;">
                                    <h2 style="font-size: 18px; border-left: 4px solid #c19b4a; padding-left: 10px; margin: 0 0 15px;">縲仙次譛ｬ・亥・譁・ｼ峨・/h2>
                                    <div style="white-space: pre-wrap; background: #fafafa; padding: 20px; font-size: 12px; border: 1px solid #eee;">${contract.original_content || '蜴滓悽繝・・繧ｿ縺ｯ縺ゅｊ縺ｾ縺帙ｓ'}</div>
                                </div>

                                <!-- Section: Footer -->
                                <div style="text-align: center; border-top: 1px solid #eee; padding-top: 10px; font-size: 10px; color: #aaa;">
                                    Generated by DIFFsense - Professional Contract Analysis Service
                                </div>
                            </div>
                            `;

            // 3. Render each section separately to avoid mid-content page breaks
            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF('p', 'mm', 'a4');
            const pageWidth = 210;
            const pageHeight = 297;
            const margin = 15;
            const contentWidth = pageWidth - margin * 2;
            const usableHeight = pageHeight - margin * 2;

            // Get all direct child sections of the report
            const reportInner = container.querySelector(':scope > div');
            const sections = reportInner.children;

            let currentY = margin;

            for (let i = 0; i < sections.length; i++) {
                const section = sections[i];

                const canvas = await window.html2canvas(section, {
                    scale: 2,
                    useCORS: true,
                    logging: false,
                    backgroundColor: '#ffffff',
                    width: 800
                });

                const imgData = canvas.toDataURL('image/png');
                const sectionImgHeight = (canvas.height * contentWidth) / canvas.width;

                // If this section is taller than a full page, fall back to slicing
                if (sectionImgHeight > usableHeight) {
                    // For very tall sections, slice into page-sized chunks
                    let sliceY = 0;
                    const sliceHeightPx = Math.floor((usableHeight / sectionImgHeight) * canvas.height);

                    while (sliceY < canvas.height) {
                        if (currentY > margin && currentY !== margin) {
                            pdf.addPage();
                            currentY = margin;
                        }

                        const remainPx = canvas.height - sliceY;
                        const thisSlicePx = Math.min(sliceHeightPx, remainPx);
                        const thisSliceMm = (thisSlicePx * contentWidth) / canvas.width;

                        // Create a sub-canvas for this slice
                        const sliceCanvas = document.createElement('canvas');
                        sliceCanvas.width = canvas.width;
                        sliceCanvas.height = thisSlicePx;
                        const ctx = sliceCanvas.getContext('2d');
                        ctx.drawImage(canvas, 0, sliceY, canvas.width, thisSlicePx, 0, 0, canvas.width, thisSlicePx);

                        const sliceImg = sliceCanvas.toDataURL('image/png');
                        pdf.addImage(sliceImg, 'PNG', margin, currentY, contentWidth, thisSliceMm);

                        sliceY += thisSlicePx;
                        if (sliceY < canvas.height) {
                            pdf.addPage();
                            currentY = margin;
                        } else {
                            currentY += thisSliceMm;
                        }
                    }
                } else {
                    // Check if section fits on current page
                    if (currentY + sectionImgHeight > pageHeight - margin) {
                        pdf.addPage();
                        currentY = margin;
                    }

                    pdf.addImage(imgData, 'PNG', margin, currentY, contentWidth, sectionImgHeight);
                    currentY += sectionImgHeight;
                }
            }

            pdf.save(`DIFFsense_Report_${contract.name}_${new Date().toISOString().split('T')[0]}.pdf`);
            this.showToast('PDF繧貞・蜉帙＠縺ｾ縺励◆', 'success');

        } catch (error) {
            console.error('PDF Export Error:', error);
            this.showToast('PDF縺ｮ逕滓・荳ｭ縺ｫ繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆', 'error');
        } finally {
            // Clean up off-screen container
            const el = document.getElementById('pdf-export-container');
            if (el) el.remove();
        }
    }

    async showAnalysisLimitError(error = {}) {
        let cu = error.currentUsage;
        let lim = error.limit;
        let next = error.nextPlan;

        // Preemptive check or missing fields fallback
        if (cu === undefined || lim === undefined) {
            cu = Number(this.subscription?.usageCount || 0);
            lim = Number(this.subscription?.usageLimit || 0);
        }

        if (!next) {
            const plan = this.subscription?.plan || 'free';
            const nextPlanMap = {
                'free': { name: 'Starter', limit: 50, price: 'ﾂ･1,480' },
                'trial': { name: 'Starter', limit: 50, price: 'ﾂ･1,480' },
                'starter': { name: 'Business', limit: 120, price: 'ﾂ･4,980' },
                'business': { name: 'Pro', limit: 400, price: 'ﾂ･9,800' },
                'pro': null
            };
            next = nextPlanMap[plan];
        }
        
        let message = `莉頑怦縺ｮAI蟾ｮ蛻・メ繧ｧ繝・け蝗樊焚縺ｮ荳企剞・・{cu}/${lim}蝗橸ｼ峨ｒ菴ｿ縺・・繧翫∪縺励◆縲Ａ;
        let okText = '繝励Λ繝ｳ繧定｡ｨ遉ｺ';
        
        if (next) {
            message += `<br><br>${next.name}繝励Λ繝ｳ・・{next.price}/譛茨ｼ峨↓繧｢繝・・繧ｰ繝ｬ繝ｼ繝峨☆繧九→縲∵怦${next.limit}蝗槭∪縺ｧ隗｣譫舌〒縺阪∪縺吶Ａ;
            okText = '莉翫☆縺舌い繝・・繧ｰ繝ｬ繝ｼ繝・;
        } else {
            message += `<br><br>譚･譛医∪縺ｧ縺雁ｾ・■縺・◆縺�縺上°縲√ｈ繧贋ｸ贋ｽ阪・繝励Λ繝ｳ縺ｫ縺､縺・※縺雁撫縺・粋繧上○縺上□縺輔＞縲Ａ;
        }

        const confirmed = await Notify.confirm(message, {
            title: '隗｣譫仙屓謨ｰ縺ｮ荳企剞縺ｫ驕斐＠縺ｾ縺励◆',
            type: 'warning',
            okText: okText,
            cancelText: '髢峨§繧・,
            okStyle: 'primary'
        });

        if (confirmed) {
            const planId = next ? String(next.name).toLowerCase() : 'starter';
            this.startStripeCheckout(planId);
        }
    }

    async startStripeCheckout(planId) {
        // Show loading toast or overlay if needed
        const loadingNotify = Notify.info('豎ｺ貂医・繝ｼ繧ｸ縺ｸ遘ｻ蜍穂ｸｭ...', { duration: 0 });

        try {
            // Get ID Token
            const user = auth.currentUser;
            if (!user) {
                // Wait a bit for auth state if not immediately available
                await new Promise(resolve => {
                    const unsubscribe = onAuthStateChanged(auth, (user) => {
                        unsubscribe();
                        resolve(user);
                    });
                    setTimeout(resolve, 3000); // Timeout fallback
                });
            }

            const currentUser = auth.currentUser;
            let token = null;
            if (currentUser) {
                token = await currentUser.getIdToken();
            }

            const apiBase = getApiBaseUrl();
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers.Authorization = `Bearer ${token}`;

            const res = await fetch(`${apiBase}/api/createCheckoutSession`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    plan: planId,
                    billingCycle: 'monthly',
                    cancelUrl: window.location.href
                })
            });

            const result = await res.json();
            if (result.success && result.data?.url) {
                sessionStorage.setItem('stripe_checkout_started', 'true');
                window.location.href = result.data.url;
            } else {
                throw new Error(result.error || '豎ｺ貂医・繝ｼ繧ｸ繧帝幕縺代∪縺帙ｓ縺ｧ縺励◆');
            }
        } catch (error) {
            console.error('Stripe Checkout Error:', error);
            Notify.error(`豎ｺ貂医・繝ｼ繧ｸ縺ｮ隱ｭ縺ｿ霎ｼ縺ｿ縺ｫ螟ｱ謨励＠縺ｾ縺励◆: ${error.message}`);
            // Fallback to select-plan.html if API fails
            setTimeout(() => {
                window.location.href = `/select-plan.html?plan=${planId}`;
            }, 2000);
        } finally {
            if (loadingNotify && loadingNotify.close) loadingNotify.close();
        }
    }

    showToast(message, type = 'info', duration = 3000) {
        // Use Notify system for consistency
        if (type === 'success') {
            Notify.success(message);
        } else if (type === 'error') {
            Notify.error(message);
        } else if (type === 'warning') {
            Notify.warning(message);
        } else {
            Notify.info(message);
        }
    }
}

// Global App Instance
window.app = new DashboardApp();
document.addEventListener('DOMContentLoaded', () => window.app.init());









