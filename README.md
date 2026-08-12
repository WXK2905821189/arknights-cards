# 罗德岛棋局 · 货币战争

> 基于《明日方舟》六星干员的同人自走棋网页游戏。纯前端、零安装、全平台即开即玩。

## 简介

集结 **136 名六星干员**，在货币经营的棋盘上排兵布阵。组合职业羁绊、调度 5 费签名与阵营特殊机制，于自动战斗中奠定胜局，一路推进至 BOSS。

## 特性

- **自走棋对战**：自动战斗 + 手动经营决策（资金、刷新、升级人口）。
- **三层羁绊系统**：职业轴 + 阵营轴 + 5 费签名被动，叠加构筑你的专属流派。
- **货币战争**：每回合经营资金，在利息 / 刷新 / 升级之间权衡，向节点深处推进。
- **六星图鉴**：`index.html` 可筛选、搜索、缩放查看干员档案（立绘 + 数据一应俱全）。
- **全平台响应式**：桌面 / 平板 / 手机自适应布局，移动端导航与触控交互完善。
- **音效系统**：真实采样音效，以 base64 内嵌，**支持 `file://` 离线双击运行**。
- **Meta 进度**：通关 BOSS 积累战利品币，解锁永久增益，让每一次重开都更强。
- **门户落地页**：`home.html` 介绍特性与玩法。

## 技术栈

纯静态 **HTML / CSS / JavaScript**，**无 npm 构建步骤**。所有干员数据内嵌（`data.js` / `data.json`），音效以 base64 内嵌（`audio_assets.js`），可直接以 `file://` 双击打开，或部署到任意静态托管。

## 目录结构

```
arknights-cards/
├── home.html            # 门户 / 落地页
├── index.html           # 六星干员图鉴
├── game.html            # 自走棋对战主游戏
├── game.js / game.css   # 对战逻辑与样式
├── data.js / data.json  # 干员数据（136 名六星）
├── signatures.js        # 5 费签名数据
├── bonds_flavor.js      # 羁绊风味文本（运行时必需，已入库）
├── resonance.js         # 阵营「跨阵营呼应（Narrative Resonance）」数据
├── audio.js / audio_assets.js  # 音效系统（base64 内嵌采样）
├── tokens.css / style.css / home.css  # 主题与样式
├── assets/              # 干员头像 / 立绘（PNG）
├── audio/               # 音效 wav 源采样（已内嵌，非运行时硬依赖）
├── tools/               # 本地辅助脚本（自愈式静态服务器等，仅本地，不入库）
├── render.yaml          # Render Blueprint 部署配置
└── DEPLOY_RENDER.md     # 部署说明
```

## 本地运行

**方式一（推荐）** — 使用任意静态文件服务器，例如仓库内的自愈式本地服务器：

```bash
python tools/serve.py     # 自愈重启 + 禁用缓存，访问 http://localhost:8141/game.html
```

> `tools/` 为本地开发工具，未纳入版本库（见 `.gitignore`）。也可直接用 `python -m http.server` 或 VS Code Live Server。

**方式二** — 直接双击 `home.html` / `game.html` 以 `file://` 打开（音效已内嵌，可离线运行）。

## 部署

已配置 [Render](https://render.com) Blueprint（`render.yaml`）：纯静态站点，发布目录为 `.`，**无构建步骤**。在 Render Dashboard 连接 GitHub 仓库后一键部署。详见 `DEPLOY_RENDER.md`。

## 数据来源与版权

- 干员数据来源 [PRTS Wiki](https://prts.wiki)，立绘 / 头像取自六星干员公开图鉴。
- 本项目为**个人 / 同好圈非商业同人作品**，与鹰角网络无官方关联。
- 如需商用或大规模分发，请先取得相关权利方授权。

## 开发说明

- 设计文档、构建 / 抓取脚本、中间产物统一归置于仓库外的 `workfiles/`（design / dev / reference / scripts / tools），不混入游戏目录。
- 羁绊机制设计、阵营呼应（Narrative Resonance）等机制说明见 `workfiles/design` 与 `resonance.js` 头部注释。
- 数据 / 技能 / 音效的生成脚本属开发期工具，运行后产出内嵌进 `data.js` / `audio_assets.js`，不随站点部署。

## 许可

仅供个人与非商业同好圈使用。
