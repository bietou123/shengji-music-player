# 声迹

真正可用的 Windows 桌面音乐播放器。Electron + React + TypeScript，浅色与近黑色主题，本地资料库、真实在线搜索、播放队列、收藏及自建歌单。首页直接进入播放器，不使用假曲目或演示数据。

[公开源码](https://github.com/bietou123/shengji-music-player) · [发行包](https://github.com/bietou123/shengji-music-player/releases) · [实际测试结果](TEST-RESULTS.md)

## 安装与运行

支持 Windows 10/11 x64，已在 Windows 11 x64 实测。普通用户不需要 Node.js、Python、数据库服务或其他开发环境。

- 安装版：`Shengji-1.0.0-x64-nsis.exe`，可选择安装目录，创建桌面及开始菜单快捷方式。
- 便携版：`Shengji-1.0.0-x64-portable.exe`，双击运行，不需安装。
- 两种版本均包含 Electron、Chromium 音频引擎、SQLite WASM 和运行依赖。
- 当前发行版未购买代码签名证书。Windows 可能显示未知发布者或 SmartScreen 提示，请核对下载来源与 SHA-256。不要关闭系统防护。
- “便携版”指程序免安装；用户资料仍保存在 `%APPDATA%\Shengji`，不与 EXE 放在一起。

本机项目：`D:\Private data\AI\Projects\MusicPlayer`。发行文件在 `release`。

## 音源与边界

| 来源 | 首版状态 | 能力 | 账号 / Key |
| --- | --- | --- | --- |
| 本地文件 | 已启用 | 完整播放、标签、内嵌封面、同名 LRC | 不需要 |
| 网易云音乐 | 已接入，默认启用 | 中英文目录搜索，平台公开提供的免费音频 | 不需要；不接入付费与登录播放 |
| Apple Music / iTunes | 官方接口，默认启用 | 歌曲、歌手、专辑目录与官方试听 | 不需要；不是 Apple Music 完整订阅播放 |
| Internet Archive | 已实现，默认关闭 | 元数据中有可识别 CC / 公有领域许可的音频 | 不需要；本机网络测试超时 |
| Jamendo | 已实现，未配置 | 开放授权曲目；仅在平台允许时下载 | 需自己的 Jamendo Client ID |
| QQ 音乐 | 未接入，不能开启 | 保留扩展位置 | 未实现 |
| Spotify | 未接入，不能开启 | 保留扩展位置 | 未实现 |

网易云使用无需登录的公开 GET 接口，**不是承诺长期兼容的官方开发者 API**，可能因平台调整、地区、版权或网络变化而不可用。仅使用原平台返回的合法可播地址，不生成解锁地址、不使用第三方付费破解服务、不伪造登录凭据、不绕过 DRM。平台的会员与登录曲目只显示相应状态或打开原平台。

Apple 使用官方 [iTunes Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/index.html)，目前查询美国目录，试听时长以实际音频为准，通常约 30 秒。列表的曲目总时长来自目录，底部播放进度反映**当前试听音频**的实际时长。其码率未被接口提供，界面不猜测音质。

完整播放、试听、需登录、需会员、仅原平台、待验证及不可用分别标注。搜索结果展示真实封面、版本、来源和平台提供的音质；同歌曲与歌手聚合，现场、翻唱、纯音乐等不同版本保留。聚合曲目可选择另一个来源。

不能保证“任何歌曲都能找到或完整播放”。来源上架目录、版权地区、平台权限和网络连通性始终生效。搜索不自动下载歌曲，也不把试听当完整版。

Jamendo 凭据由 Electron `safeStorage` 使用 Windows DPAPI 加密，不写入源码、日志或明文设置。Client ID 可在设置中添加或清除。Internet Archive 的许可由上传方元数据声明，使用者仍须遵守署名、非商业、相同方式共享等许可条件。下载按钮只出现于平台允许下载且有可识别许可的曲目；网易云、Apple 和本地文件不提供下载按钮。

## 日常使用

- 导入音乐：本地音乐页的导入按钮，左侧导入文件夹，或把文件 / 文件夹拖到窗口。扫描范围由用户选择，不自动扫描整个硬盘。
- 格式：MP3、FLAC、WAV、AAC、M4A、OGG、Opus、WebM。使用 Chromium 成熟音频引擎；不支持的特定编码、损坏文件会明确报错。
- 播放：播放 / 暂停、上一首 / 下一首、拖动进度、音量、静音，以及顺序、随机、单曲循环、列表循环。
- 队列：加入队列、下一首播放、拖拽 / 上下移动、逐首移除、清空。重复曲目保持各自队列位置。
- 歌单：创建、重命名、删除、添加 / 移除曲目、拖拽排序。收藏、最近播放、搜索历史均可保存。
- 歌词：读取音频旁边同名 UTF-8 `.lrc`，点击歌词跳转。本版不获取平台在线歌词。
- 系统：媒体键、系统媒体会话、托盘播放控制、迷你播放器。关闭到托盘可以在设置中开启，默认关闭窗口即退出。
- 重启：恢复队列、当前曲目、进度、音量、静音、播放模式、主题和歌单，**不会自动播放**。

删除资料库条目或移除扫描目录不会删除磁盘上的音乐。目录扫描为手动重新扫描，不是实时文件系统监视。

## 数据与隐私

运行数据：`%APPDATA%\Shengji`。

- `library.sqlite`：音乐索引、收藏、最近播放、歌单、队列、搜索历史、设置及加密凭据。
- `artwork`：本地音频内嵌封面的提取缓存。
- 下载：设置中选择的目录，默认 Windows 音乐目录下的“声迹下载”。

本地音乐和标签**不会自动上传**。在线搜索会把主动输入的查询词发送给已启用的音源；在线播放及封面加载会连接原平台 CDN。没有分析统计、广告或自动更新服务。备份时退出播放器后复制整个用户资料目录；不要将资料库与凭据上传到公共仓库。

## 架构

```text
src/                  React 视图、Zustand 状态、Chromium HTMLAudio 播放控制
shared/               曲目 / IPC 类型、版本感知聚合、队列模式逻辑
electron/main.ts      窗口、托盘、媒体键、IPC 校验、授权下载
electron/preload.ts   contextBridge 白名单 API
electron/sources.ts   SourceAdapter 与音源注册表
electron/network.ts   超时、缓存、单次瞬时重试、请求去重与媒体 URL 校验
electron/library.ts   music-metadata 标签 / 封面、扫描、lrc-kit 歌词解析
electron/media.ts     本地音频 / 封面协议、HTTP Range、路径授权
electron/database.ts  SQLite（sql.js），参数化 SQL、原子文件替换保存
tests/                单元测试、真实接口冒烟、Playwright Electron 端到端测试
scripts/              开发、构建与图标生成
```

渲染进程开启 `contextIsolation` 与 sandbox，关闭 Node 集成。IPC 校验调用窗口、页面来源和 Zod 参数；不暴露通用文件读写或任意 IPC。阻止任意新窗口与页面导航。本地媒体只允许资料库已有曲目及对应缓存封面，支持 Range 拖动播放。API 请求默认 12 秒超时，最多一次瞬时错误重试，常规目录缓存 3 分钟；单个音源出错不会阻止其他来源，界面可单独重试。

扩展来源时实现 `SourceAdapter.search` / `resolve`，在注册表中添加描述和适配器，扩展共享 `SourceId`、IPC 来源校验及媒体域名允许列表，并为播放权限、实际音质、错误隔离添加测试。需要官方账号 / OAuth / DRM 的来源，必须另外实现原平台授权和获许可的播放能力。

## 开发与验证

建议 Node.js 22.12+ 或 24 LTS、npm，Windows x64。

```powershell
npm ci
npm run dev
```

开发脚本会启动本地 Vite 与 Electron，控制台输出实际地址。它是桌面应用，单独打开网页不能使用本地 IPC 能力。关闭开发播放器后开发服务也会退出。

```powershell
npm run typecheck
npm test
npm run test:online
npm run build
npm run test:e2e
npm run package
# 打包完成后验证便携启动器、播放及恢复
npm run test:portable
```

端到端测试默认读取桌面的 `Florian Bur - Living.mp3`，只读取，不修改原文件。其他电脑可以指定自己的合法 MP3（这项测试仍会检查 Living / Florian Bur 的标签）。测试生成独立资料库和带标签 / LRC 的 WAV，不修改正常使用数据；窗口位于屏幕外，不占任务栏、不创建测试托盘，音频静音。

```powershell
$env:SHENGJI_LOCAL_TEST_FILE = 'D:\Music\Florian Bur - Living.mp3'
npm run test:e2e

# 可跳过联网部分，跳过项会明确记入结果
$env:SHENGJI_E2E_SKIP_ONLINE = '1'
npm run test:e2e

# 验证打包后的程序而不是开发 Electron
$env:SHENGJI_E2E_EXECUTABLE = (Resolve-Path 'release\win-unpacked\声迹.exe').Path
npm run test:e2e

# 便携启动器不转发 inspector 输出，使用独立的本机 CDP 测试
npm run test:portable
```

PowerShell 中环境变量会保留到当前终端关闭；重新做联网测试前需清除 `SHENGJI_E2E_SKIP_ONLINE`。`SHENGJI_DATA_DIR` 可指定独立资料目录，默认无需配置。

便携测试默认检查 `release/Shengji-1.0.0-x64-portable.exe`，可用 `SHENGJI_PORTABLE_EXECUTABLE` 指定其他路径。它使用临时的本机调试端口与独立资料库，窗口在屏幕外、音频静音；不使用 `_electron.launch` 连接解压启动器。普通启动不会开放调试端口。

构建包含 NSIS 安装版、免安装便携版和 `release\win-unpacked`。`package-lock.json` 锁定依赖；发行包包含所需运行库。第三方依赖遵循各自许可证，本项目 MIT 许可不授予任何歌曲、封面或平台服务的再分发权。

实际验证结果与未验证项见 [TEST-RESULTS.md](TEST-RESULTS.md)。原始测试 JSON 和截图在本机 `test-artifacts`，不上传用户路径、资料库或音频。

## 常见问题

- 搜索失败：查看具体音源错误，单独重试或关闭该音源；未接入来源不能打开，不以假结果代替。
- 播放失败：免费曲目也可能被下架或地区限制。重新解析音源 / 打开原平台，或使用合法本地文件。
- 本地歌曲不见：文件已移动时重新导入，播放器不会自行移动或删除原音频。
- 没有封面：该文件可能没有内嵌封面，或平台封面暂时不可达，显示唱片占位图标。
- 媒体键无反应：检查设置以及其他程序是否占用全局媒体键。托盘与窗口按钮仍可使用。
- 没有下载按钮：当前来源不允许下载或未返回可识别许可，这是权限限制，不是功能故障。

## 许可

[MIT](LICENSE)，Copyright (c) 2026 bietou123。项目不捆绑、上传或发布用户音频。
