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

    // Run on load and resize
    initUserVoicesAutoScroll();
    scaleDashboard();
    window.addEventListener('resize', initUserVoicesAutoScroll);
    window.addEventListener('resize', scaleDashboard);
});
