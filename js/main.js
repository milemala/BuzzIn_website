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

    // 语言切换
    const languageBtn = document.querySelector('.language-btn');
    languageBtn.addEventListener('click', () => {
        const currentLang = languageBtn.textContent;
        languageBtn.textContent = currentLang === 'EN' ? '中' : 'EN';
        // TODO: 实现语言切换逻辑
    });

    // 平滑滚动
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            document.querySelector(this.getAttribute('href')).scrollIntoView({
                behavior: 'smooth'
            });
        });
    });

    // 动态地图点效果
    const createMapPoint = () => {
        const mapBackground = document.querySelector('.map-background');
        const point = document.createElement('div');
        point.classList.add('map-point');
        point.style.left = Math.random() * 100 + '%';
        point.style.top = Math.random() * 100 + '%';
        mapBackground.appendChild(point);
        
        setTimeout(() => {
            point.remove();
        }, 2000);
    };

    // 每隔一段时间创建新的地图点
    setInterval(createMapPoint, 1000);
});

// 页面加载动画
window.addEventListener('load', () => {
    document.body.classList.add('loaded');
});

// 移动端菜单切换
document.querySelector('.menu-toggle').addEventListener('click', () => {
    document.querySelector('.nav-links').classList.toggle('active');
});

// 点击导航链接后关闭菜单
document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', () => {
        document.querySelector('.nav-links').classList.remove('active');
    });
});

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