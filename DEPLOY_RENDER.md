# 部署到 Render（静态站点）

本项目是纯静态 HTML/CSS/JS，已托管在 GitHub 公开仓库
`https://github.com/WXK2905821189/arknights-cards`（默认分支 `master`）。
Render 可直接连 GitHub 做持续自动部署，无需重新推送代码。

---

## 一、体积提示（部署前先看）

- `assets/` 含约 274 张 PNG，仓库总大小约 **228MB**，仍低于 GitHub 的 1GB 软上限。
- Render 首次克隆仓库会稍慢，但 **228MB 在可接受范围**，一般不会触发失败。
- 若部署因体积超时/失败，退路：用 `pngquant` 批量压缩 PNG（可降到 30–50MB），
  或把资源迁到 Cloudflare R2 / 对象存储。当前建议先按下方步骤直接部署。

---

## 二、部署步骤（Dashboard 手动，最直观）

1. 登录 [dashboard.render.com](https://dashboard.render.com)（可用 GitHub 账号注册/登录）。
2. 右上角 **New → Static Site**。
3. 首次需 **Connect GitHub**，授权 Render 访问你的账户并选中仓库 **`arknights-cards`**。
4. 填写构建设置：
   | 字段 | 值 |
   |---|---|
   | Name | `arknights-cards`（或任意） |
   | Branch | `master` |
   | Build Command | **留空**（纯静态无构建） |
   | Publish Directory | **`.`**（仓库根，因 index.html 在根） |
5. 点击 **Create Static Site**，Render 自动触发首次构建。
6. 约 1–2 分钟完成后，得到 `https://arknights-cards.onrender.com`（子域可自定义）。

> 免费静态站点 **不会休眠**（与免费 Web Service 不同），且自动 HTTPS + 全球 CDN。

---

## 三、部署步骤（Blueprint 一键，用仓库里的 render.yaml）

1. Render Dashboard → **New → Blueprint**。
2. 连接 GitHub 并选中 `arknights-cards` 仓库。
3. Render 读取根目录 `render.yaml`，自动套用上面的配置 → 点击部署即可。

---

## 四、自定义域名（可选）

Static Site 设置页 → **Custom Domains** → 添加你的域名。
Render 给出 CNAME 记录，你到 DNS 服务商处添加；
DNS 生效后 Render 自动签发 TLS 证书，HTTPS 即生效。

---

## 五、之后怎么用

- 改完代码，在 `arknights-cards/` 里：
  ```bash
  git add -A && git commit -m "..." && git push
  ```
  Render 监听 `master` 分支，**自动重新部署**。
- 入口：站点根 `/` = 六星图鉴（`index.html`），`/home.html` = 响应式门户页。
  想让门户当首页，把 `home.html` 改名为 `index.html` 并调整互链即可（可让技术负责人代劳）。

---

## 六、免费层注意事项

- 静态站点的出站带宽计入 workspace 的每月免费额度；
  建议在 Dashboard 关注 **Usage** 面板，避免超限。
- 无服务端代码、无数据库（纯静态），符合本项目形态。
- 站点不休眠、自动 HTTPS、全球 CDN，适合本项目长期在线。
