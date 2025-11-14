# Zup! Official Website

这是 Zup! App 的官方网站项目，采用现代化的设计风格，展示 App 的核心功能和价值主张。

## 项目结构

```
BuzzInMap_website/
├─ index.html                 # 首页
├─ merchant.html              # 新增：商户入驻说明页
├─ css/
│  ├─ style.css               # 全站样式
│  └─ animations.css          # 动画样式
├─ js/
│  └─ main.js                 # 导航、滚动与交互动效
├─ images/                    # 图片资源
└─ 商户入驻页设计参考.md        # 商户入驻内容参考文档
```

## 本地预览

- 直接双击或通过本地服务器打开 `index.html` 即可。
- 导航栏右侧新增入口「商户入驻」，点击跳转 `merchant.html`。

## 页面说明

- 首页（`index.html`）
  - 顶部导航、Hero 区、用户痛点场景与商户价值板块。
  - 移动端支持菜单收起/展开和平滑滚动。

- 商户入驻（`merchant.html`）
  - 依据《商户入驻页设计参考.md》整理的入驻流程与权益说明：
    - 入驻方式：
      1. 三方认证（短信至 18501217603，内容含“认证+商户名+Zup! 用户ID”）
      2. 提交商户资料（发送至 service@nowmap.cn）
      3. App 内自助认证（我的 → 设置 → 申请认证商户）
    - 联系方式与人工协助：18501217603 / service@nowmap.cn
    - 入驻后能力：常驻标识、可编辑详情页、NOW 长期记忆、管理员认证、发布与分销商品等。
  - 复用站点现有配色/卡片风格与动效，顶部含返回首页与锚点跳转。

## 资源引用

- 参考图片位于仓库根目录：
  - `大众点评商户页.png`
  - `地图App商户页.png`
  - `App内申请认证商户.png`

## 设计一致性

- 导航结构、按钮风格、色板与动效均与首页一致；移动端菜单交互复用 `js/main.js`。
- 主题色彩：黄色(#F4B400)和青色(#2EE8C2)，用于按钮、图标、悬停效果等交互元素。

## 维护建议

- 若需调整商户入驻流程或联系方式，只需同步更新：
  - `商户入驻页设计参考.md`
  - `merchant.html`

## 最近更新

### 2025年1月 - 首页导航精简
- **变更**: 去掉首页右上角导航中的「For用户」「For商户」两个链接，仅保留「商户入驻」。
- **文件修改**: `index.html` 导航栏 `nav-links` 内移除两个锚点。

### 2025年1月 - 下载按钮文字颜色统一
- **问题描述**: 用户要求将所有页面的下载按钮中的安卓和小程序都改成黑色字
- **解决方案**: 修改CSS样式，统一按钮文字颜色
  - 将 `.android-btn` 的文字颜色从白色改为黑色 (`#000000`)
  - 将 `.wechat-btn` 的文字颜色保持为黑色 (原本就是黑色)
  - 同时更新footer部分的hover状态颜色
  - **修复遗漏**: 为footer部分的下载按钮添加专门的样式覆盖，确保安卓和小程序按钮显示为黑色文字
- **影响范围**: 影响所有页面的下载按钮显示，包括首页和商户入驻页
- **文件修改**: `css/style.css` 第430行、第846行、第850行、第838-842行

### 2025年1月 - 移动端商户板块居中优化
- **问题描述**: 首页"For商户"板块在移动端模式下，6个项目的图标和标签不居中
- **解决方案**: 在CSS中添加了移动端特定的样式规则
  - 为 `.merchant-icon` 添加 `margin-left: auto; margin-right: auto;` 实现图标居中
  - 为 `.merchant-benefit` 添加 `justify-content: center;` 实现标签居中
- **影响范围**: 仅影响移动端显示，桌面端不受影响
- **文件修改**: `css/style.css` 第1020-1026行

### 2025年11月 - 下载入口与分发逻辑升级
- **变更**: 
  - 移除首页右下角浮动二维码入口，下载引导集中到导航按钮与专用页面。
  - 首页、页脚与商户页的 App Store 按钮直连 `https://apps.apple.com/cn/app/id741292507`。
  - Android 按钮根据是否在微信内打开分别跳转 `android-guide.html` 或直接下载 `小红书.apk`。
  - 小程序按钮在桌面端悬停展示二维码、移动端点击弹出指引。
  - 全新 `download.html` 提供多入口说明，同时新增 `android-guide.html` 指导微信环境的安卓下载。
  - 针对微信浏览器缓存，所有页面新增 no-cache 元标签，并为 CSS/JS/二维码资源追加版本号 `?v=20251114`（`js/main.js` 内以 `ASSET_VERSION` 常量统一管理）。
  - 新增 `ios-appstore-guide.html`，并在 `js/main.js` 中对 iOS + 微信环境下的 App Store 按钮进行引导跳转（与 Android APK 引导逻辑一致）。
- **文件修改**: `index.html`, `merchant.html`, `guide.html`, `download.html`, `android-guide.html`, `ios-appstore-guide.html`, `css/style.css`, `js/main.js`, `images/wechat-miniprogram-qr.jpg`