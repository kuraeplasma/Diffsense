const ARTICLE_HEADER_REGEX = /^第\s*([0-9０-９]+)\s*条\s*(.*)$/;
const VERSION_REGEX = /(?:ver(?:sion)?\.?\s*)?v?\d+(?:\.\d+)+/i;

function normalizeDigits(value) {
    return String(value || '').replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0));
}

function parseJapaneseNumber(value) {
    const normalized = normalizeDigits(value).trim();
    if (!normalized) return 0;
    if (/^\d+$/.test(normalized)) return parseInt(normalized, 10);

    const map = { '零': 0, '〇': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    if (map[normalized] !== undefined) return map[normalized];

    let total = 0;
    let current = 0;
    for (const ch of normalized) {
        if (map[ch] !== undefined) {
            current = map[ch];
            continue;
        }
        if (ch === '千') {
            total += (current || 1) * 1000;
            current = 0;
            continue;
        }
        if (ch === '百') {
            total += (current || 1) * 100;
            current = 0;
            continue;
        }
        if (ch === '十') {
            total += (current || 1) * 10;
            current = 0;
            continue;
        }
    }
    return total + current;
}

function parseArticleHeader(text) {
    let line = String(text || '').trim();
    line = line.replace(/^第\s*第?\s*([0-9０-９一二三四五六七八九十百千〇零]+)\s*条\s*条?/, '第$1条');
    line = line.replace(/^第\s+([0-9０-９一二三四五六七八九十百千〇零]+)\s+条/, '第$1条');
    const match = line.match(ARTICLE_HEADER_REGEX);
    if (!match) return null;

    const numRaw = normalizeDigits(match[1]);
    const tail = String(match[2] || '').trim();
    let titleRaw = '';
    let remainder = '';

    // Pattern 1: 第○条（タイトル）
    // Prefer bracketed title extraction even when the rest of line is long.
    const bracketed = tail.match(/^([（(【][^）)】]{1,20}[）)】])\s*(.*)$/);
    if (bracketed && !String(bracketed[1]).includes('。')) {
        titleRaw = String(bracketed[1] || '').trim();
        remainder = String(bracketed[2] || '').trim();
    } else if (tail && tail.length <= 20 && !tail.includes('。')) {
        // Pattern 2: 第○条 タイトル
        titleRaw = tail;
    } else {
        remainder = tail;
    }

    const articleNumber = `第${numRaw}条`;

    return {
        articleNumber,
        articleNumeric: parseJapaneseNumber(numRaw),
        title: titleRaw,
        remainder
    };
}

function isValidArticleTitleCandidate(text) {
    const s = String(text || '').trim();
    if (!s) return false;
    if (s.length > 20) return false;
    if (s.includes('。')) return false;
    return true;
}

function extractInlineTitleFromFullText(fullText) {
    const src = String(fullText || '').trim();
    if (!src) return '';
    const m = src.match(/^第\s*[0-9０-９]+\s*条\s*(.*)$/);
    if (!m) return '';
    const tail = String(m[1] || '').trim();
    if (!tail) return '';

    const bracketed = tail.match(/^([（(【][^）)】]{1,20}[）)】])/);
    if (bracketed && !String(bracketed[1]).includes('。')) {
        return String(bracketed[1]).trim();
    }
    if (tail.length <= 20 && !tail.includes('。')) {
        return tail;
    }
    return '';
}

function extractBracketedHeadingPrefix(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    const m = s.match(/^([（(【][^）)】]{1,20}[）)】])\s*(.*)$/);
    if (!m) return null;
    const heading = String(m[1] || '').trim();
    if (!heading || heading.includes('。')) return null;
    return {
        heading,
        rest: String(m[2] || '').trim()
    };
}

function looksLikeStandaloneHeading(line) {
    const text = String(line || '').trim();
    if (!text) return false;
    if (text.length > 24) return false;
    if (/[。．、，:：]/.test(text)) return false;
    if (/^[\d０-９]+\s*[\.．\)]/.test(text)) return false;
    if (/^[・●○■□\-]/.test(text)) return false;
    // Keep short Japanese/ASCII heading-like labels (e.g. 総則, 定義, 利用料金, Account).
    return /^[\u3040-\u30ff\u3400-\u9fffA-Za-z0-9\s　（）()【】\-]+$/.test(text);
}

function buildStructuredContract(paragraphs = [], meta = {}) {
    const cleaned = [];
    for (const p of (paragraphs || [])) {
        const raw = String(p || '').replace(/\r/g, '');
        const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
        if (lines.length) {
            cleaned.push(...lines);
        }
    }

    const title = (meta.title || cleaned[0] || '').trim();
    const version = (meta.version || (cleaned.find((line) => VERSION_REGEX.test(line)) || '')).trim();
    const preambleLines = [];
    const articles = [];
    let currentArticle = null;

    const flush = () => {
        if (!currentArticle) return;
        currentArticle.content = currentArticle.paragraphs.join('\n').trim();
        articles.push(currentArticle);
        currentArticle = null;
    };

    for (const line of cleaned) {
        const header = parseArticleHeader(line);
        if (header) {
            flush();
            currentArticle = {
                articleNumber: header.articleNumber,
                articleNumeric: header.articleNumeric,
                title: header.title || '',
                paragraphs: [],
                content: ''
            };
            if (header.remainder) currentArticle.paragraphs.push(header.remainder);
            continue;
        }

        if (!currentArticle) {
            // Keep all preamble lines to avoid losing leading text.
            preambleLines.push(line);
        } else {
            // If title is missing and the first body line looks like a standalone heading,
            // promote it to article title to stabilize PDF extraction output.
            if (!currentArticle.title && currentArticle.paragraphs.length === 0 && looksLikeStandaloneHeading(line)) {
                currentArticle.title = line;
            } else {
                currentArticle.paragraphs.push(line);
            }
        }
    }

    flush();

    return {
        title,
        version,
        preamble: preambleLines.join('\n').trim(),
        articles: articles.map((a) => ({
            articleNumber: a.articleNumber,
            title: a.title,
            content: a.content
        }))
    };
}

function toLegacyArticleArray(structuredContract) {
    if (!structuredContract || !Array.isArray(structuredContract.articles)) return [];
    const result = [];
    if (structuredContract.preamble) {
        result.push({
            article: '前文',
            title: structuredContract.title || '前文',
            article_number: 0,
            paragraphs: structuredContract.preamble.split(/\n+/).filter(Boolean),
            full_text: structuredContract.preamble
        });
    }

    for (const art of structuredContract.articles) {
        const articleNumber = art.articleNumber || '';
        const numeric = parseJapaneseNumber((articleNumber.match(/第(.+?)条/) || [])[1] || '');
        const paragraphs = String(art.content || '').split(/\n+/).filter((p) => p.trim().length > 0);
        result.push({
            article: articleNumber,
            title: art.title || '',
            article_number: numeric || result.length,
            paragraphs,
            full_text: `${articleNumber}${art.title ? ` ${art.title}` : ''}\n${paragraphs.join('\n')}`.trim()
        });
    }

    return result;
}

function fromLegacyArticleArray(articles = [], meta = {}) {
    if (!Array.isArray(articles)) {
        return {
            title: meta.title || '',
            version: meta.version || '',
            preamble: '',
            articles: []
        };
    }

    let preamble = '';
    let seenArticleOne = false;
    const normalizedArticles = [];

    for (const item of articles) {
        const articleLabel = String(item?.article || '').trim();
        let title = String(item?.title || '').trim();
        let paragraphs = Array.isArray(item?.paragraphs)
            ? item.paragraphs.map((p) => String(p || '')).filter((p) => p.length > 0)
            : (typeof item?.full_text === 'string' ? item.full_text.split(/\n+/).filter(Boolean) : []);

        if (!articleLabel || articleLabel === '前文' || Number(item?.article_number) === 0) {
            const preambleText = paragraphs.join('\n').trim();
            if (preambleText) {
                preamble = preamble ? `${preamble}\n${preambleText}` : preambleText;
            }
            continue;
        }

        const parsed = parseArticleHeader(articleLabel);
        const numeric = parsed?.articleNumeric || Number(item?.article_number) || 0;

        // Pattern 1 recovery for legacy/docx-like blocks:
        // full_text may preserve "第1条（定義）" even if title was normalized to "定義".
        const inlineTitle = extractInlineTitleFromFullText(item?.full_text);
        if (inlineTitle) {
            title = inlineTitle;
        }

        // Pattern 3 variant:
        // first paragraph starts with a bracketed heading, e.g. "（定義） 1 ...".
        if (!title && paragraphs.length > 0) {
            const pref = extractBracketedHeadingPrefix(paragraphs[0]);
            if (pref) {
                title = pref.heading;
                if (pref.rest) {
                    paragraphs[0] = pref.rest;
                } else {
                    paragraphs = paragraphs.slice(1);
                }
            }
        }

        // Align PDF behavior with DOCX:
        // When title is missing, treat the first short line as article title.
        if (!title && paragraphs.length > 0 && isValidArticleTitleCandidate(paragraphs[0])) {
            title = paragraphs[0].trim();
            paragraphs = paragraphs.slice(1);
        }

        if (numeric === 1) {
            seenArticleOne = true;
        }

        // DOCX由来の先頭TOC混入対策:
        // 第1条登場前に現れる空の「第n条 見出し」は本文ではない可能性が高いので除外する。
        if (!seenArticleOne && numeric > 1) {
            const joined = paragraphs.join('\n').trim();
            const hasSubstance = joined.length >= 30;
            const looksLikePreamble = /(前文|契約書|規約|改訂|ver\.?|version)/i.test(joined);
            if (!hasSubstance || looksLikePreamble) {
                if (looksLikePreamble && joined) {
                    preamble = preamble ? `${preamble}\n${joined}` : joined;
                }
                continue;
            }
        }

        normalizedArticles.push({
            articleNumber: articleLabel,
            title,
            content: paragraphs.join('\n').trim()
        });
    }

    return {
        title: String(meta.title || '').trim(),
        version: String(meta.version || '').trim(),
        preamble,
        articles: normalizedArticles
    };
}

module.exports = {
    parseArticleHeader,
    buildStructuredContract,
    toLegacyArticleArray,
    fromLegacyArticleArray
};
