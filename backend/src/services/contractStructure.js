const ARTICLE_HEADER_REGEX = /^第\s*([0-9０-９一二三四五六七八九十百千〇零]+)\s*条(?:\s*[（(]?\s*([^）)]+?)\s*[）)]?)?\s*(.*)$/;
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
    const line = String(text || '').trim();
    const match = line.match(ARTICLE_HEADER_REGEX);
    if (!match) return null;

    const numRaw = match[1];
    const titleRaw = (match[2] || '').trim();
    const remainder = (match[3] || '').trim();
    const articleNumber = `第${numRaw}条`;

    return {
        articleNumber,
        articleNumeric: parseJapaneseNumber(numRaw),
        title: titleRaw,
        remainder
    };
}

function buildStructuredContract(paragraphs = [], meta = {}) {
    const cleaned = paragraphs
        .map((p) => String(p || '').replace(/\r/g, '').trim())
        .filter(Boolean);

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
            // Skip duplicate title/version lines from preamble body.
            if (title && line === title) continue;
            if (version && line === version) continue;
            preambleLines.push(line);
        } else {
            currentArticle.paragraphs.push(line);
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
    const normalizedArticles = [];

    for (const item of articles) {
        const articleLabel = String(item?.article || '').trim();
        const title = String(item?.title || '').trim();
        const paragraphs = Array.isArray(item?.paragraphs)
            ? item.paragraphs.map((p) => String(p || '')).filter((p) => p.length > 0)
            : (typeof item?.full_text === 'string' ? item.full_text.split(/\n+/).filter(Boolean) : []);

        if (!articleLabel || articleLabel === '前文' || Number(item?.article_number) === 0) {
            const preambleText = paragraphs.join('\n').trim();
            if (preambleText) {
                preamble = preamble ? `${preamble}\n${preambleText}` : preambleText;
            }
            continue;
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
