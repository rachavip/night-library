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

#### 上传后立刻核对（重要）

网页上传最常见的失误是漏掉隐藏文件夹。提交后刷新仓库首页，确认：

- 能看到 **`.github`** 文件夹，点进去有 **`workflows/docker-publish.yml`**
- 能看到 `server/`、`public/`、`Dockerfile`、`package.json`
- **看不到** `node_modules/` 和 `data/`（如果出现了，说明传错了，需要删掉重新提交）

> Windows 显示隐藏文件夹：文件管理器顶部「查看」→「显示」→ 勾选「隐藏的项目」。
>
> 如果确实漏传了 `.github`，不用重传所有文件：仓库页面点 **Add file** → **Create new file**，文件名栏直接填 `.github/workflows/docker-publish.yml`，把本地这个文件的全部内容粘贴进去，点 **Commit changes** 即可（GitHub 会自动创建中间的文件夹）。

#### 网页拖不进文件夹怎么办

GitHub 网页端对「直接拖整个文件夹」支持不稳定（尤其含隐藏文件夹和多层子目录时经常没反应）。两个替代办法：

**办法 1：GitHub Desktop（推荐，仍是图形界面，不用记命令）**

1. 下载安装 <https://desktop.github.com/> 并登录你的 GitHub 账号
2. 点 **File → Clone repository**，选中你刚建的 `night-library`，选一个本地目录克隆下来
3. 打开这个本地目录，把项目里的文件复制进去（**不要**复制 `node_modules/` 和 `data/`，其余包括隐藏的 `.github` 都要）
4. 回到 GitHub Desktop，底部填一句说明如 `init`，点 **Commit to main**，再点右上角 **Push origin**
5. 以后更新：把改好的文件复制进这个目录 → Commit → Push 即可，比网页上传省事很多

**办法 2：坚持网页端，分目录上传**

- 点 **Add file → Upload files → choosing files**（不要拖文件夹），按住 Ctrl 多选根目录下的文件
- 子目录要手动建：点 **Add file → Create new file**，文件名栏填 `server/index.js` 这种带 `/` 的路径，GitHub 会自动建出 `server/` 文件夹；保存后进入该目录再用 Upload files 传其余文件
- **建目录用的占位文件（如 `1.js`）不用单独删**：后面上传真实文件时，点 **Add file → Upload files**，进入该子目录，把真实文件传上去；如果占位文件名和真实文件名不同，可按下面步骤删掉它
- `.github/workflows/docker-publish.yml` 也用「Create new file + 填完整路径」的办法建

**网页端删除文件（以 `1.js` 为例）**：

1. 在仓库里找到并点开 `1.js`（在哪一层目录就进哪一层，比如 `server/1.js`）
2. 点文件右上角的 **🗑 Delete file**（垃圾桶图标）
3. 页面拉到底，写一句提交说明如 `remove placeholder`，点 **Commit changes**
4. 文件即被删除。如果同一个目录里你建了多个占位文件（`1.js`、`2.js`…），逐个重复即可

> 更省事的做法：用真实的目录结构一次性建占位文件，比如要传 `server/` 就点 Create new file 时文件名填 `server/index.js`（真实文件名），内容先随便写点东西；之后用 Upload files 上传同名真实文件时，GitHub 会提示覆盖（overwrite），勾选覆盖即可，这样目录建成的同时占位文件也被真实文件替换了，不用额外删除。

文件多时办法 2 很繁琐，更建议办法 1 或下面的方式 B。

### 方式 B · 命令行 git（推荐，以后更新方便）

在 Git Bash 里执行（用户名已按你的 `rachavip` 填好）：

```bash
cd "G:/System/Documents/WorkBuddy/night-library"
git init
git remote add origin https://github.com/rachavip/night-library.git
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

## 第五步：确认镜像包是公开（Public）

设为公开后，飞牛 NAS 拉镜像不需要登录或 token。**先确认包已经存在**：如果第四步的 Actions 还没跑完或失败了，包根本没生成，自然找不到设置入口。

### 先确认包存在

进入包的三种方式，任一能打开就行：

- **方式 1**：仓库首页 → 右侧栏的 **Packages** → 点 `night-library`
- **方式 2**：GitHub 右上角头像 → **Your profile** → 顶部 **Packages** 标签 → 找 `night-library`
- **方式 3**：浏览器直接打开 `https://github.com/rachavip?tab=packages`

如果这三种都看不到包，说明镜像还没推上去——回到第四步看 Actions 是否成功（绿色 ✅）。

### 再改可见性

打开包页面后，**先看你已经在哪个页面**：

1. 很多情况下，包页面顶部或标题旁会直接显示一个 **Public** / **Private** 的标签。如果已经是 **Public**，这步就不用做了，直接进第六步
2. 如果显示 Private，找 **Package settings**（通常在页面**左侧边栏**，或在页面右上角的 **⚙ / Settings** 按钮里；有的版本在包页面向下滚动的最底部）
3. 进入设置页后往下滚动，找到 **Visibility** 区块 → 点 **Change visibility** / **Set package visibility** → 选 **Public** → 按提示确认（有的版本要输入包名确认）

> 如果左侧栏或设置里完全没有 Visibility 字眼：这个包很可能是从**公开仓库**推上来的，GitHub 已自动设为 Public，直接跳过这步去 NAS 上拉取测试即可。

### 验证是否真的公开

用手机流量或无痕窗口打开包页面，能正常看到包内容就是公开的；如果要求登录，则还是 Private，需要回来改。

---

## 第六步：你的镜像地址

你的 GitHub 用户名是 `rachavip`，所以镜像地址是（已填进 `docker-compose.yml`，无需再改）：

```
ghcr.io/rachavip/night-library:latest
```

GHCR 要求用户名小写，`rachavip` 已是小写，可直接使用。

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
   image: ghcr.io/rachavip/night-library:latest
   ```
   > **注意区分两个目录**：compose 文件放在项目目录 `/vol1/1000/docker/ebooks`；你的电子书放在书籍目录 `/vol1/1000/EBook`（`BOOKS_DIR` 已指向它）。**不要把书放进项目目录**。因为挂载了整个 `/vol1`，网页里也能再添加 `/vol1` 下的其他书籍文件夹。
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

> **如果你是用网页上传的**：GitHub 网页端不会自动同步本地文件的改动。每次我更新了项目文件（比如这次修复 Dockerfile），你需要在仓库里点开对应的那个文件 → 右上角 **✏️ 编辑** → 把本地同名文件的内容全选复制粘贴进去 → Commit。改完 `Dockerfile` 后 Actions 会重新触发，等它构建成功即可。多个文件改动就逐个文件重复这个操作。

---

## 常见问题

| 现象                                 | 原因与解决                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 拉镜像报 `denied` / `unauthorized`     | 镜像包没设 Public；或用户名写了大写，改成小写                                                                                     |
| Actions 报 `permission denied`      | 第三步的 Workflow permissions 没开「Read and write」                                                                   |
| 构建报 `npm install ... exit code: 1` | 已修复：Dockerfile 改用 `--ignore-scripts` 并在复制源码后显式运行 vendor 脚本。**需要把更新后的 Dockerfile 重新上传到 GitHub** 才会生效（见下方说明）     |
| 架构不匹配（ARM 版 NAS）                   | 你的 NAS 是 **x86**，workflow 已固定 `platforms: linux/amd64`，**无需改动**。只有换成 ARM 版 NAS 时才需要改成 `linux/arm64`（或写两个，构建更久） |
| 镜像几百 MB、首次拉取慢                      | 里面包含 Calibre（MOBI/AZW3 转 EPUB 用），正常现象                                                                          |
| 不想经过 GitHub，想本地构建                  | 用 `docker-compose.build.yml`：`docker compose -f docker-compose.build.yml up -d --build`                        |
| 更新后网页还是旧版                          | 浏览器强刷（Ctrl+F5）；确认 `docker compose pull` 确实拉到了新镜像                                                               |

---

## 安全说明

镜像是公开的，但它只包含程序代码，**不包含你的书籍和任何个人数据**。账号密码（音乐服务的）只保存在 NAS 上的 `data/settings.json`，通过挂载卷留在本地。如果你希望连仓库也私有，镜像包也要相应设为 Private，届时 NAS 拉取需要先 `docker login ghcr.io`（用有 `read:packages` 权限的 Token）。
