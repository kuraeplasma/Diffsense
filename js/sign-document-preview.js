const escapeHtml = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildPlainPreviewText = (content) => {
    if (!content) return '';

    if (typeof content === 'string') {
        return String(content).trim();
    }

    if (Array.isArray(content)) {
        return content
            .map((item, index) => buildPlainPreviewTextFromItem(item, index))
            .filter(Boolean)
            .join('\n\n')
            .trim();
    }

    if (typeof content === 'object' && Array.isArray(content.articles)) {
        const preamble = String(content.preamble || '').trim();
        const articles = content.articles
            .map((item, index) => buildPlainPreviewTextFromItem(item, index))
            .filter(Boolean)
            .join('\n\n')
            .trim();
        return [preamble, articles].filter(Boolean).join('\n\n').trim();
    }

    return String(content).trim();
};

function buildPlainPreviewTextFromItem(item, index = 0) {
    if (!item) return '';
    if (typeof item === 'string') return item.trim();

    const fullText = String(item.full_text || item.fullText || '').trim();
    if (fullText) return fullText;

    const articleLabel = String(item.article || item.articleNumber || '').trim();
    const heading = String(item.title || item.header || '').trim();
    const titleLine = [articleLabel, heading]
        .filter((part, partIndex, parts) => {
            if (!part) return false;
            if (partIndex === 1 && parts[0] && (parts[0].includes(part) || part.includes(parts[0]))) {
                return false;
            }
            return true;
        })
        .join(' ')
        .trim();

    const paragraphText = Array.isArray(item.paragraphs)
        ? item.paragraphs.map((p) => String(p || '').trim()).filter(Boolean).join('\n')
        : String(item.body || item.content || '').trim();

    const fallbackTitle = !titleLine && !paragraphText ? `第${index + 1}条` : '';
    return [titleLine || fallbackTitle, paragraphText].filter(Boolean).join('\n').trim();
}

const renderPlainPreviewHtml = (text) => {
    const normalized = String(text || '').replace(/\r/g, '').replace(/([\uFF21-\uFF5A\uFF10-\uFF19])\n([\uFF21-\uFF5A\uFF10-\uFF19])/g, '$1$2').trim();
    if (!normalized) {
        return '<div class="document-content-full is-frameless">表示できる本文データが見つかりません</div>';
    }
    return `
        <div class="document-content-full is-frameless sign-plain-document" style="white-space:pre-wrap; word-break:break-word;">
            ${escapeHtml(normalized)}
        </div>
    `;
};

export function buildSignDocumentPreviewHtml(content) {
    return renderPlainPreviewHtml(buildPlainPreviewText(content));
}
