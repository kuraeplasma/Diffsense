document.addEventListener('DOMContentLoaded', () => {

    // Mobile Menu Toggle
    const menuToggle = document.querySelector('.menu-toggle');
    const nav = document.querySelector('.nav');

    if (menuToggle && nav) {
        menuToggle.addEventListener('click', () => {
            menuToggle.classList.toggle('active');
            nav.classList.toggle('active');
            document.body.classList.toggle('no-scroll');
        });

        // Close menu when a link is clicked
        const navLinks = nav.querySelectorAll('a');
        navLinks.forEach(link => {
            link.addEventListener('click', () => {
                menuToggle.classList.remove('active');
                nav.classList.remove('active');
                document.body.classList.remove('no-scroll');
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

    const fadeElements = document.querySelectorAll('.card, .step-item, .section-title, .hero-content');

    fadeElements.forEach(el => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(20px)';
        el.style.transition = 'opacity 0.6s ease-out, transform 0.6s ease-out';
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

        const baseWidth = 1100;
        // Current height doesn't matter for desktop scale logic which uses baseHeight
        const baseHeight = 750;

        // Get container width
        const availableWidth = container.clientWidth;
        if (availableWidth === 0) return;

        // Calculate scale
        let scale = availableWidth / baseWidth;

        if (windowWidth >= 768) {
            // Desktop: Subtly enlarged but balanced
            scale = Math.min(scale * 1.08, 1.15);
        }

        // Apply scale and RETAIN 3D transform
        let transformString = `scale(${scale})`;
        if (windowWidth >= 992) {
            transformString += ' rotateY(-12deg) rotateX(2deg)';
            dashboard.style.boxShadow = '-20px 30px 60px rgba(0, 0, 0, 0.25)';
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
    scaleDashboard();
    window.addEventListener('resize', scaleDashboard);
});
