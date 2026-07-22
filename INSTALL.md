# open-claude-in-chrome 安装文档

把 Claude Code 接进浏览器侧栏的一套本地工具。**不是商店一键插件** —— 由「Chrome 扩展 + 本机 Node 后台(host)」两半组成,两半都要装,靠 run-from-clone(仓库即运行代码)。

内置能力:
- **浏览器自动化**(18 个 MCP 工具,任意站点,无域名黑名单)
- **`/qa`** —— 飞书 PRD 自动化测试(读需求→生成脚本→人审→重放→结果播报)
- **`/figma-ws`** —— 拦浏览器 WebSocket 直读 Figma 设计 → 出前端开发提示词(**免 token、免限流**)
- **`/figma`** —— 走 Figma REST 读设计(需个人 token,有限流)

---

## 一、前置要求

| 依赖 | 说明 |
|---|---|
| **macOS** | 安装脚本用 launchd / `~/Library`,目前仅支持 macOS |
| **Node.js ≥ 20** | `node -v` 确认;推荐 Homebrew 装 `node@20` |
| **Claude Code CLI** | 装好 `claude` 且已登录(`claude` 能正常起会话) |
| **Chromium 浏览器** | Chrome / Edge / Brave / Arc 任一 |
| **git** | 拉取仓库 |
| **(仅 `/figma-ws`)** | 在该浏览器里**已登录 Figma**(抓的是你登录态的 WS) |

---

## 二、安装(5 步)

### 1. 克隆仓库
```bash
git clone <仓库地址> open-claude-in-chrome
cd open-claude-in-chrome
```

### 2. 加载扩展,拿到扩展 ID
1. 浏览器打开 `chrome://extensions`
2. 右上角开启 **开发者模式**
3. 点 **加载已解压的扩展程序**,选择仓库里的 **`extension/`** 目录
4. 复制该扩展卡片上的 **扩展 ID**(一串字母)

### 3. 跑安装器(把扩展 ID 传进去)
```bash
./install.sh <扩展id>          # 多个浏览器可传多个 id:./install.sh id1 id2
```
安装器会自动完成:
- `npm install` 装 host 依赖(含本功能所需的 **`kiwi-schema`、`fzstd`**、Agent SDK)
- 注册 native messaging host(侧栏 daemon + 浏览器自动化两个)到所有已装的 Chromium 浏览器
- 用 launchd 装常驻 daemon(开机自启 + 崩溃自愈)
- 把浏览器自动化 MCP 注册进 Claude Code

### 4. 完全退出浏览器再重开
**必须 ⌘Q 完全退出 Chrome**(不是关窗口)再重新打开 —— native messaging 注册才会生效。

### 5. 打开侧栏验证
点扩展图标打开侧栏,能正常聊天 = 装好了。

---

## 三、用 `/figma-ws`(拦 WS 读 Figma,免 token)

**前提**:浏览器里已登录 Figma。

1. 在 Figma 打开设计文件,**选中要开发的那一屏**(选中后地址栏会出现 `?node-id=...`)。
2. 让该 Figma 标签页为当前页,在侧栏输入:
   ```
   /figma-ws 行情页          # 页面名可选,只是给提示词起个名
   ```
3. **首次**会自动刷新该 Figma 页,以抓到初始全量场景图帧:
   - 大文件加载慢,首次可能 **1–3 分钟**(期间有进度保活,不会被判死);
   - 之后帧常驻内存,再发 `/figma-ws` **秒出**、不再刷新。
4. 输出:一段**格式化的前端开发提示词**(结构/文案/尺寸/配色/组件映射),可**继续追问**(“把配色改成暗色”“这个模块怎么实现”“用 React 写”)。

**说明与注意:**
- **不需要 Figma token** —— 抓的是你登录态浏览器里的 WebSocket 数据,不走 REST,自然避开限流/付费。
- **无需指定项目**:输出的是提示词,你想在哪开发就把它用到哪。
- ⚠️ **合规提醒**:此功能逆向了 Figma 的私有二进制协议(被动只读),踩 Figma ToS,封号风险低但非零。**团队推广前请自行评估合规**,别默认全员铺开。
- 若始终抓不到大帧(F12 控制台跑 `__figCaptureStatus()`,`dataMax` 一直为 0):该文件可能把连接放在 Worker 里,主线程抓不到 —— 反馈维护者改用 chrome.debugger/CDP 抓帧。

---

## 四、其他命令(可选配置)

- **`/figma`(REST)**:需在 `host/figma/.env.local` 配 `FIGMA_TOKEN=<个人或组织令牌>`。有限流(个人 token 打满冷却可长达数天),日常优先用 `/figma-ws`。
- **`/qa`**:飞书 PRD 自动化测试,需在 `host/qa/` 配置飞书凭证与结果表(见 `host/qa/qa-config.example.json`)。

---

## 五、更新(run-from-clone)

仓库即运行代码,`git pull` 后按改动类型处理:

| 改了什么 | 怎么生效 |
|---|---|
| `host/*.js`(后台逻辑) | 一般重连即生效;必要时 `launchctl kickstart -k gui/$(id -u)/com.openclaude.sidebar-daemon` 重启 daemon |
| `extension/*`(扩展) | `chrome://extensions` 点 **刷新** |
| `extension/figma-ws-capture.js`(抓帧脚本) | **刷新扩展 + 刷新目标网页**(content script 要重新注入才生效) |
| `host/package.json`(依赖) | `cd host && npm install` |
| `manifest.json` / 新增 host 依赖 | 刷新扩展 +(如依赖变)`host` 里 `npm install` |

---

## 六、排错

**日志位置:**
- daemon:`~/Library/Application Support/ClaudeSidebarHost/daemon.log`
- host:`~/Library/Logs/ClaudeSidebarHost/{chat-native-host,native-host}.log`

**常见问题:**
- **侧栏连不上 / 一直转**:确认已 ⌘Q 重开浏览器;`launchctl list | grep sidebar` 看 daemon 在不在;看 daemon.log。
- **`/figma-ws` 卡住或抓不到**:多半是**只刷新了扩展、没刷新 Figma 页**(旧抓帧脚本还在跑) → 刷新扩展 **且** Cmd+R 刷新 Figma 页;F12 控制台 `__figCaptureStatus()` 有 `dataMax` 字段=新脚本已生效。
- **`node` / `claude` 找不到**:确认在交互 shell 的 PATH 里(Homebrew 装的可能需要补 PATH);安装器要求 `node ≥ 20`。
- **多浏览器**:每装一个新浏览器或换扩展 ID,重跑一次 `./install.sh <新id>`。
