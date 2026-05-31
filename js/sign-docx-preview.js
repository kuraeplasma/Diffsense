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

function getElementOuterHeight(element) {
    if (!element || element.nodeType !== 1) return 0;
    const style = window.getComputedStyle(element);
    const marginTop = readCssPx(style.marginTop);
    const marginBottom = readCssPx(style.marginBottom);
    const rectHeight = element.getBoundingClientRect?.().height || 0;
    return Math.max(1, rectHeight || element.offsetHeight || element.scrollHeight || 1) + marginTop + marginBottom;
}

function getSplittableDocxChildren(page) {
    if (!page || page.nodeType !== 1) return [];
    const directChildren = Array.from(page.children || []).filter(isElementVisiblePageCandidate);
    if (directChildren.length > 1) return directChildren;
    const leafChildren = collectDocxLeafElements(page).filter(isElementVisiblePageCandidate);
    return leafChildren.length > 1 ? leafChildren : directChildren;
}

function splitDocxPageByRenderedHeight(page, targetParts = 0) {
    if (!page || page.nodeType !== 1 || !page.parentNode) return [page].filter(Boolean);
    const children = getSplittableDocxChildren(page);
    if (children.length <= 1) return [page];

    const metrics = getDocxPageMetrics(page);
    const contentLimit = Math.max(360, metrics.contentPageHeight || (metrics.basePageHeight - metrics.paddingTop - metrics.paddingBottom) || 960);
    const measuredChildren = children.map(child => ({ child, height: getElementOuterHeight(child) }));
    const measuredHeight = Math.max(metrics.contentTotalHeight || 0, measuredChildren.reduce((sum, item) => sum + item.height, 0));
    const naturalParts = Math.max(1, Math.ceil(measuredHeight / contentLimit));
    const desiredParts = Math.max(1, Math.round(Number(targetParts) || naturalParts));
    if (desiredParts <= 1 && measuredHeight <= contentLimit * 1.08) return [page];

    const parent = page.parentNode;
    const pages = [page];
    page.innerHTML = '';
    page.style.minHeight = `${metrics.basePageHeight}px`;
    page.style.height = '';
    page.dataset.baseHeight = String(metrics.basePageHeight);

    let currentPage = page;
    let currentHeight = 0;
    const threshold = Math.max(240, Math.floor(contentLimit * 0.985));

    measuredChildren.forEach(({ child, height: childHeight }) => {
        const shouldStartNext = currentPage.children.length > 0
            && currentHeight + childHeight > threshold
            && pages.length < desiredParts;

        if (shouldStartNext) {
            currentPage = createSmartDocxPageContainer(page);
            currentPage.style.minHeight = `${metrics.basePageHeight}px`;
            currentPage.style.height = '';
            currentPage.dataset.baseWidth = String(metrics.baseWidth);
            currentPage.dataset.baseHeight = String(metrics.basePageHeight);
            parent.insertBefore(currentPage, pages[pages.length - 1].nextSibling);
            pages.push(currentPage);
            currentHeight = 0;
        }

        currentPage.appendChild(child);
        currentHeight += childHeight;
    });

    return pages.filter(candidate => candidate.textContent?.trim() || candidate.children.length);
}

function splitDocxPagesToExpectedCount(pages, expectedPageCount) {
    const expected = normalizeExpectedDocxPageCount(expectedPageCount);
    if (!expected || !Array.isArray(pages) || pages.length >= expected) return pages;

    let nextPages = [...pages];
    let guard = 0;
    while (nextPages.length < expected && guard < expected * 2) {
        guard += 1;
        const candidate = nextPages
            .map((page, index) => {
                const metrics = getDocxPageMetrics(page);
                const children = getSplittableDocxChildren(page);
                const ratio = metrics.contentTotalHeight / Math.max(1, metrics.contentPageHeight);
                return { page, index, ratio, children: children.length };
            })
            .filter(item => item.children > 1 && item.ratio > 1.08)
            .sort((a, b) => b.ratio - a.ratio)[0];

        if (!candidate) break;
        const missing = expected - nextPages.length;
        const targetParts = Math.min(missing + 1, Math.max(2, Math.ceil(candidate.ratio)));
        const splitPages = splitDocxPageByRenderedHeight(candidate.page, targetParts);
        if (splitPages.length <= 1) break;
        nextPages.splice(candidate.index, 1, ...splitPages);
    }

    return nextPages;
}

function mergeDocxPagesToExpectedCount(pages, expectedPageCount) {
    const expected = normalizeExpectedDocxPageCount(expectedPageCount);
    if (!expected || !Array.isArray(pages) || pages.length <= expected) return pages;
    const kept = pages.slice(0, expected);
    const last = kept[kept.length - 1];
    pages.slice(expected).forEach((page) => {
        while (page?.firstChild) {
            last.appendChild(page.firstChild);
        }
        page?.remove();
    });
    return kept;
}

function createSmartDocxPageContainer(originalPage) {
    const page = document.createElement('section');
    if (originalPage) {
        page.style.cssText = originalPage.style.cssText;
    }
    page.className = 'docx-section docx-smart-page';
    page.style.background = '#fff';
    page.style.width = '794px';
    page.style.minHeight = '1123px';
    page.style.padding = '80px 90px';
    page.style.margin = '0 auto 16px auto';
    page.style.boxSizing = 'border-box';
    page.style.boxShadow = '0 8px 30px rgba(0,0,0,0.15)';
    page.style.position = 'relative';
    page.style.overflow = 'visible';
    page.style.border = 'none';
    page.style.outline = 'none';
    page.dataset.baseWidth = '794';
    page.dataset.baseHeight = '1123';
    return page;
}

function collectDocxLeafElements(root) {
    const leaves = [];
    const candidates = ['P', 'TABLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'PRE', 'DIV'];
    function walk(node) {
        if (node.nodeType !== 1) return;
        const isWrapper = /(^|\s)(docx-wrapper|docx-section)(\s|$)/i.test(node.className || '');
        // Structural DIVs that wrap other elements would otherwise be pushed as a single
        // tall leaf, causing one giant chunk to stay together on a single page. Recurse
        // into DIVs that contain element children so the inner paragraphs become leaves.
        if (node.tagName === 'DIV' && !isWrapper && node.children.length > 0) {
            Array.from(node.children).forEach(walk);
            return;
        }
        const isCandidate = candidates.includes(node.tagName.toUpperCase());
        if (isCandidate && !isWrapper) {
            leaves.push(node);
        } else {
            Array.from(node.children).forEach(walk);
        }
    }
    walk(root);
    return leaves;
}

async function smartChunkDocxPages(root, options = {}) {
    const expectedPageCount = normalizeExpectedDocxPageCount(options?.expectedPageCount);
    // Prefer docx-preview's natural sections when the document has explicit page breaks.
    const naturalPages = collectDocxPages(root);
    if (expectedPageCount && naturalPages.length >= expectedPageCount) {
        return mergeDocxPagesToExpectedCount(naturalPages, expectedPageCount);
    }
    if (naturalPages.length > 1) {
        return splitDocxPagesToExpectedCount(naturalPages, expectedPageCount);
    }
    if (expectedPageCount === 1 && naturalPages.length === 1) {
        return naturalPages;
    }

    // Fallback: when only 1 section was produced and its content overflows A4 height,
    // visually split into multiple A4 pages so the viewer can paginate.
    const docxWrapper = root.querySelector('.docx-wrapper');
    if (!docxWrapper) return naturalPages;

    const singlePage = naturalPages[0] || null;
    const totalHeight = singlePage ? (singlePage.scrollHeight || singlePage.offsetHeight || 0) : 0;
    if (totalHeight && totalHeight <= 1400) return naturalPages;

    const allElements = collectDocxLeafElements(docxWrapper);
    if (allElements.length === 0) return naturalPages;

    // Pre-measure heights ONCE before any DOM manipulation. Calling getBoundingClientRect
    // inside the chunk loop after each appendChild causes layout thrashing (one reflow
    // per element), which can freeze the UI on documents with 100+ paragraphs.
    // Include vertical margins so headings (which often have large top/bottom margins
    // in Word documents) aren't undercounted and don't cause overflow past the A4 frame.
    const heights = allElements.map((el) => {
        const style = window.getComputedStyle(el);
        const marginTop = parseFloat(style.marginTop) || 0;
        const marginBottom = parseFloat(style.marginBottom) || 0;
        return Math.max(10, (el.offsetHeight || 20) + marginTop + marginBottom);
    });

    const originalSections = Array.from(docxWrapper.querySelectorAll('section'));
    const baseStyleSection = originalSections[0] || null;

    docxWrapper.innerHTML = '';
    const pages = [];
    let currentPage = createSmartDocxPageContainer(baseStyleSection);
    docxWrapper.appendChild(currentPage);
    pages.push(currentPage);

    let currentHeight = 0;
    const pageHeightThreshold = 960;

    for (let i = 0; i < allElements.length; i++) {
        const el = allElements[i];
        if (el.nodeType !== 1) continue;
        const elHeight = heights[i];
        currentPage.appendChild(el);
        if (currentHeight + elHeight > pageHeightThreshold && currentPage.children.length > 1) {
            currentPage = createSmartDocxPageContainer(baseStyleSection);
            docxWrapper.appendChild(currentPage);
            pages.push(currentPage);
            currentPage.appendChild(el);
            currentHeight = elHeight;
        } else {
            currentHeight += elHeight;
        }
    }

    return mergeDocxPagesToExpectedCount(
        splitDocxPagesToExpectedCount(pages, expectedPageCount),
        expectedPageCount
    );
}

function normalizeExpectedDocxPageCount(expectedPageCount) {
    const numeric = Number(expectedPageCount);
    return Number.isFinite(numeric) && numeric >= 1 ? Math.floor(numeric) : 0;
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
    shell.style.width = '';
    shell.style.height = '';
    shell.style.minHeight = '';
    shell.style.margin = '24px auto';
    shell.style.padding = '0';
    shell.style.boxSizing = 'border-box';
    shell.style.overflow = 'visible';
    shell.style.flex = '0 0 auto';
    shell.dataset.baseWidth = String(baseWidth);
    shell.dataset.baseHeight = String(baseHeight);

    page.classList.add('editor-page-wrapper');
    page.style.position = 'relative';
    page.style.left = '';
    page.style.top = '0';
    page.style.display = 'block';
    if (!page.style.margin) page.style.margin = '0 auto';
    page.style.boxSizing = 'border-box';
    page.style.overflow = 'visible';
    page.style.transformOrigin = 'top left';
    page.style.transform = 'none';
    page.style.pointerEvents = 'auto';
    page.style.border = 'none';
    page.style.outline = 'none';

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
    // Note: URL fetching here is a fallback. 
    // High-fidelity edit mode should pass a Blob from getDocxSourceForMammoth.
    const response = await fetch(normalized);
    if (!response.ok) {
        throw new Error(`DOCX fetch failed: ${response.status} (URL: ${normalized})`);
    }
    return response.arrayBuffer();
}

export function isDocxFileName(value) {
    return /\.(docx?|dotx?)$/i.test(String(value || '').trim());
}

export async function loadDocxPreviewAssets() {
    document.getElementById('docx-internal-reset')?.remove();

    await loadScriptOnce(
        'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
        () => Boolean(window.JSZip)
    );
    await loadScriptOnce(
        'https://cdn.jsdelivr.net/npm/docx-preview@0.3.6/dist/docx-preview.min.js',
        () => Boolean(window.docx && typeof window.docx.renderAsync === 'function')
    );
}

export async function renderDocxPreviewAsEditor(source, options = {}) {
    await loadDocxPreviewAssets();
    const arrayBuffer = await sourceToArrayBuffer(source);
    const expectedPageCount = normalizeExpectedDocxPageCount(options?.expectedPageCount);

    const staging = document.createElement('div');
    staging.style.cssText = 'position:fixed;left:-20000px;top:0;width:900px;visibility:hidden;pointer-events:none;overflow:hidden;';
    document.body.appendChild(staging);

    const renderRoot = document.createElement('div');
    staging.appendChild(renderRoot);

    try {
        await window.docx.renderAsync(arrayBuffer, renderRoot, null, {
            inWrapper: true,
            breakPages: true,
            ignoreLastRenderedPageBreak: false,
            ignoreWidth: false,
            ignoreHeight: false,
            renderHeaders: true,
            renderFooters: true,
            useBase64URL: true
        });

        await nextFrame();
        await nextFrame();

        const pages = await smartChunkDocxPages(renderRoot, { expectedPageCount });
        return pages.map(page => {
            page.style.position = 'relative';
            page.style.left = '';
            page.style.top = '';
            page.style.right = '';
            page.style.bottom = '';
            page.style.transform = '';
            page.style.margin = '0 auto';
            page.style.width = '794px';
            page.style.boxSizing = 'border-box';
            page.style.background = '#fff';
            page.remove();
            return page;
        });
    } finally {
        staging.remove();
    }
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
        ignoreLastRenderedPageBreak: false,
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
        docxWrapper.style.width = '100%';
        docxWrapper.style.background = 'transparent';
        docxWrapper.style.margin = '0 auto';
    }

    const pages = await smartChunkDocxPages(renderRoot, { expectedPageCount });

    pages.forEach((page) => {
        const metrics = getDocxPageMetrics(page);
        page.dataset.baseWidth = String(metrics.baseWidth);
        const renderedHeight = Math.max(metrics.basePageHeight, page.scrollHeight || page.offsetHeight || metrics.basePageHeight);
        page.dataset.baseHeight = String(renderedHeight);
        wrapPreviewPageShell(page);
    });

    if (expectedPageCount && pages.length > expectedPageCount) {
        const mergedPages = mergeDocxPagesToExpectedCount(pages, expectedPageCount);
        pages.splice(0, pages.length, ...mergedPages);
    }

    pages.forEach((page) => {
        page.style.background = page.style.background || '#fff';
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
            margin: 0 auto 16px auto;
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
