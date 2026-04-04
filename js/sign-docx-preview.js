const SCRIPT_CACHE = new Map();

function loadScriptOnce(src, guard) {
    if (guard && guard()) {
        return Promise.resolve();
    }
    if (SCRIPT_CACHE.has(src)) {
        return SCRIPT_CACHE.get(src);
    }
    const loader = new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-sign-docx-src="${src}"]`);
        if (existing) {
            if (guard && guard()) {
                resolve();
                return;
            }
            existing.addEventListener('load', () => resolve(), { once: true });
            existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
            return;
        }
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.dataset.signDocxSrc = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
    });
    SCRIPT_CACHE.set(src, loader);
    return loader;
}

function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function normalizeDocxSource(source) {
    if (!source) return null;
    if (source instanceof Blob) return source;
    if (typeof source === 'string' && String(source).trim()) return String(source).trim();
    return null;
}

function isElementVisiblePageCandidate(element) {
    if (!element || element.nodeType !== 1) return false;
    if (['STYLE', 'SCRIPT'].includes(element.tagName)) return false;
    return Boolean(element.textContent?.trim() || element.children?.length);
}

function isDocxPageLikeElement(element) {
    if (!isElementVisiblePageCandidate(element)) return false;
    const className = String(element.className || '');
    if (/(^|\s)(docx|docx-page|page)(\s|$)/i.test(className)) return true;
    const styleText = String(element.getAttribute?.('style') || '');
    return /page-break/i.test(styleText);
}

function collectDocxPages(root) {
    const wrapper = root.querySelector('.docx-wrapper');
    if (wrapper) {
        const directSections = Array.from(wrapper.children).filter((child) => child.tagName === 'SECTION' && isElementVisiblePageCandidate(child));
        if (directSections.length > 0) return directSections;

        const pageLikeChildren = Array.from(wrapper.children).filter(isDocxPageLikeElement);
        if (pageLikeChildren.length > 1) return pageLikeChildren;

        const firstVisibleChild = Array.from(wrapper.children).find(isElementVisiblePageCandidate);
        if (firstVisibleChild) {
            const nestedSections = Array.from(firstVisibleChild.querySelectorAll('section')).filter(isElementVisiblePageCandidate);
            if (nestedSections.length > 0) return nestedSections;

            const nestedPageLikeChildren = Array.from(firstVisibleChild.children).filter(isDocxPageLikeElement);
            if (nestedPageLikeChildren.length > 0) return nestedPageLikeChildren;

            const nestedVisibleChildren = Array.from(firstVisibleChild.children).filter(isElementVisiblePageCandidate);
            if (nestedVisibleChildren.length > 1) return nestedVisibleChildren;
        }
    }

    const sectionPages = Array.from(root.querySelectorAll('.docx-wrapper > section')).filter(isElementVisiblePageCandidate);
    if (sectionPages.length > 0) return sectionPages;

    const genericSections = Array.from(root.querySelectorAll('section')).filter((section) => section.parentElement === wrapper && isElementVisiblePageCandidate(section));
    if (genericSections.length > 0) return genericSections;

    const firstVisual = Array.from((wrapper || root).children).find(isElementVisiblePageCandidate);
    return firstVisual ? [firstVisual] : [];
}

function readCssPx(value) {
    const numeric = Number.parseFloat(String(value || '').replace('px', '').trim());
    return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function getDocxPageMetrics(page) {
    const computed = window.getComputedStyle(page);
    const paddingTop = Math.max(0, Math.round(readCssPx(computed.paddingTop) || readCssPx(page.style.paddingTop)));
    const paddingRight = Math.max(0, Math.round(readCssPx(computed.paddingRight) || readCssPx(page.style.paddingRight)));
    const paddingBottom = Math.max(0, Math.round(readCssPx(computed.paddingBottom) || readCssPx(page.style.paddingBottom)));
    const paddingLeft = Math.max(0, Math.round(readCssPx(computed.paddingLeft) || readCssPx(page.style.paddingLeft)));
    const baseWidth = Math.max(
        320,
        Math.round(
            readCssPx(computed.width)
            || readCssPx(page.style.width)
            || page.offsetWidth
            || 794
        )
    );
    const basePageHeight = Math.max(
        480,
        Math.round(
            readCssPx(computed.minHeight)
            || readCssPx(page.style.minHeight)
            || readCssPx(computed.height)
            || readCssPx(page.style.height)
            || 1123
        )
    );
    const totalHeight = Math.max(
        basePageHeight,
        Math.round(
            page.scrollHeight
            || page.offsetHeight
            || basePageHeight
        )
    );
    const contentWidth = Math.max(120, baseWidth - paddingLeft - paddingRight);
    const contentPageHeight = Math.max(240, basePageHeight - paddingTop - paddingBottom);
    const contentTotalHeight = Math.max(
        contentPageHeight,
        totalHeight - paddingTop - paddingBottom
    );
    return {
        baseWidth,
        basePageHeight,
        totalHeight,
        paddingTop,
        paddingRight,
        paddingBottom,
        paddingLeft,
        contentWidth,
        contentPageHeight,
        contentTotalHeight
    };
}

function shouldVirtualizeDocxPage(page, metrics, pageCount) {
    if (!page || !metrics) return false;
    if (Number(pageCount || 0) !== 1) return false;
    if (metrics.basePageHeight < 700) return false;
    return metrics.totalHeight > (metrics.basePageHeight * 1.18);
}

function normalizeExpectedDocxPageCount(expectedPageCount) {
    const numeric = Number(expectedPageCount);
    return Number.isFinite(numeric) && numeric >= 1 ? Math.floor(numeric) : 0;
}

function resolveVirtualDocxPageCount(metrics, expectedPageCount) {
    const actualPageCount = Math.max(1, Math.ceil(metrics.contentTotalHeight / metrics.contentPageHeight));
    const normalizedExpected = normalizeExpectedDocxPageCount(expectedPageCount);
    if (normalizedExpected && actualPageCount === normalizedExpected + 1) {
        return normalizedExpected;
    }
    return actualPageCount;
}

function createVirtualDocxPageSlices(page, metrics, expectedPageCount = 0) {
    const totalPages = resolveVirtualDocxPageCount(metrics, expectedPageCount);
    if (totalPages <= 1) return [page];

    const slices = [];
    for (let index = 0; index < totalPages; index += 1) {
        const slice = document.createElement('div');
        slice.className = 'docx-virtual-page';
        slice.dataset.baseWidth = String(metrics.baseWidth);
        slice.dataset.baseHeight = String(metrics.basePageHeight);
        slice.style.position = 'relative';
        slice.style.width = `${metrics.baseWidth}px`;
        slice.style.height = `${metrics.basePageHeight}px`;
        slice.style.minHeight = `${metrics.basePageHeight}px`;
        slice.style.boxSizing = 'border-box';
        slice.style.overflow = 'hidden';
        slice.style.background = '#fff';

        const contentViewport = document.createElement('div');
        contentViewport.className = 'docx-virtual-page-viewport';
        contentViewport.style.position = 'absolute';
        contentViewport.style.left = `${metrics.paddingLeft}px`;
        contentViewport.style.top = `${metrics.paddingTop}px`;
        contentViewport.style.width = `${metrics.contentWidth}px`;
        contentViewport.style.height = `${metrics.contentPageHeight}px`;
        contentViewport.style.overflow = 'hidden';
        contentViewport.style.boxSizing = 'border-box';
        contentViewport.style.pointerEvents = 'none';

        const layer = page.cloneNode(true);
        layer.classList.add('docx-virtual-page-layer');
        layer.style.position = 'absolute';
        layer.style.left = '0';
        layer.style.top = `${-1 * index * metrics.contentPageHeight}px`;
        layer.style.margin = '0';
        layer.style.boxShadow = 'none';
        layer.style.transform = 'none';
        layer.style.pointerEvents = 'none';
        layer.style.background = 'transparent';
        layer.style.width = `${metrics.contentWidth}px`;
        layer.style.minHeight = '0';
        layer.style.height = 'auto';
        layer.style.padding = '0';
        layer.style.border = '0';
        layer.style.borderRadius = '0';
        layer.style.overflow = 'visible';

        contentViewport.appendChild(layer);
        slice.appendChild(contentViewport);
        slices.push(slice);
    }

    return slices;
}

export function wrapPreviewPageShell(page) {
    if (!page || page.nodeType !== 1) return null;
    const baseWidth = Number(page.dataset.baseWidth || page.offsetWidth || 794);
    const baseHeight = Number(page.dataset.baseHeight || page.offsetHeight || 1123);

    let shell = page.parentElement;
    if (!shell || !shell.classList?.contains('editor-page-shell')) {
        shell = document.createElement('div');
        shell.className = 'editor-page-shell';
        page.parentNode?.insertBefore(shell, page);
        shell.appendChild(page);
    }

    shell.style.position = 'relative';
    shell.style.display = 'block';
    shell.style.width = `${baseWidth}px`;
    shell.style.height = `${baseHeight}px`;
    shell.style.minHeight = `${baseHeight}px`;
    shell.style.margin = '0 auto 32px auto';
    shell.style.padding = '0';
    shell.style.boxSizing = 'border-box';
    shell.style.overflow = 'hidden';
    shell.style.flex = '0 0 auto';

    page.classList.add('editor-page-wrapper');
    page.style.position = 'relative';
    page.style.left = '';
    page.style.top = '0';
    page.style.display = 'block';
    page.style.margin = '0';
    page.style.width = `${baseWidth}px`;
    page.style.minHeight = `${baseHeight}px`;
    page.style.boxSizing = 'border-box';
    page.style.overflow = 'visible';
    page.style.transformOrigin = 'top left';
    page.style.transform = 'none';
    page.style.pointerEvents = 'auto';

    return shell;
}

async function sourceToArrayBuffer(source) {
    const normalized = normalizeDocxSource(source);
    if (!normalized) {
        throw new Error('DOCXプレビュー元データが見つかりません');
    }
    if (normalized instanceof Blob) {
        return normalized.arrayBuffer();
    }
    const response = await fetch(normalized);
    return response.arrayBuffer();
}

export function isDocxFileName(value) {
    return /\.(docx?|dotx?)$/i.test(String(value || '').trim());
}

export async function loadDocxPreviewAssets() {
    await loadScriptOnce(
        'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
        () => Boolean(window.JSZip)
    );
    await loadScriptOnce(
        'https://cdn.jsdelivr.net/npm/docx-preview@0.3.6/dist/docx-preview.min.js',
        () => Boolean(window.docx && typeof window.docx.renderAsync === 'function')
    );
}

export async function renderDocxPreviewPages(container, source, options = {}) {
    if (!container) return [];
    const expectedPageCount = normalizeExpectedDocxPageCount(options?.expectedPageCount);

    // Word 原本の見た目を守るため、署名画面の主経路は docx-preview のネイティブ描画を維持する。
    // 別レイアウトへの自動変換を再導入すると、フォントや余白が変わって回帰しやすい。
    container.innerHTML = '';
    const loading = document.createElement('div');
    loading.style.minHeight = '420px';
    loading.style.display = 'flex';
    loading.style.flexDirection = 'column';
    loading.style.alignItems = 'center';
    loading.style.justifyContent = 'center';
    loading.style.color = '#6b7280';
    loading.innerHTML = `
        <div class="loader-spinner" style="margin-bottom:18px;"></div>
        <p style="margin:0; font-size:13px; font-weight:600;">Wordプレビューを準備中...</p>
    `;
    container.appendChild(loading);

    await loadDocxPreviewAssets();
    const arrayBuffer = await sourceToArrayBuffer(source);

    const staging = document.createElement('div');
    staging.style.position = 'absolute';
    staging.style.left = '-20000px';
    staging.style.top = '0';
    staging.style.width = '1000px';
    staging.style.visibility = 'hidden';
    staging.style.pointerEvents = 'none';
    staging.style.overflow = 'hidden';
    container.appendChild(staging);

    const renderRoot = document.createElement('div');
    renderRoot.className = 'sign-docx-render-root';
    renderRoot.style.width = '100%';
    renderRoot.style.display = 'flex';
    renderRoot.style.flexDirection = 'column';
    renderRoot.style.alignItems = 'center';
    staging.appendChild(renderRoot);

    await window.docx.renderAsync(arrayBuffer, renderRoot, null, {
        inWrapper: true,
        breakPages: true,
        ignoreWidth: false,
        ignoreHeight: false,
        renderHeaders: true,
        renderFooters: true,
        useBase64URL: true
    });
    await nextFrame();
    await nextFrame();

    const docxWrapper = renderRoot.querySelector('.docx-wrapper');
    if (docxWrapper) {
        docxWrapper.style.width = 'auto';
        docxWrapper.style.background = 'transparent';
        docxWrapper.style.padding = '0';
        docxWrapper.style.margin = '0 auto';
    }

    const rawPages = collectDocxPages(renderRoot);
    const pages = [];

    rawPages.forEach((page) => {
        const metrics = getDocxPageMetrics(page);
        if (shouldVirtualizeDocxPage(page, metrics, rawPages.length)) {
            const slices = createVirtualDocxPageSlices(page, metrics, expectedPageCount);
            const parent = page.parentNode;
            if (parent) {
                slices.forEach((slice) => parent.insertBefore(slice, page));
                parent.removeChild(page);
            }
            pages.push(...slices);
            return;
        }

        page.dataset.baseWidth = String(metrics.baseWidth);
        page.dataset.baseHeight = String(metrics.totalHeight);
        pages.push(page);
    });

    if (expectedPageCount && pages.length === expectedPageCount + 1) {
        const extras = pages.splice(expectedPageCount);
        extras.forEach((page) => page?.parentNode?.removeChild(page));
    }

    pages.forEach((page) => {
        page.style.background = page.style.background || '#fff';
        page.style.boxShadow = page.style.boxShadow || '0 8px 30px rgba(0,0,0,0.15)';
        wrapPreviewPageShell(page);
    });

    loading.remove();
    staging.style.position = 'relative';
    staging.style.left = '0';
    staging.style.top = '0';
    staging.style.width = '100%';
    staging.style.visibility = 'visible';
    staging.style.pointerEvents = 'auto';
    staging.style.overflow = 'visible';

    return pages;
}

function resolveDocxPreviewHtmlApiBase() {
    const explicit = (typeof window !== 'undefined' && typeof window.__DIFFSENSE_API_BASE__ === 'string')
        ? String(window.__DIFFSENSE_API_BASE__ || '').trim()
        : '';
    if (explicit) return explicit.replace(/\/+$/, '');
    if (typeof location !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
        return 'http://localhost:3001';
    }
    return 'https://api-qf37m5ba2q-an.a.run.app';
}

function createDocxHtmlPage() {
    const page = document.createElement('div');
    page.className = 'docx-html-page';
    page.dataset.baseWidth = '794';
    page.dataset.baseHeight = '1123';
    return page;
}

async function measureDocxHtmlPageBaseline(root) {
    const probe = createDocxHtmlPage();
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    root.appendChild(probe);
    await nextFrame();
    await nextFrame();
    const baseline = Math.max(
        1123,
        Math.ceil(
            probe.scrollHeight
            || probe.clientHeight
            || probe.offsetHeight
            || 1123
        )
    );
    root.removeChild(probe);
    return baseline;
}

export async function renderDocxPreviewHtml(container, contractId, authToken) {
    if (!container) return [];

    container.innerHTML = '';

    const loading = document.createElement('div');
    loading.style.minHeight = '420px';
    loading.style.display = 'flex';
    loading.style.flexDirection = 'column';
    loading.style.alignItems = 'center';
    loading.style.justifyContent = 'center';
    loading.style.color = '#6b7280';
    loading.innerHTML = `
        <div class="loader-spinner" style="margin-bottom:18px;"></div>
        <p style="margin:0; font-size:13px; font-weight:600;">Wordプレビューを準備中...</p>
    `;
    container.appendChild(loading);

    const apiBase = resolveDocxPreviewHtmlApiBase();
    const response = await fetch(`${apiBase}/api/contracts/${encodeURIComponent(contractId)}/preview-html`, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
    });
    if (!response.ok) {
        throw new Error(`preview-html fetch failed: ${response.status}`);
    }
    const { html } = await response.json();

    container.innerHTML = '';

    const style = document.createElement('style');
    style.textContent = `
        .docx-html-root {
            font-family: 'Noto Serif JP', 'MS Mincho', serif;
            font-size: 10.5pt;
            line-height: 1.8;
            color: #000;
            width: 100%;
            margin: 0 auto;
        }
        .docx-html-page {
            width: 794px;
            min-height: 1123px;
            padding: 80px 90px;
            background: #fff;
            box-shadow: 0 8px 30px rgba(0,0,0,0.15);
            box-sizing: border-box;
            margin: 0 auto 32px auto;
            border-radius: 4px;
            overflow: hidden;
            position: relative;
        }
        .docx-html-root h1 { font-size: 14pt; font-weight: bold; text-align: center; margin: 16px 0; }
        .docx-html-root h2 { font-size: 12pt; font-weight: bold; margin: 12px 0; }
        .docx-html-root h3 { font-size: 11pt; font-weight: bold; margin: 8px 0; }
        .docx-html-root p { margin: 4px 0; }
        .docx-html-root table { border-collapse: collapse; width: 100%; margin: 8px 0; }
        .docx-html-root td, .docx-html-root th { border: 1px solid #999; padding: 4px 8px; }
    `;
    container.appendChild(style);

    const staging = document.createElement('div');
    staging.style.position = 'absolute';
    staging.style.left = '-20000px';
    staging.style.top = '0';
    staging.style.width = '1000px';
    staging.style.visibility = 'hidden';
    staging.style.pointerEvents = 'none';
    staging.style.overflow = 'hidden';
    container.appendChild(staging);

    const root = document.createElement('div');
    root.className = 'docx-html-root';
    staging.appendChild(root);

    const pageBaseline = await measureDocxHtmlPageBaseline(root);
    const firstPage = createDocxHtmlPage();
    firstPage.innerHTML = String(html || '');
    root.appendChild(firstPage);

    await nextFrame();
    await nextFrame();

    const pages = [firstPage];
    const needsSplit = firstPage.scrollHeight > (pageBaseline + 2);
    if (needsSplit) {
        const children = Array.from(firstPage.children);
        firstPage.innerHTML = '';

        let currentPage = firstPage;
        for (const child of children) {
            currentPage.appendChild(child);
            await nextFrame();

            const overflows = currentPage.scrollHeight > (pageBaseline + 2);
            if (overflows && currentPage.children.length > 1) {
                currentPage.removeChild(child);

                const nextPageEl = createDocxHtmlPage();
                root.appendChild(nextPageEl);
                pages.push(nextPageEl);
                currentPage = nextPageEl;
                currentPage.appendChild(child);
                await nextFrame();
            }
        }
    }

    pages.forEach((page) => {
        const renderedHeight = Math.max(
            1123,
            Math.ceil(page.scrollHeight || page.offsetHeight || Number(page.dataset.baseHeight || 0) || 1123)
        );
        page.dataset.baseWidth = '794';
        page.dataset.baseHeight = String(renderedHeight);
        wrapPreviewPageShell(page);
    });

    loading.remove();
    staging.style.position = 'relative';
    staging.style.left = '0';
    staging.style.top = '0';
    staging.style.width = '100%';
    staging.style.visibility = 'visible';
    staging.style.pointerEvents = 'auto';
    staging.style.overflow = 'visible';

    return pages;
}
