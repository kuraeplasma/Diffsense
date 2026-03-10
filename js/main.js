document.addEventListener('DOMContentLoaded', () => {

    // Mobile Menu Toggle
    const menuToggle = document.querySelector('.menu-toggle');
    const nav = document.querySelector('.nav');

    if (menuToggle && nav) {
        menuToggle.addEventListener('click', () => {
            menuToggle.classList.toggle('active');
            nav.classList.toggle('active');
        });

        // Close menu when a link is clicked
        const navLinks = nav.querySelectorAll('a');
        navLinks.forEach(link => {
            link.addEventListener('click', () => {
                menuToggle.classList.remove('active');
                nav.classList.remove('active');
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

    // Auto horizontal scroll for "user voices" cards
    function initUserVoicesAutoScroll() {
        const tracks = Array.from(document.querySelectorAll('.user-voices-scroll'));
        if (!tracks.length) return;

        tracks.forEach((track) => {
            if (track.dataset.autoScrollInitialized === 'true') return;
            if (track.offsetParent === null) return;

            const cards = Array.from(track.querySelectorAll('.user-voice-card'));
            if (cards.length < 2) return;

            // Shuffle cards to avoid fixed order feeling
            const shuffled = [...cards];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }

            track.innerHTML = '';
            shuffled.forEach(card => {
                track.appendChild(card);
            });

            // Duplicate once to make seamless infinite loop
            shuffled.forEach(card => {
                const clone = card.cloneNode(true);
                clone.setAttribute('aria-hidden', 'true');
                track.appendChild(clone);
            });

            const loopWidth = track.scrollWidth / 2;
            if (loopWidth <= 0) return;

            track.dataset.autoScrollInitialized = 'true';

            let rafId = null;
            let position = 0;
            let lastTs = null;
            const speedPxPerSec = window.innerWidth <= 768 ? 14 : 18;

            const tick = (ts) => {
                if (lastTs === null) lastTs = ts;
                const deltaSec = (ts - lastTs) / 1000;
                lastTs = ts;

                position += speedPxPerSec * deltaSec;
                if (position >= loopWidth) {
                    position -= loopWidth;
                }
                track.scrollLeft = position;
                rafId = requestAnimationFrame(tick);
            };

            rafId = requestAnimationFrame(tick);

            window.addEventListener('beforeunload', () => {
                if (rafId) cancelAnimationFrame(rafId);
            });
        });
    }
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

    function getApiBase() {
        return (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
            ? 'http://localhost:3001'
            : 'https://api-qf37m5ba2q-an.a.run.app';
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
    initUserVoicesAutoScroll();
    initPricingBillingToggle();
    scaleDashboard();
    window.addEventListener('resize', initUserVoicesAutoScroll);
    window.addEventListener('resize', scaleDashboard);
});
