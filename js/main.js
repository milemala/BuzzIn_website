// 导航栏滚动效果
document.addEventListener('DOMContentLoaded', () => {
    const navbar = document.querySelector('.navbar');
    const sections = document.querySelectorAll('section');
    
    // 滚动监听
    window.addEventListener('scroll', () => {
        if (window.scrollY > 50) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
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

    // 动态NOW气泡效果 - 增强版
    const createNowBubble = () => {
        const mapBackground = document.querySelector('.map-background');
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

    // 每隔1.2秒创建新的NOW气泡
    setInterval(createNowBubble, 1200);
    
    // 页面加载时立即创建一些气泡
    for (let i = 0; i < 8; i++) {
        setTimeout(createNowBubble, i * 200);
    }
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
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('revealed');
                observer.unobserve(entry.target);
            }
        });
    }, {
        threshold: 0.1
    });

    scrollRevealElements.forEach(element => {
        observer.observe(element);
    });
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    initScrollReveal();
}); 

// 鼠标气泡动画
(function() {
    const colors = ['#FC9A2E', '#33CD97'];
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