# 把镜像发布到 GitHub，然后在飞牛 NAS 上一键部署

## 这套方式是怎么回事

代码推到 GitHub → GitHub Actions 自动构建 Docker 镜像 → 推送到 **GHCR**（GitHub Container Registry）→ NAS 的 `docker-compose.yml` 里只写镜像地址，`docker compose up -d` 就拉起来。

镜像里**只有程序**。你的书籍、设置、封面、阅读进度都在 NAS 挂载的 `./data` 和 `/vol1` 里，不进镜像，也不进 GitHub。公开仓库的 Actions 和 GHCR 公开包对个人使用是免费的。

---

## 第一步：创建 GitHub 仓库

1. 打开 <https://github.com/new>
2. Repository name 填 **`night-library`**（建议就用这个名字，下面的镜像地址会跟它对应）
3. 选 **Public**（公开仓库；公开包可以被 NAS 匿名拉取，不用配登录）
4. **不要**勾选 "Add a README file" / ".gitignore" / "license" 等初始化选项——本地项目里已经有这些文件了
5. 点 **Create repository**

> 注意：GHCR 的镜像名必须是小写。如果你的 GitHub 用户名里有大写字母，在后面 compose 里写小写版本即可（GitHub 用户名本身不区分大小写）。

---

## 第二步：把项目文件上传到仓库

### 方式 A · 网页上传（不用装 git）

1. 在仓库页面点 **Add file** → **Upload files**
2. 打开本地 `G:/System/Documents/WorkBuddy/night-library` 文件夹，把下面这些拖进去：
   - **`.github`**（隐藏文件夹，必须包含！文件管理器里要开启「显示隐藏的项目」才看得到）
   - `server/`、`public/`、`scripts/`
   - `Dockerfile`、`docker-compose.yml`、`docker-compose.build.yml`
   - `.dockerignore`、`.gitignore`、`package.json`、`package-lock.json`
   - `README.md`、`DEPLOY_GITHUB.md`
   - `demo-books/` 是本地试读用的示例书，可传可不传
3. **不要上传** `node_modules/` 和 `data/`（体积大，且含本地测试数据）
4. 点 **Commit changes**

### 方式 B · 命令行 git（推荐，以后更新方便）

在 Git Bash 里执行（把 `你的用户名` 换成实际用户名）：

```bash
cd "G:/System/Documents/WorkBuddy/night-library"
git init
git remote add origin https://github.com/你的用户名/night-library.git
git add .
git commit -m "init night-library"
git branch -M main
git push -u origin main
```

如果提示输入 GitHub 密码，需要用 Personal Access Token 代替：GitHub → 头像 → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token，勾选 `repo` 和 `workflow`，生成后复制粘贴作为密码。

`.gitignore` 已经排除了 `node_modules/` 和 `data/`，所以不会误传。

---

## 第三步：打开 Actions 的写入权限（关键，最容易漏）

1. 在仓库页面点 **Settings** → **Actions** → **General**
2. 拉到页面最底部的 **Workflow permissions**
3. 选择 **Read and write permissions**
4. 点 **Save**

不做这一步，Actions 没有权限把镜像推送到 GHCR，构建会以 `permission denied` 失败。

---

## 第四步：等 Actions 自动构建镜像

1. 仓库页面点 **Actions** 标签
2. 左侧选工作流 **「构建并发布镜像到 GHCR」**，应该能看到刚 push 触发的任务
3. 首次构建要安装 Calibre，**大约 5～15 分钟**，看到绿色 ✅ 就成功了
4. 想手动触发：Actions 页面 → **Run workflow**

如果失败（红色 ❌），点进去看日志，常见原因见文末。

---

## 第五步：把镜像包设为公开（Public）

1. 回到仓库首页，右侧栏找到 **Packages** → 点你的镜像包（名字应该是 `night-library`）
2. 进入包页面 → 左侧 **Package settings**
3. **Visibility** 改为 **Public** → Save

设为公开后，飞牛 NAS 拉镜像不需要登录或 token。

---

## 第六步：拿到你的镜像地址

格式是：

```
ghcr.io/你的用户名/night-library:latest
```

不知道自己的用户名？点 GitHub 右上角头像 → **Your profile**，浏览器地址栏 `github.com/` 后面那一段就是（例如 `github.com/zhangsan` → 用户名 `zhangsan`）。GHCR 要求小写，如果显示有大写，全部改成小写。

例如用户名是 `zhangsan`，就是 `ghcr.io/zhangsan/night-library:latest`。

---

## 第七步：在飞牛 NAS 上部署

1. SSH 登录 NAS，进入准备放项目的目录（若不存在先创建）：

   ```bash
   mkdir -p /vol1/1000/docker/ebooks
   cd /vol1/1000/docker/ebooks
   ```

2. 把项目里的 **`docker-compose.yml` 这一个文件**上传到这里（源码、node_modules 都不用传）

3. 编辑它，**只需改 `image:` 那一行**：

   ```yaml
   image: ghcr.io/你的用户名/night-library:latest
   ```

4. 拉取并启动：

   ```bash
   docker compose pull
   docker compose up -d
   ```

5. 浏览器打开 `http://你的NAS地址:8080`

飞牛图形界面也可以：Docker → 项目 → 创建项目 → 路径选 `/vol1/1000/docker/ebooks` → compose 文件选 `docker-compose.yml` → 启动，效果一样。

---

## 以后怎么更新

1. 本地改好代码，`git push` 到 `main`
2. Actions 自动构建并推送新镜像（几分钟）
3. NAS 上执行：

   ```bash
   cd /vol1/1000/docker/ebooks
   docker compose pull
   docker compose up -d
   ```

不用再上传源码到 NAS，也不用重新构建。

---

## 常见问题

| 现象 | 原因与解决 |
| --- | --- |
| 拉镜像报 `denied` / `unauthorized` | 镜像包没设 Public；或用户名写了大写，改成小写 |
| Actions 报 `permission denied` | 第三步的 Workflow permissions 没开「Read and write」 |
| 架构不匹配（ARM 版 NAS） | 你的 NAS 是 **x86**，workflow 已固定 `platforms: linux/amd64`，**无需改动**。只有换成 ARM 版 NAS 时才需要改成 `linux/arm64`（或写两个，构建更久） |
| 镜像几百 MB、首次拉取慢 | 里面包含 Calibre（MOBI/AZW3 转 EPUB 用），正常现象 |
| 不想经过 GitHub，想本地构建 | 用 `docker-compose.build.yml`：`docker compose -f docker-compose.build.yml up -d --build` |
| 更新后网页还是旧版 | 浏览器强刷（Ctrl+F5）；确认 `docker compose pull` 确实拉到了新镜像 |

---

## 安全说明

镜像是公开的，但它只包含程序代码，**不包含你的书籍和任何个人数据**。账号密码（音乐服务的）只保存在 NAS 上的 `data/settings.json`，通过挂载卷留在本地。如果你希望连仓库也私有，镜像包也要相应设为 Private，届时 NAS 拉取需要先 `docker login ghcr.io`（用有 `read:packages` 权限的 Token）。
