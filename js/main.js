document.addEventListener('DOMContentLoaded', () => {
    const PROD_API_BASE_URL = 'https://api-qf37m5ba2q-an.a.run.app';

    function getApiBase() {
        const params = new URLSearchParams(window.location.search);
        const explicit = String(
            window.__DIFFSENSE_API_BASE__
            || params.get('apiBase')
            || localStorage.getItem('diffsense_api_base')
            || ''
        ).trim().replace(/\/$/, '');
        if (explicit) return explicit;

        const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        return isLocalHost ? 'http://localhost:3001' : PROD_API_BASE_URL;
    }

    function initContactModal() {
        const modal = document.getElementById('contact-modal');
        const form = document.getElementById('contact-form');
        const complete = document.getElementById('contact-complete');
        const statusEl = document.getElementById('contact-form-status');
        const openers = document.querySelectorAll('[data-contact-open]');
        if (!modal || !form || !openers.length) return;

        const submitBtn = form.querySelector('.contact-form__submit');
        const firstInput = form.querySelector('input[name="name"]');
        const pausedMessage = '現在お問い合わせが集中しているため、メール送信を一時停止しています。\nお手数ですが contact@spacegleam.co.jp まで直接ご連絡ください。';

        const setStatus = (message, type = '') => {
            if (!statusEl) return;
            statusEl.textContent = message || '';
            statusEl.classList.toggle('is-error', type === 'error');
            statusEl.classList.toggle('is-success', type === 'success');
        };

        const showComplete = () => {
            form.classList.add('is-complete');
            if (complete) complete.hidden = false;
            setStatus('');
        };

        const openModal = (options = {}) => {
            modal.classList.add('is-open');
            modal.setAttribute('aria-hidden', 'false');
            document.body.classList.add('contact-modal-open');
            form.classList.remove('is-complete');
            if (complete) complete.hidden = true;
            setStatus('');
            if (options.complete) {
                showComplete();
                return;
            }
            window.setTimeout(() => firstInput?.focus(), 80);
        };

        const closeModal = () => {
            modal.classList.remove('is-open');
            modal.setAttribute('aria-hidden', 'true');
            document.body.classList.remove('contact-modal-open');
        };

        openers.forEach((opener) => {
            opener.addEventListener('click', (event) => {
                event.preventDefault();
                openModal();
            });
        });

        modal.querySelectorAll('[data-contact-close]').forEach((closer) => {
            closer.addEventListener('click', closeModal);
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && modal.classList.contains('is-open')) {
                closeModal();
            }
        });

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const formData = new FormData(form);
            const payload = {
                name: String(formData.get('name') || '').trim(),
                company: String(formData.get('company') || '').trim(),
                email: String(formData.get('email') || '').trim(),
                category: String(formData.get('category') || '').trim(),
                subject: String(formData.get('subject') || '').trim(),
                message: String(formData.get('message') || '').trim(),
                website: String(formData.get('website') || '').trim(),
                source: 'lp'
            };

            if (!payload.company || !payload.name || !payload.email || !payload.category || !payload.subject || payload.message.length < 10) {
                setStatus('必須項目を入力してください。お問い合わせ内容は10文字以上で入力してください。', 'error');
                return;
            }

            if (submitBtn) submitBtn.disabled = true;
            setStatus('送信しています...');

            try {
                const res = await fetch(`${getApiBase()}/api/contact`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                let json = null;
                try {
                    json = await res.json();
                } catch (_) {
                    json = null;
                }

                if (res.status === 503 || json?.code === 'CONTACT_MAIL_PAUSED') {
                    setStatus(json?.message || pausedMessage, 'error');
                    return;
                }

                if (!res.ok || json?.success === false) {
                    setStatus(json?.message || '送信に失敗しました。時間をおいて再度お試しください。', 'error');
                    return;
                }

                form.reset();
                setStatus(json?.message || 'お問い合わせを受け付けました。確認のうえご連絡します。', 'success');
                showComplete();
            } catch (_) {
                setStatus('送信に失敗しました。時間をおいて再度お試しください。', 'error');
            } finally {
                if (submitBtn) submitBtn.disabled = false;
            }
        });

        if (window.location.hash === '#contact') {
            openModal();
        } else if (window.location.hash === '#contact-complete') {
            openModal({ complete: true });
        }
    }

    // Mobile Menu Toggle
    const menuToggle = document.querySelector('.menu-toggle');
    const nav = document.querySelector('.nav');
    const headerRight = document.querySelector('.header-right');

    if (menuToggle && nav) {
        menuToggle.setAttribute('aria-expanded', 'false');
        menuToggle.addEventListener('click', () => {
            const isOpen = !nav.classList.contains('active');
            menuToggle.classList.toggle('active', isOpen);
            nav.classList.toggle('active', isOpen);
            headerRight?.classList.toggle('is-open', isOpen);
            menuToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        });

        // Close menu when a link is clicked
        const navLinks = nav.querySelectorAll('a');
        navLinks.forEach(link => {
            link.addEventListener('click', () => {
                menuToggle.classList.remove('active');
                nav.classList.remove('active');
                headerRight?.classList.remove('is-open');
                menuToggle.setAttribute('aria-expanded', 'false');
            });
        });
    }

    // Intersection Observer for scroll animations
    const observerOptions = {
        root: null,
        rootMargin: '0px',
        threshold: 0.1
    };

    const observer = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);

    const fadeElements = document.querySelectorAll('.card, .step-item, .section-title, .hero-content, .scroll-fade');

    fadeElements.forEach(el => {
        const rawDelay = Number(el.dataset.delay || 0);
        const delay = Number.isFinite(rawDelay) ? Math.max(rawDelay, 0) : 0;
        el.style.opacity = '0';
        el.style.transform = 'translateY(20px)';
        el.style.transition = `opacity 0.65s ease-out ${delay}ms, transform 0.65s ease-out ${delay}ms`;
        observer.observe(el);
    });

    // Add visible class styling
    const style = document.createElement('style');
    style.innerHTML = `
        .visible {
            opacity: 1 !important;
            transform: translateY(0) !important;
        }
    `;
    document.head.appendChild(style);

    // Dashboard Scaler
    function scaleDashboard() {
        const dashboard = document.querySelector('.dashboard-frame');
        const container = document.querySelector('.hero-visual');

        if (!dashboard || !container) return;

        // Static screenshot mode: avoid transform scaling to keep text crisp.
        if (dashboard.classList.contains('lp-static-frame')) {
            dashboard.style.transform = '';
            dashboard.style.transformOrigin = '';
            dashboard.style.boxShadow = '';
            dashboard.style.transition = '';
            container.style.height = '';
            container.style.display = 'flex';
            container.style.justifyContent = 'center';
            container.style.alignItems = 'center';
            return;
        }

        const windowWidth = window.innerWidth;

        if (windowWidth < 770) {
            // Mobile: Disable JS scaling to allow CSS-based "Focus Card" layout
            dashboard.style.transform = '';
            dashboard.style.transformOrigin = '';
            dashboard.style.boxShadow = '';
            dashboard.style.transition = '';
            container.style.height = '';
            container.style.display = '';
            container.style.justifyContent = '';
            container.style.alignItems = '';
            // CSS will handle hiding elements and showing the summary card
            return;
        }

        // Use actual frame size so both HTML mock and static screenshot are scaled correctly
        const baseWidth = dashboard.offsetWidth || 1100;
        const baseHeight = dashboard.offsetHeight || 750;

        // Get container width
        const availableWidth = container.clientWidth;
        if (availableWidth === 0) return;

        // Calculate scale
        let scale = availableWidth / baseWidth;

        if (windowWidth >= 768) {
            // Desktop: Subtly enlarged but balanced
            scale = Math.min(scale * 1.08, 1.15);
        }

        // Apply scale only (no tilt)
        let transformString = `scale(${scale})`;
        if (windowWidth >= 992) {
            dashboard.style.boxShadow = '0 24px 60px rgba(0, 0, 0, 0.25)';
            dashboard.style.transition = 'transform 0.5s ease, box-shadow 0.5s ease';
        } else {
            dashboard.style.boxShadow = '0 20px 50px -10px rgba(0, 0, 0, 0.3)';
            dashboard.style.transition = 'transform 0.5s ease';
        }

        dashboard.style.transform = transformString;
        dashboard.style.transformOrigin = 'center center';

        // Adjust container height
        container.style.height = `${baseHeight * scale}px`;
        container.style.display = 'flex';
        container.style.justifyContent = 'center';
        container.style.alignItems = 'center';
    }

    async function hasAnnualBillingPlans() {
        try {
            const res = await fetch(`${getApiBase()}/payment/config`, { cache: 'no-store' });
            if (!res.ok) return null;
            const json = await res.json();
            const annual = json?.data?.planIds?.annual;
            // UI fallback: if annual map is present, keep annual toggle available.
            return Boolean(annual && typeof annual === 'object');
        } catch (_) {
            return null;
        }
    }

    async function initPricingBillingToggle() {
        const pricingSection = document.querySelector('.pricing-section');
        const toggleButtons = Array.from(document.querySelectorAll('[data-billing-toggle]'));
        const planCards = Array.from(document.querySelectorAll('[data-plan-card]'));
        const billingNoteEl = document.querySelector('.pricing-billing-note');

        if (!pricingSection || !toggleButtons.length || !planCards.length) return;

        let annualEnabled = await hasAnnualBillingPlans();
        const annualBtn = toggleButtons.find((btn) => btn.dataset.billingToggle === 'annual');
        if (annualEnabled === false && annualBtn) {
            annualBtn.disabled = true;
            annualBtn.setAttribute('aria-disabled', 'true');
            annualBtn.textContent = '年額（準備中）';
            if (billingNoteEl) {
                billingNoteEl.textContent = '年額プランは現在準備中です。公開までしばらくお待ちください。';
            }
        }

        const buildPlanLink = (baseHref, cycle) => {
            if (!baseHref) return '#';
            const separator = baseHref.includes('?') ? '&' : '?';
            return `${baseHref}${separator}billing=${cycle}`;
        };

        const setBillingCycle = (cycle) => {
            if (annualEnabled === false && cycle === 'annual') {
                cycle = 'monthly';
            }
            const isAnnual = cycle === 'annual';

            toggleButtons.forEach((btn) => {
                const isActive = btn.dataset.billingToggle === cycle;
                btn.classList.toggle('is-active', isActive);
                btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
            });

            pricingSection.classList.toggle('is-annual-pricing', isAnnual);

            planCards.forEach((card) => {
                const amountEl = card.querySelector('[data-price-amount]');
                const subEl = card.querySelector('[data-price-sub]');
                const annualMetaEl = card.querySelector('[data-price-annual-meta]');
                const ctaEl = card.querySelector('[data-plan-cta]');

                const monthlyPrice = card.dataset.monthlyPrice;
                const annualPrice = card.dataset.annualPrice;
                const basePlanLink = card.dataset.planLink;
                const monthlyCta = card.dataset.ctaMonthly || '無料で始める';
                const annualCta = card.dataset.ctaAnnual || '年額で7日無料体験';

                if (isAnnual) {
                    if (amountEl && annualPrice) amountEl.textContent = annualPrice;
                    if (subEl) subEl.textContent = '/ 年（税込）';
                    if (annualMetaEl) annualMetaEl.hidden = false;
                    if (ctaEl) {
                        ctaEl.textContent = annualCta;
                        ctaEl.href = buildPlanLink(basePlanLink, 'annual');
                        ctaEl.style.whiteSpace = 'nowrap';
                        ctaEl.style.wordBreak = 'keep-all';
                        ctaEl.style.overflowWrap = 'normal';
                        ctaEl.style.letterSpacing = '0.01em';
                    }
                } else {
                    if (amountEl && monthlyPrice) amountEl.textContent = monthlyPrice;
                    if (subEl) subEl.textContent = '/ 月（税込）';
                    if (annualMetaEl) annualMetaEl.hidden = true;
                    if (ctaEl) {
                        ctaEl.textContent = monthlyCta;
                        ctaEl.href = buildPlanLink(basePlanLink, 'monthly');
                        ctaEl.style.whiteSpace = 'nowrap';
                        ctaEl.style.wordBreak = 'keep-all';
                        ctaEl.style.overflowWrap = 'normal';
                        ctaEl.style.letterSpacing = '0.01em';
                    }
                }
            });
        };

        toggleButtons.forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                setBillingCycle(btn.dataset.billingToggle);
            });
        });

        setBillingCycle('monthly');
    }

    // Run on load and resize
    initContactModal();
    initPricingBillingToggle();
    scaleDashboard();
    window.addEventListener('resize', scaleDashboard);
});
