<div align="center">

<img src="public/logo-icon.png" width="104" alt="夜读 Night Library">

<h1>夜读 · Night Library</h1>

<p><b>把 NAS 上的电子书库，变成一个随手就能翻开的网页书房。</b></p>

<p>刮削本地文件夹 · 五种格式在线阅读 · 阅读进度 / 高亮 / 隐藏 / 丛书 / 统计<br>
深墨蓝的书房、暖纸色的文字、一束琥珀色的灯光</p>

<p>
<a href="version.json"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Frachavip%2Fnight-library%2Fmain%2Fversion.json&query=%24.version&label=version&color=E9A23B&style=flat-square" alt="version"></a>
<a href="https://github.com/rachavip/night-library/pkgs/container/night-library"><img src="https://img.shields.io/badge/ghcr.io-rachavip%2Fnight--library-2496ED?logo=docker&logoColor=white&style=flat-square" alt="ghcr"></a>
<img src="https://img.shields.io/badge/docker%20compose-v2-2496ED?style=flat-square" alt="compose">
<img src="https://img.shields.io/badge/node-20-339933?logo=node.js&logoColor=white&style=flat-square" alt="node">
<img src="https://img.shields.io/badge/%E6%A0%BC%E5%BC%8F-PDF%20%C2%B7%20EPUB%20%C2%B7%20TXT%20%C2%B7%20MOBI%20%C2%B7%20AZW3-8A7256?style=flat-square" alt="formats">
<a href="LICENSE"><img src="https://img.shields.io/badge/license-Proprietary-8A7256?style=flat-square" alt="license"></a>
</p>

</div>

---

夜读是一个自托管的电子书管理与阅读系统：把 NAS 上的书籍文件夹挂进容器，它会自己读完书名、作者和封面，然后在浏览器里排成一座书架。不需要整理文件名，不需要导入书库，也不需要装客户端——加一本新书进文件夹，几分钟后书架上就出现了。

全部数据都在自己的机器上，书籍以只读方式挂载，刮削只读取、不修改原文件。

**目录**：[特性](#特性) · [快速开始](#快速开始) · [部署方式](#部署方式) · [配置](#配置) · [使用指南](#使用指南) · [刮削规则](#刮削规则) · [常见问题](#常见问题) · [目录结构](#目录结构) · [本地开发](#本地开发) · [设计](#设计)

## 特性

| 分类 | 能力 |
| --- | --- |
| **刮削** | 增量扫描，只处理新增或改动过的文件；优先读书籍内嵌元数据，读不到再从文件名解析；封面多级兜底，实在没有就按书名生成一张 |
| **阅读** | PDF / EPUB / TXT / MOBI / AZW3 五种格式直接在网页里读，四种缩放、进度记忆、高亮、笔记、书签，笔记可导出 Markdown |
| **组织** | 继续阅读、最近在读、阅读状态（未读 / 在读 / 读完）、隐藏、丛书分组、批量整理、阅读时长与 30 天统计，排序 / 筛选 / 搜索 |
| **音乐** | 顶栏 ⏮ ▶ ⏭ 直接控制嵌入的播放器（AnyListen 等），一键播放切歌；也支持 Subsonic 系（Navidrome / Airsonic / Gonic）随机播放 |
| **外观** | 四套主题（夜读 / 纸笺 / 墨影 / 青屿）、自定义背景图与名称，桌面与手机自适应 |
| **部署** | 单个容器，镜像约 280 MB；不依赖外部数据库，索引、封面、进度都是 `data/` 下的 JSON 与图片 |

## 快速开始

三步跑起来，只需要 Docker 与 Docker Compose v2。

**1. 准备 compose 文件**

```bash
mkdir -p /vol1/1000/docker/night-library
cd /vol1/1000/docker/night-library
# 把仓库里的 docker-compose.yml 放到这个目录
```

**2. 指向自己的书库**

编辑 `docker-compose.yml`，把 `BOOKS_DIR` 改成 NAS 上真实的书籍目录：

```yaml
environment:
  BOOKS_DIR: /vol1/1000/电子书文件夹名
```

> [!NOTE]
> 默认值是镜像自带的 `demo-books`（3 本示例 txt）。没有改也能启动，书架上会先出现这几本示例书，不会因为路径不存在而报错。也可以在启动后进网页 ⚙ →「电子书文件夹」里添加。

**3. 启动**

```bash
docker compose pull && docker compose up -d
```

打开 `http://NAS地址:8421`，书架会自动开始刮削。

### 关于本文档里的路径与地址

下面的路径、IP、端口都是**示例值**，程序里没有写死任何一项，按自己的环境替换即可：

| 示例值 | 含义 | 说明 |
| --- | --- | --- |
| `/vol1/1000/电子书文件夹名` | 电子书存放目录 | 书放在哪就填哪 |
| `/vol1/1000/docker/night-library` | 项目目录（`docker-compose.yml` 所在层） | 目录名可自取，如 `ebooks` |
| `http://192.168.0.111:9500` | AnyListen 的服务地址 | 换成实际 IP 与端口 |
| `8421` | 宿主机对外端口 | 与其他服务冲突时改掉 |

> [!IMPORTANT]
> **书在一个目录，compose 文件在另一个目录。** 两者不要混放，否则扫描会把项目文件当成书库内容。

## 部署方式

<details open>
<summary><b>方式一 · 使用已构建的镜像（推荐）</b></summary>

镜像由 GitHub Actions 在推送后自动构建并发布到 GHCR，NAS 上只需要一个 `docker-compose.yml`，不需要源码：

```bash
cd /vol1/1000/docker/night-library
docker compose pull
docker compose up -d
```

`image:` 默认走南京大学镜像站前缀 `ghcr.nju.edu.cn/...`，内容和 `ghcr.io` 逐字节相同，国内拉取更快。想用官方源，把 `image:` 换成 `ghcr.io/rachavip/night-library:latest` 即可。

</details>

<details>
<summary><b>方式二 · 本地构建（不经过 GitHub）</b></summary>

把整个项目目录放到 NAS 上，用 `docker-compose.build.yml` 就地构建：

```bash
cd /vol1/1000/docker/night-library
docker compose -f docker-compose.build.yml up -d --build
```

国内网络拉包慢时，改用国内源版本：`Dockerfile.cn` 把 apt 指向阿里云、npm 指向 npmmirror，功能与默认版完全一致：

```bash
docker compose -f docker-compose.cn.yml up -d --build
```

需要带上 `Dockerfile.cn`、`docker-compose.cn.yml`、`package-lock.json`。

</details>

<details>
<summary><b>方式三 · 图形界面部署</b></summary>

飞牛 NAS：**Docker → 项目 → 创建项目**，项目路径选 compose 所在目录，compose 文件选 `docker-compose.yml`，点部署即可，效果与命令行一致。

</details>

### 更新

```bash
cd /vol1/1000/docker/night-library
docker compose pull && docker compose up -d
```

数据在 `./data` 与书库目录里，更新只换容器，不碰数据。页面右上角的版本徽标可以直接查看当前版本与更新说明。

> [!TIP]
> 推荐用 `&&` 串联命令：拉取失败时不会继续启动旧镜像，避免出现「看起来升级了、其实还是旧版本」的假成功。

### 版本与更新检测

主页副标题后有一个版本徽标，点开可看到更新日期、本次改动与「检查更新」。

- **版本号来源**：项目根目录的 `version.json`。页面显示与更新检查都读它，随代码打包进镜像，因此徽标显示的就是实际运行的代码版本。
- **自动提示**：打开页面后会在后台检查一次（30 分钟内不重复），发现新版本时徽标变为琥珀色并带圆点。
- **三种结果**：已是最新 / GitHub 上有新版本（需重新拉取镜像）/ 本机比 GitHub 新（改动尚未推送）。
- 检查先试 GitHub raw，失败再试 jsDelivr，两者都不可达时提示手动查看，不影响正常使用。

## 配置

`docker-compose.yml` 只保留必要项，逐项含义如下：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `image` | `ghcr.nju.edu.cn/rachavip/night-library:latest` | 镜像地址；换回官方源用 `ghcr.io/...` |
| `container_name` | `night-library` | 容器名，对应 `docker logs night-library`、`docker restart night-library` |
| `ports` | `"8421:8080"` | 宿主机 8421 → 容器 8080，8421 被占用就改冒号左边 |
| `/vol1:/vol1:ro` | — | 整个存储池只读挂入且路径一致，网页里填 `/vol1` 下任意目录都能刮到 |
| `./data:/app/data` | — | 索引、封面、转换缓存、进度、笔记，跟随 compose 文件所在目录 |
| `restart` | `unless-stopped` | 开机与异常退出后自动拉起 |

环境变量：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `BOOKS_DIR` | `/app/demo-books` | 默认书籍目录；改成实际书库路径，或在网页里增删 |
| `DATA_DIR` | `/app/data` | 索引、封面、转换缓存、进度 |
| `PORT` | `8080` | 容器内监听端口 |
| `TZ` | `Asia/Shanghai` | 时区 |
| `SCAN_ON_START` | 未设置 | 强制指定启动时是否刮削，覆盖网页设置；`0` 为关闭（首次无索引仍会刮） |
| `SCAN_INTERVAL_MINUTES` | 未设置 | 强制指定定时刮削间隔，覆盖网页设置；`0` 为关闭定时 |
| `MUSIC_URL` | 未设置 | 音乐服务地址，优先级高于网页保存值 |
| `MUSIC_MODE` | `embed` | `embed` 网页嵌入；`subsonic` 随机播放条 |

`SCAN_ON_START`、`SCAN_INTERVAL_MINUTES` 不设置时，默认「启动刮一次 + 每 60 分钟」只在首次使用生效，之后以网页 ⚙ →「自动刮削」里保存的值为准。

> [!NOTE]
> **关于 compose 顶层的 `name:`** —— 可以不写。不写时 Compose 的项目名取 compose 文件所在目录名，容器名由 `container_name` 决定，日常使用没有区别。仓库里 `docker-compose.build.yml`、`docker-compose.cn.yml` 两个变体保留了专用 `name`：它们靠 `-f` 指定，若与主文件同名项目，`up` 时会被当成同一个项目而互相替换容器。

### 挂载其他存储池

默认只挂载 `/vol1`。书籍在 `/vol2` 等其他存储池时，加一行挂载并重建容器：

```yaml
volumes:
  - /vol1:/vol1:ro
  - /vol2:/vol2:ro
```

## 使用指南

### 书房设置

点右上角 **⚙** 打开设置抽屉，改完点「保存设置」。

- **电子书文件夹**：增删要刮削的目录，添加时校验容器内能否访问，保存后自动刮削。移除文件夹并保存时，会一并清理该书目下的封面、转换缓存、进度、笔记、丛书归属、隐藏标记与阅读台账（电子书文件本身不受影响）。
- **名称**：系统名称与副标题，书架标题、页签、阅读器返回按钮同步更新。
- **主题**：夜读（墨蓝 + 琥珀，默认）、纸笺（浅色）、墨影（近黑 + 香槟金）、青屿（深青 + 薄荷绿）。
- **背景图片**：可上传本地图片，或填书籍目录里的相对路径（如 `壁纸/书房.jpg`）；暗度与虚化可调，暗度用于压暗背景保证文字可读。
- **音乐**：默认「网页嵌入」模式，给对应服务填地址即可，重启不丢。

### 自动刮削

往书库里放新书不用手动点「刮削」：

- **启动时刮一次**：默认开启。网页立刻可打开（先读上次索引），刮完书架自动刷新。
- **定时刮削**：默认每 60 分钟一次，书架上方显示「每 60 分钟自动整理 · 下次 HH:MM」。
- **调整无需改 compose**：⚙ →「自动刮削」里改开关与分钟数，保存即生效；间隔填 `0` 关闭定时。
- 手动与自动刮削共用一把锁，不会重叠执行；完成后会提示新增册数。
- 单轮没有变化时连索引文件都不重写；书架上方会显示「跳过 N 册未变化」。

### 音乐

支持两种模式，在 ⚙ → 音乐 里切换。

**网页嵌入（默认）**：把 AnyListen、music-dl、Songloft、MelodyHub、Solara 光域的地址填进去，播放器在面板里嵌入显示，左上角可一键切换服务。顶栏的 ⏮ ▶ ⏭ 直接映射到播放器底部按钮——**点播放就开始，不用先打开面板**，切歌、暂停同理。

服务通过同源反向代理转发（HTTP 与 WebSocket），因此跨域、`X-Frame-Options` 之类的问题在服务端就被处理掉了；代理地址从设置里动态读取，不写死任何 IP。

<details>
<summary><b>顶栏按钮不出声？先确认这几个前提</b></summary>

顶栏按钮本质上是「代点播放器里的按钮」，所以播放器本身得先有歌可放：

1. **先登录一次**：第一次点播放会弹出面板，在面板里输入服务密码。登录状态由浏览器保存，同浏览器只需登录一次；换浏览器或清缓存需重新登录。
2. **确认服务里有能播的歌**：直接打开服务地址，点页面底部的播放键试试。那里放不出声，顶栏按钮也一样——属于音源问题。
3. **多收藏几首**：列表太短，或收藏曲目音源失效（下架、版权限制），都会导致播到一半就停。
4. **循环方式选持续播放的一种**：随机播放 / 单曲循环 / 列表循环，不要选「播完最后一首就停」。
5. **音源与收藏归音乐服务管理**：夜读只负责把按钮映射过去，不管理曲库。

</details>

**随机播放（Subsonic）**：兼容 Navidrome、Airsonic、Gonic 等。填 `IP:端口`（不用写 `http://`）、用户名与密码；密码只保存在容器内 `data/settings.json`，接口返回时打码。由服务端代理请求，浏览器不直连，避开跨域；一次随机取 50 首打乱播放，支持上一首 / 下一首 / 暂停 / 音量，放完自动接下一首。

> [!NOTE]
> 若本站启用 HTTPS 而音乐服务仍是 HTTP，浏览器会因混合内容拦截嵌入页——两边保持同为 HTTP，或给音乐服务也配 HTTPS。

### 格式支持

| 格式 | 阅读 | 说明 |
| --- | --- | --- |
| PDF | ✅ | pdf.js 逐页渲染，四种缩放：匹配宽度 / 匹配页面 / 匹配可见 / 实际大小 |
| EPUB | ✅ | epub.js 渲染，章节跳转与字号调整 |
| TXT | ✅ | 自动识别 UTF-8 / GB18030，按视口重新分页 |
| MOBI | ✅ | 由镜像内置的 KindleUnpack 解包为 EPUB 后阅读，结果缓存 |
| AZW3 | ✅ | 同上 |

MOBI / AZW3 的转换只发生在首次打开时，产物写在 `data/converted/`，原始书籍始终以只读方式挂载，不会被修改。

<details>
<summary><b>实现细节与排查</b></summary>

EPUB / MOBI / AZW3 统一通过带 `.epub` 后缀的地址交给 epub.js（`/api/book/:id/read.epub`）。epub.js 靠 URL 后缀判断「压缩包」还是「已解压目录」：无后缀时它会当成目录去请求 `META-INF/container.xml`，从而打不开。另外 epub.js 不自带解压器，页面必须有全局 `JSZip`，因此 `public/vendor/` 下四个文件缺一不可：`pdf.min.js`、`pdf.worker.min.js`、`jszip.min.js`、`epub.min.js`，由 `scripts/prepare-vendor.js` 在安装与构建时自动生成。

打不开时的排查顺序：

1. 停在「正在打开…」说明仍在转换，大文件可能几十秒。
2. 提示「容器里缺少 python3」= 镜像版本过旧，重新 `docker compose pull`。
3. 提示「转换失败：…」后面是解包器原话，多为源文件加密（DRM）或损坏。
4. 提示「这个文件打不开」= 文件不是标准 EPUB（加密、残缺，或改过扩展名）。原始文件可从 `/api/book/<id>/file` 下载。

</details>

### 阅读器

| 操作 | 效果 |
| --- | --- |
| 鼠标滚轮 | 翻页；一格一页，快速滚动连续翻页。页面高于窗口时先滚到页底再翻页 |
| 底部「首页 / 末页」 | 跳到第一页 / 最后一页；EPUB 对应第一章 / 最后一章 |
| 底部页码框 | 输入页码回车跳转，越界自动修正（仅 PDF / TXT） |
| 底部滑块 | 拖到任意进度 |
| ← → / PageUp PageDown / 空格 | 上一页 / 下一页 |
| Home / End | 首页 / 末页 |
| 选中文字 | 浮出「高亮 / 写笔记」；高亮按 CFI 记录，换字号不跑位，TXT 按页码 |
| 顶栏「笔记」 | 右侧面板汇总高亮、笔记与书签，点击跳回原处，可导出 Markdown |
| 面板「＋ 加书签」 | 记住当前位置（PDF / TXT 按页码，EPUB 按 CFI） |
| `Esc` | 关闭阅读器标签页 |

翻页后自动回到新页顶部；改缩放方式时保持当前页与滚动位置。阅读进度写入 `data/progress.json`，下次打开回到上次位置。

### 继续阅读、隐藏、丛书与统计

首页分左右两栏：左侧是导航（藏书状态、丛书）与「继续阅读 / 最近在读 / 阅读记录」，右侧是格式筛选与书架。窄屏（≤1080px）时左栏变成书架上方一整块，导航改为横向排列。

| 功能 | 说明 |
| --- | --- |
| 继续阅读 | 取进度 1%–97% 且最近打开过的书，按时间倒序，显示封面、进度与读到哪 |
| 阅读状态 | 未读 / 在读 / 读完；翻到 98% 以上自动算读完，也可手动标记 |
| 隐藏 | 不常看的书收起来，书架默认不显示，文件与进度都保留；点左侧「隐藏」只看它们 |
| 丛书 | 手动建组（如「西游记」「二十四史」），一本书可归属多组；丛书筛选与格式筛选可叠加 |
| 批量整理 | 顶栏「整理」进入勾选模式，可一次隐藏、取消隐藏或归入丛书 |
| 阅读统计 | 今天 / 本周 / 今年时长、连续天数、30 天柱状图、最常翻的书、最近读完 |
| 笔记 | 每本书独立，按 CFI 或页码锚定，重复选同一段会合并 |

「全部」筛选与顶部大标题都**不含已隐藏的书**，隐藏了多少会写在副标题和左侧「藏书」组里，不会被悄悄吞掉。

**把一批书归成一组**：搜索关键词（比如「西游记」）→ 顶栏「整理」→「全选 N 本」→「加入丛书」→ 新建并加入，组名会预填成搜索词，改一下即可。之后点左侧该丛书，只看这一组。

阅读时长只统计「标签页可见 + 最近 5 分钟内有操作」的时间，每分钟上报一次，切走时补发，所以页面开着过夜不会记成整夜。

数据文件（删掉即清空，不影响书籍与进度）：

- `progress.json` — 位置、进度、状态、读完时间
- `reading.json` — 按天累计的阅读秒数与每本书时长
- `collections.json` — 丛书与成员
- `hidden.json` — 已隐藏的书 id
- `notes.json` — 高亮、笔记、书签

相关接口：`/api/reading/summary`、`/api/reading/ping`、`/api/collections`、`/api/books/hide`、`/api/book/:id/notes`、`/api/book/:id/status`，笔记导出为 `/api/book/:id/notes/export`（Markdown）。

## 刮削规则

<details>
<summary><b>点开查看完整的元数据、封面与文件名处理逻辑</b></summary>

**1. 优先读书籍内嵌元数据**

EPUB 读 OPF（书名、作者、语言、简介、封面）；MOBI / AZW3 直接解析 PalmDB 头与 EXTH 记录（`server/mobi.js`）；TXT 取第一行作标题，但只认「像标题」的第一行（不超过 24 字、不含逗号句号顿号），否则回退文件名；PDF 读文档属性——先找 trailer 指向的 Info 字典，缺失时读 XMP 的 `dc:title`，都没有才退回书签里最长的一条。PDF 里每个 `/Title` 都可能是书签，只认文档属性可避免把「总目录」当成书名。

内嵌元数据明显不可靠时以文件名为准：`版权信息`、`Unknown`、`!00001`、`SSReader Print.`、`CamScanner`、`扫描全能王`、`Microsoft Word - …` 这类值不会占据书名。

**2. 文件名兜底**

识别 `作者 - 书名`、`书名 (作者)`、`[作者] 书名`、`作者《书名》`、`《书名》01`、Calibre 导出的 `书名_作者_年份` 等写法。末尾括号里的作者（如 `… (陈磊 · 半小时漫画团队)`）拆到作者栏，`(共16册)` 这类册数说明留在书名里。

成套扫描书文件名只剩序号时，用所在文件夹名补全：`【全宋诗】72册/01[652].pdf` → 「全宋诗 01」。仅当文件夹名形如「…72册 / …12卷」时才会这样推导。

**3. 封面按优先级取**

EPUB 内嵌封面（OPF 未声明时在压缩包里找 `cover.*`）→ MOBI / AZW3 由 EXTH 封面索引取图 → 书旁同名 `.jpg/.png` → 目录下的 `cover.jpg`（整套丛书共用一张）→ 渲染 PDF 首页（扫描版、加密版 PDF 没有内嵌封面，但首页通常就是封面）→ 都没有时按书名 / 作者生成字体封面。

补封面不用删索引：放入 `cover.jpg` 或 `某套书 01.jpg` 后点一次「刮削」，缺封面的书会被重新处理一次。

**4. 增量刮削**

每轮先只比对文件体积与修改时间，再检查封面文件是否还在。三者都没变的书直接沿用上次结果，**完全不解析文件**；只有新增、改动或上次刮出乱码的书才真正跑一遍。整轮无变化时不重写 `library.json`。想整库重刮，删掉 `data/library.json` 再点一次「刮削」。

**5. 单本重刮**

封面左下角 `⋯` 打开书籍详情（格式、大小、路径、入馆时间、进度），其中「重新刮削这本」**不走增量判定**：删除该书缓存封面后重新解析，并当场对比书名、作者、封面是否变化。对应接口 `POST /api/book/:id/rescan`，可用脚本批量调用。

索引里每条 PDF 记录带提取器版本号，解析规则升级后旧记录会自动重读一次，因此升级后首次「刮削」偏慢属于正常。

</details>

书架默认按**书名升序**，可切换文件名 / 最近添加 / 书名 / 作者 / 文件大小 / 格式，支持升降序、格式筛选与书名 / 作者 / 路径搜索。排序前会统一空格、标点与全半角，因此「某套书 01」与「某套书01」位置一致，同一套书不会被拆散。

## 常见问题

<details>
<summary><b>拉取镜像报 503</b></summary>

国内镜像站是第三方代理，偶发整站 503（连 `/v2/` 根路径都打不开，说明是它自己挂了）。此时**不要反复 `down`**，容器删掉后就只剩空网络：

```bash
docker compose up -d                       # 先用本地现成镜像把服务拉起来
docker compose pull && docker compose up -d  # 等一两分钟再试
```

仍失败可换 `ghcr.1ms.run`，它和官方 GHCR 返回同一个 digest，镜像内容逐字节一致：

```bash
docker pull ghcr.1ms.run/rachavip/night-library:latest
docker tag ghcr.1ms.run/rachavip/night-library:latest ghcr.nju.edu.cn/rachavip/night-library:latest
docker compose up -d
```

</details>

<details>
<summary><b>页面版本与镜像版本不一致</b></summary>

版本徽标读的是 `version.json`，只能证明这一个文件是最新的。静态文件是否同步，用字节数比对最准（静态文件未压缩，大小应完全相同）：

```bash
wc -c public/css/library.css                      # 本地
curl -s http://NAS地址:8421/css/library.css | wc -c  # 运行中的服务
```

两个数字不同，说明有文件没更新到运行环境。

</details>

<details>
<summary><b>书架只有 3 本示例书</b></summary>

说明 `BOOKS_DIR` 仍指向镜像自带的 `demo-books`，或 `data/settings.json` 里的 `folders` 为空。进 ⚙ →「电子书文件夹」添加真实书库路径并保存即可；`settings.folders` 的优先级高于 `BOOKS_DIR`。

</details>

<details>
<summary><b>音乐面板打不开或嵌入被拒绝</b></summary>

部分站点用 `X-Frame-Options` 或 CSP 禁止被嵌入，测试时会提示「嵌入受限」，播放器顶部同时提供「新窗口打开」作为兜底。连接超时会显示明确错误并自动重试两次；也可以直接打开音乐服务的地址，确认它本身可访问。

</details>

## 目录结构

```
night-library/
├── server/                 扫描、刮削、转换与 HTTP 接口
│   ├── library.js          扫描与刮削（增量、封面兜底、文件名解析）
│   ├── mobi.js             MOBI / AZW3 元数据与封面解析
│   ├── convert.js          KindleUnpack 解包与 EPUB 打包
│   ├── reading.js          阅读时长与统计聚合
│   ├── collections.js      丛书（手动分组）
│   ├── hidden.js           隐藏的书 id
│   ├── notes.js            高亮 / 笔记 / 书签
│   └── musicproxy.js       音乐服务的同源反向代理（HTTP + WebSocket）
├── public/                 书房界面与阅读器（含本地化的 pdf.js / epub.js）
├── demo-books/             示例书籍，未配置书库时的默认目录
├── vendor/
│   └── kindleunpack.zip    纯 Python 的 MOBI / AZW3 解包器（构建时解开，替代 Calibre）
├── data/                   运行时生成：索引、设置、进度、统计、封面、转换缓存
├── version.json            版本号（唯一来源，随代码打包进镜像）
├── Dockerfile
├── Dockerfile.cn           国内源构建版
├── docker-compose.yml
├── docker-compose.build.yml
└── docker-compose.cn.yml
```

## 本地开发

```bash
npm install
SCAN_ON_START=1 npm start
```

不带环境变量时默认扫描项目内的 `demo-books/`，索引写入 `data/`。MOBI / AZW3 的解包需要本机有 `python3`（Windows 可用 `PYTHON_BIN` 指定解释器），缺失时只影响这两种格式的在线阅读，其余功能正常。

镜像只装两样东西：`python3`（跑 KindleUnpack）与 `poppler-utils`（用 `pdftoppm` 渲染 PDF 首页当封面），合计约 30MB。元数据解析与格式转换都由项目内代码完成，因此不需要 Calibre——这也是镜像能压到约 280 MB 的原因。

## 设计

配色、字体与版式 token 集中在 `public/css/tokens.css`：深墨蓝 `#0B121C`、面板 `#111C29`、暖纸色 `#EDE6D8`、琥珀 `#E9A23B`。琥珀只用于「正在发生」的事——阅读进度、焦点、激活态。书库是夜读模式，阅读器默认纸张模式（长时间阅读浅色更省眼），可一键切回夜读。

镜像构建时会执行 `scripts/obfuscate.js`，把 `server/` 与 `public/js/` 就地换成混淆版本，因此从镜像里取出的代码难以直接阅读；仓库中保存的始终是可读源码。混淆只是抬高阅读成本，前端代码最终仍会下发到浏览器，无法阻止有心人逆推。

## 许可

本项目采用**专有许可**（Proprietary License），完整条款见 [LICENSE](LICENSE)。

| 可以 | 需事先取得书面授权 |
| --- | --- |
| 在自己的 NAS / 电脑 / 服务器上部署自用 | 再分发、镜像、打包发布，包括改名换 logo 后当作自己的项目 |
| 改名、换主题、改配置、扩展自己的书库 | 商用：收费服务、随硬件预装、以此为基础提供付费产品 |
| 阅读与研究源代码 | 去除或篡改版权声明与作者署名；作为自己的原创作品提交 |

第三方组件遵循各自许可证：`vendor/kindleunpack` 为 GPLv3，`public/vendor/` 下的 pdf.js 为 Apache-2.0、epub.js 为 BSD-3-Clause、JSZip 为 MIT 或 GPLv3（双许可）。分发包含这些组件的镜像时，请一并保留其许可证与出处。
