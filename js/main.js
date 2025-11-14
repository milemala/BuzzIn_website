// 导航栏滚动效果
const ASSET_VERSION = '20251114';
const APP_STORE_URL = 'https://apps.apple.com/cn/app/id741292507';
const APK_DOWNLOAD_URL = '小红书.apk';
const ANDROID_GUIDE_URL = 'android-guide.html';
const IOS_GUIDE_URL = 'ios-appstore-guide.html';
const WECHAT_QR_IMAGE = `images/wechat-miniprogram-qr.jpg?v=${ASSET_VERSION}`;
const hoverMediaQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
const mobileMediaQuery = window.matchMedia('(max-width: 768px)');

document.addEventListener('DOMContentLoaded', () => {
    const navbar = document.querySelector('.navbar');
    const sections = document.querySelectorAll('section');
    
    // 滚动监听
    window.addEventListener('scroll', () => {
        if (navbar) {
            if (window.scrollY > 50) {
                navbar.classList.add('scrolled');
            } else {
                navbar.classList.remove('scrolled');
            }
        }

        // 滚动显示动画
        sections.forEach(section => {
            const sectionTop = section.offsetTop;
            const sectionHeight = section.clientHeight;
            if (window.pageYOffset >= (sectionTop - window.innerHeight/1.5)) {
                section.classList.add('visible');
            }
        });
    });

    if (navbar && window.scrollY > 50) {
        navbar.classList.add('scrolled');
    }

    // 平滑滚动
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth'
                });
            }
        });
    });

    // 动态NOW气泡效果 - 增强版（仅首页 hero 区启用）
    const heroMapBackground = document.querySelector('.hero .map-background');
    const createNowBubble = () => {
        const mapBackground = heroMapBackground;
        if (!mapBackground) return;
        
        const bubble = document.createElement('div');
        bubble.classList.add('now-bubble');
        
        // 随机选择颜色
        const colors = ['orange', 'green'];
        const randomColor = colors[Math.floor(Math.random() * colors.length)];
        bubble.classList.add(randomColor);
        
        // 随机选择大小
        const sizes = ['small', 'medium', 'large'];
        const randomSize = sizes[Math.floor(Math.random() * sizes.length)];
        bubble.classList.add(randomSize);
        
        // 随机位置
        bubble.style.left = Math.random() * 100 + '%';
        bubble.style.top = Math.random() * 100 + '%';
        
        // 随机延迟动画
        bubble.style.animationDelay = Math.random() * 2 + 's';
        
        // 随机动画持续时间
        bubble.style.animationDuration = (3 + Math.random() * 2) + 's';
        
        mapBackground.appendChild(bubble);
        
        // 添加淡入效果
        setTimeout(() => {
            bubble.style.opacity = '0.9';
        }, 100);
        
        // 6秒后淡出并移除
        setTimeout(() => {
            if (bubble.parentNode) {
                bubble.style.opacity = '0';
                setTimeout(() => {
                    if (bubble.parentNode) {
                        bubble.remove();
                    }
                }, 800);
            }
        }, 5200);
    };

    // 仅当首页 hero 存在时，才启动气泡动画
    if (heroMapBackground) {
        // 每隔1.2秒创建新的NOW气泡
        setInterval(createNowBubble, 1200);
        // 页面加载时立即创建一些气泡
        for (let i = 0; i < 8; i++) {
            setTimeout(createNowBubble, i * 200);
        }
    }

    initDownloadEntryPoints();
});

// 页面加载动画
window.addEventListener('load', () => {
    document.body.classList.add('loaded');
});

// 移动端菜单切换
const menuToggle = document.querySelector('.menu-toggle');
const navLinks = document.querySelector('.nav-links');

if (menuToggle && navLinks) {
    menuToggle.addEventListener('click', () => {
        navLinks.classList.toggle('active');
    });

    // 点击导航链接后关闭菜单
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', () => {
            navLinks.classList.remove('active');
        });
    });
}

// 滚动显示动画
function initScrollReveal() {
    const scrollRevealElements = document.querySelectorAll('.scroll-reveal');

    if (!('IntersectionObserver' in window)) {
        scrollRevealElements.forEach(el => el.classList.add('revealed'));
        return;
    }

    const observer = new IntersectionObserver((entries, obs) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('revealed');
                obs.unobserve(entry.target);
            }
        });
    }, {
        threshold: 0,
        rootMargin: '100px 0px -10% 0px'
    });

    scrollRevealElements.forEach(element => observer.observe(element));

    // Fallback：初始化时立即检查已在视口内的元素，且在滚动/加载时二次检测
    const revealInView = () => {
        scrollRevealElements.forEach(el => {
            if (el.classList.contains('revealed')) return;
            const rect = el.getBoundingClientRect();
            if (rect.top < window.innerHeight && rect.bottom > 0) {
                el.classList.add('revealed');
            }
        });
    };
    revealInView();
    window.addEventListener('scroll', revealInView, { passive: true });
    window.addEventListener('load', revealInView);
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    initScrollReveal();
}); 

// 鼠标气泡动画
(function() {
    // 仅在首页存在 hero 时启用鼠标气泡，避免商户页额外的主线程负担
    if (!document.querySelector('.hero')) return;
    const colors = ['#F4B400', '#2EE8C2'];
    const sizes = [12, 18, 24, 32];
    document.addEventListener('mousemove', function(e) {
        const bubble = document.createElement('div');
        const color = colors[Math.floor(Math.random() * colors.length)];
        const size = sizes[Math.floor(Math.random() * sizes.length)];
        bubble.className = 'mouse-bubble';
        bubble.style.background = color;
        bubble.style.width = size + 'px';
        bubble.style.height = size + 'px';
        bubble.style.left = (e.clientX - size/2) + 'px';
        bubble.style.top = (e.clientY - size/2) + 'px';
        bubble.style.opacity = '0.7';
        document.body.appendChild(bubble);
        // 动画：放大、上浮、淡出
        setTimeout(() => {
            bubble.style.transform = `translateY(-40px) scale(${1.5 + Math.random()})`;
            bubble.style.opacity = '0';
        }, 10);
        // 动画结束后移除
        setTimeout(() => {
            if (bubble.parentNode) bubble.parentNode.removeChild(bubble);
        }, 700 + Math.random()*300);
    });
})(); 

function isWeChatBrowser() {
    return /MicroMessenger/i.test(navigator.userAgent || '');
}

function initDownloadEntryPoints() {
    const appStoreButtons = document.querySelectorAll('.app-store-btn');
    appStoreButtons.forEach(btn => {
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            if (isWeChatBrowser() && /iPad|iPhone|iPod/.test(navigator.userAgent || '')) {
                window.location.href = IOS_GUIDE_URL;
            } else {
                window.location.href = APP_STORE_URL;
            }
        });
    });

    const androidButtons = document.querySelectorAll('.android-btn');
    androidButtons.forEach(btn => {
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            if (isWeChatBrowser()) {
                window.location.href = ANDROID_GUIDE_URL;
            } else {
                window.location.href = APK_DOWNLOAD_URL;
            }
        });
    });

    initWechatButtonInteractions();
}

function initWechatButtonInteractions() {
    const wechatButtons = document.querySelectorAll('.wechat-btn');
    if (!wechatButtons.length) return;

    const tooltip = document.createElement('div');
    tooltip.className = 'wechat-qr-tooltip';
    tooltip.innerHTML = `
        <img src="${WECHAT_QR_IMAGE}" alt="Zup! 微信小程序二维码">
        <p>微信扫码或搜索“Zup即刻欢聚”</p>
    `;
    document.body.appendChild(tooltip);

    const modal = document.createElement('div');
    modal.className = 'wechat-qr-modal';
    modal.innerHTML = `
        <div class="wechat-qr-modal__content">
            <button class="wechat-qr-modal__close" aria-label="关闭二维码弹窗">&times;</button>
            <img src="${WECHAT_QR_IMAGE}" alt="Zup! 微信小程序二维码">
            <h3>微信内长按识别</h3>
            <p>请在微信浏览器中长按识别二维码，或搜索“Zup即刻欢聚”。</p>
        </div>
    `;
    document.body.appendChild(modal);
    const modalClose = modal.querySelector('.wechat-qr-modal__close');

    let tooltipTarget = null;

    function positionTooltip(target) {
        const rect = target.getBoundingClientRect();
        tooltip.style.left = `${rect.left + rect.width / 2}px`;
        tooltip.style.top = `${rect.top - 10}px`;
    }

    function showTooltip(target) {
        if (!hoverMediaQuery.matches) return;
        tooltipTarget = target;
        positionTooltip(target);
        tooltip.classList.add('visible');
    }

    function hideTooltip() {
        tooltipTarget = null;
        tooltip.classList.remove('visible');
    }

    function openWechatModal() {
        modal.classList.add('visible');
        document.body.classList.add('wechat-modal-open');
    }

    function closeWechatModal() {
        modal.classList.remove('visible');
        document.body.classList.remove('wechat-modal-open');
    }

    window.addEventListener('scroll', () => {
        if (tooltipTarget) {
            positionTooltip(tooltipTarget);
        }
    }, { passive: true });

    window.addEventListener('resize', () => {
        if (tooltipTarget) {
            positionTooltip(tooltipTarget);
        }
    });

    wechatButtons.forEach(btn => {
        btn.addEventListener('mouseenter', () => showTooltip(btn));
        btn.addEventListener('mouseleave', hideTooltip);
        btn.addEventListener('focus', () => showTooltip(btn));
        btn.addEventListener('blur', hideTooltip);
        btn.addEventListener('click', (event) => {
            const needsModal = !hoverMediaQuery.matches || mobileMediaQuery.matches;
            event.preventDefault();
            if (needsModal) {
                openWechatModal();
            }
        });
    });

    if (modalClose) {
        modalClose.addEventListener('click', closeWechatModal);
    }

    modal.addEventListener('click', (event) => {
        if (event.target === modal) {
            closeWechatModal();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && modal.classList.contains('visible')) {
            closeWechatModal();
        }
    });
}