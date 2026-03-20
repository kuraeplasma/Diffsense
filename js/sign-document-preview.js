const escapeHtml = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export function buildSignDocumentPreviewHtml(content) {
    if (!content) {
        return '<div class="document-content-full is-frameless">表示できる本文データが見つかりません</div>';
    }

    if (typeof content === 'string') {
        return `<div class="document-content-full is-frameless">${escapeHtml(content).replace(/\r?\n/g, '<br>')}</div>`;
    }

    if (Array.isArray(content)) {
        const clauses = content.map((item, index) => {
            const title = escapeHtml(item.article || item.articleNumber || item.title || `第${index + 1}条`);
            const header = escapeHtml(item.header || '');
            const paragraphs = Array.isArray(item.paragraphs)
                ? item.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('')
                : `<p>${escapeHtml(item.body || item.content || '')}</p>`;
            return `
                <article class="clause-card">
                    <div class="clause-card-header">
                        <h3>${title}</h3>
                        ${header ? `<div class="clause-card-subtitle">${header}</div>` : ''}
                    </div>
                    <div class="clause-card-body">${paragraphs}</div>
                </article>
            `;
        }).join('');

        return `<div class="is-structured"><div class="contract-structured-container"><div class="clause-cards-container">${clauses}</div></div></div>`;
    }

    if (typeof content === 'object' && Array.isArray(content.articles)) {
        const preamble = String(content.preamble || '').trim();
        const articles = content.articles.map((item, index) => {
            const title = escapeHtml(item.articleNumber || item.article || `第${index + 1}条`);
            const header = escapeHtml(item.title || item.header || '');
            const bodySource = Array.isArray(item.paragraphs)
                ? item.paragraphs
                : String(item.content || '').split(/\r?\n/).filter(Boolean);
            const paragraphs = bodySource.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
            return `
                <article class="clause-card">
                    <div class="clause-card-header">
                        <h3>${title}</h3>
                        ${header ? `<div class="clause-card-subtitle">${header}</div>` : ''}
                    </div>
                    <div class="clause-card-body">${paragraphs}</div>
                </article>
            `;
        }).join('');

        const preambleHtml = preamble
            ? `
                <article class="clause-card">
                    <div class="clause-card-header">
                        <h3>前文</h3>
                    </div>
                    <div class="clause-card-body">${escapeHtml(preamble).replace(/\r?\n/g, '<br>')}</div>
                </article>
            `
            : '';

        return `<div class="is-structured"><div class="contract-structured-container"><div class="clause-cards-container">${preambleHtml}${articles}</div></div></div>`;
    }

    return `<div class="document-content-full is-frameless">${escapeHtml(String(content))}</div>`;
}
