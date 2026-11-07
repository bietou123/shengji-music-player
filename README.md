# 声迹

真正可用的 Windows 桌面音乐播放器。Electron + React + TypeScript，液态玻璃视觉、浅色与近黑色主题，本地资料库、真实在线搜索、同步歌词、十段均衡器、真实音频频谱、播放队列、收藏及自建歌单。首页直接进入播放器，不使用假曲目或演示数据。

[公开源码](https://github.com/bietou123/shengji-music-player) · [发行包](https://github.com/bietou123/shengji-music-player/releases) · [实际测试结果](TEST-RESULTS.md)

## 安装与运行

支持 Windows 10/11 x64，已在 Windows 11 x64 实测。普通用户不需要 Node.js、Python、数据库服务或其他开发环境。

- 安装版：`Shengji-1.2.0-x64-nsis.exe`，可选择安装目录，创建桌面及开始菜单快捷方式。
- 便携版：`Shengji-1.2.0-x64-portable.exe`，双击运行，不需安装。
- 两种版本均包含 Electron、Chromium 音频引擎、SQLite WASM 和运行依赖。
- 当前发行版未购买代码签名证书。Windows 可能显示未知发布者或 SmartScreen 提示，请核对下载来源与 SHA-256。不要关闭系统防护。
- “便携版”指程序免安装；用户资料仍保存在 `%APPDATA%\Shengji`，不与 EXE 放在一起。

源码根目录包含开发与构建配置，本地构建的发行文件在 `release`。

## 音源与边界

| 来源 | 当前状态 | 能力 | 账号 / Key |
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
- 歌词：优先读取音频旁边同名 UTF-8 `.lrc`，网易云完整曲目可获取在线歌词及翻译，同步歌词支持点击跳转。本地曲目只有主动点击“匹配在线歌词”才联网匹配。
- 音效：底部音效按钮打开十段均衡器、音色预设、立体声宽度及动态压缩；立即生效并保存，可一键关闭音效恢复原声。
- 外观：播放栏、导航选中态、搜索工具栏、菜单、音效面板和迷你播放器使用玻璃材质；设置可分别关闭“玻璃效果”和“界面动画”。
- 动画：按压回弹、连续滑动的导航指示器、切歌及面板进出过渡。频谱来自实际播放信号，暂停时冻结，不播放时不模拟跳动；尊重系统“减少动态效果”。
- 系统：媒体键、系统媒体会话、托盘播放控制、迷你播放器。关闭到托盘可以在设置中开启，默认关闭窗口即退出。
- 重启：恢复队列、当前曲目、进度、音量、静音、播放模式、主题和歌单，**不会自动播放**。

删除资料库条目或移除扫描目录不会删除磁盘上的音乐。目录扫描为手动重新扫描，不是实时文件系统监视。

## 液态玻璃与 GPU

1.2.0 的视觉参考 iOS 26 Liquid Glass，**不是 Windows 上的苹果原生材质**，也不是任意 DOM 的物理级光线追踪。

- **真实页面背景**：Chromium `backdrop-filter` 模糊玻璃后方的实际 DOM；透明填色、内侧边缘及阴影提供厚度感。它不读取 Windows 桌面或其他应用。
- **真实封面折射**：Three.js / WebGL2 片元着色器对播放栏及迷你窗口的实际封面下衬做边缘位移采样。DOM 图像与纹理使用相同的 `object-fit: cover` 映射。图像只在更换时缩至最长边 512 像素，绝不截屏 DOM；远程图像不允许 CORS 时仍可显示，但不交给着色器采样。
- **光学近似**：圆角距离场形成窄边缘的折射、柔和高光及 Fresnel 近似，高光随指针移动。其他玻璃表面只有真实 DOM 模糊和近似边缘光照，不宣称着色器能够直接读取它们后方的页面。没有封面时不生成假背景。
- **交互路径**：按压、导航和面板使用 `transform` / `opacity`，不逐帧动画化布局。进度、音量及均衡器滑块即时更新，不等待动画；列表保留紧凑普通行，不逐行增加玻璃层。
- **渲染预算**：每个窗口只有一个 WebGL 画布与一个共享 RAF 调度器，最多 8 个复用的光学表面；画布最多约 150 万像素，DPR 不超过 1.5。交互结束后不继续提交玻璃帧。频谱以约 30Hz 读取真实 Web Audio 信号，不每帧更新 React 全局状态。
- **可见性与降级**：隐藏、最小化、页面不可见或频谱滚出视野时停止不必要的绘制，音频继续运行。减少动态效果或关闭动画后保持静态材质。Electron 报告硬件合成不可用、WebGL2 创建失败或上下文丢失时改用不透明普通界面，播放、搜索和操作不依赖 WebGL；可恢复的上下文恢复后重新绘制。
- **安全边界**：沿用 Chromium 默认硬件选择与驱动黑名单，不强制启用 GPU，不关闭 sandbox、`contextIsolation` 或 `webSecurity`。主窗口与迷你窗口实时同步主题及视觉开关。

硬件后端、像素读回、交互帧间隔和 Chromium trace 的实测结果及限制见 [TEST-RESULTS.md](TEST-RESULTS.md)。测试中的屏外渲染提交率不等同于屏幕显示帧率；不以 canvas 存在或配置开关冒充 GPU / 60fps 验证。

## 歌词与音效

本地 LRC 优先于在线匹配。手动匹配会查询已启用的网易云歌词目录，必要时查询 [LRCLIB](https://lrclib.net/)，只接受歌曲名、歌手、版本及录音时长相符的结果；匹配结果保存到 SQLite，重启后无需重新请求。没有可靠匹配时显示真实的无歌词或失败状态，不生成歌词。纯音乐只有在来源明确标记时显示“纯音乐”；官方试听不套用完整版的同步时间轴。LRCLIB 只有纯文本歌词时不启用时间跳转。

音效使用 Chromium Web Audio 的原生 `BiquadFilterNode`、`DynamicsCompressorNode` 和立体声矩阵处理，不修改音乐文件。提供原声、钢琴、人声、低音、温暖、清亮、夜间和自定义音色，均衡器范围为 ±12 dB，声场范围为 0–150%。默认关闭音效，频谱默认开启。启用“自动适配”时按歌曲标题、专辑、歌手及已有类型标签选择预设，**不是 AI 听音识别**；没有匹配标签时保持原声。夜间预设会启用动态压缩。

均衡器提升或扩展声场时，按照整条滤波链的频响预留输入余量，参数变更平滑过渡以减少突变。动态压缩使用原生压缩器的自动补偿增益，不等同于简单降低音量，也不宣称完成响度标准化或扬声器校准。主窗口与迷你播放器共享同一个音频引擎。

## 数据与隐私

运行数据：`%APPDATA%\Shengji`。

- `library.sqlite`：音乐索引、收藏、最近播放、歌单、队列、搜索历史、手动歌词匹配结果、音效设置及加密凭据。
- `artwork`：本地音频内嵌封面的提取缓存。
- 下载：设置中选择的目录，默认 Windows 音乐目录下的“声迹下载”。

本地音乐和标签**不会自动上传**。在线搜索会把主动输入的查询词发送给已启用的音源；点击“匹配在线歌词”会发送当前本地歌曲的标题、歌手和时长，**不会发送音频或文件路径**。在线播放、在线歌词及封面加载会连接对应平台。没有分析统计、广告或自动更新服务。备份时退出播放器后复制整个用户资料目录；不要将资料库与凭据上传到公共仓库。

## 架构

```text
src/                  React 视图、Zustand 状态、Chromium HTMLAudio 播放控制
src/audio-graph.ts    Web Audio 均衡器、输入余量、压缩、声场和 FFT 分析
src/Spectrum.tsx      实际信号的 canvas 频谱、暂停与减少动态效果适配
src/Glass.tsx         单个 Three.js WebGL2 光学层、真实封面下衬与硬件降级
src/glass.css         DOM 背景玻璃、短促过渡、浅深主题与无动画样式
src/visual-runtime.ts 按需 RAF 调度、窗口及页面可见性、动态效果策略
src/Presence.tsx      菜单与面板退出动画期间的生命周期
shared/               曲目 / IPC 类型、版本感知聚合、队列与音效预设逻辑
electron/main.ts      窗口、托盘、媒体键、IPC 校验、授权下载
electron/preload.ts   contextBridge 白名单 API
electron/sources.ts   SourceAdapter 与音源注册表
electron/network.ts   超时、缓存、单次瞬时重试、请求去重与媒体 URL 校验
electron/library.ts   music-metadata 标签 / 封面、扫描、lrc-kit 歌词解析
electron/lyrics.ts    本地 LRC、网易云歌词 / 翻译及用户主动发起的在线匹配
electron/media.ts     本地媒体授权、适配器授权的在线音频代理、HTTP Range
electron/database.ts  SQLite（sql.js），参数化 SQL、原子文件替换保存
tests/                单元测试、真实接口冒烟、Playwright Electron 端到端测试
scripts/              开发、构建与图标生成
```

渲染进程开启 `contextIsolation` 与 sandbox，关闭 Node 集成。IPC 校验调用窗口、页面来源和 Zod 参数；不暴露通用文件读写或任意 IPC。阻止任意新窗口与页面导航。本地媒体只允许资料库已有曲目及对应缓存封面，支持 Range 拖动播放。API 请求默认 12 秒超时，最多一次瞬时错误重试，常规目录缓存 3 分钟；单个音源出错不会阻止其他来源，界面可单独重试。

在线音频只能经主进程从适配器返回的合法可播地址创建不透明授权，再通过自定义媒体协议播放；每次重定向均校验来源域名，不开放任意 URL 代理。这样既支持进度 Range，也避免跨域 Web Audio 分析被浏览器安全机制静音。

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
npm run test:glass
npm run package
# 打包完成后验证便携启动器、播放及恢复
npm run test:portable
```

端到端测试默认读取桌面的 `Florian Bur - Living.mp3`，只读取，不修改原文件。其他电脑可以指定自己的合法 MP3（这项测试仍会检查 Living / Florian Bur 的标签）。测试生成独立资料库和带标签 / LRC 的 WAV，不修改正常使用数据；窗口位于屏幕外，不占任务栏、不创建测试托盘，通过 Chromium `--mute-audio` 保持扬声器静音。音效测试使用已知频率的数字信号实测 FFT、均衡器增益和压缩器变化，不把静音测试冒充人工试听。玻璃测试另用明确命名的合成封面测试图验证颜色与像素变化，它不属于产品默认内容，也不随发行包发布。

```powershell
$env:SHENGJI_LOCAL_TEST_FILE = 'D:\Music\Florian Bur - Living.mp3'
npm run test:e2e

# 可跳过联网部分，跳过项会明确记入结果
$env:SHENGJI_E2E_SKIP_ONLINE = '1'
npm run test:e2e

# 验证打包后的程序而不是开发 Electron
$env:SHENGJI_E2E_EXECUTABLE = (Resolve-Path 'release\win-unpacked\声迹.exe').Path
npm run test:e2e
npm run test:glass

# 更详细的 GPU 服务跟踪，另存详细样本，不覆盖标准证据
$env:SHENGJI_GLASS_TRACE_DETAIL = '1'
npm run test:glass
Remove-Item Env:SHENGJI_GLASS_TRACE_DETAIL

# 便携启动器不转发 inspector 输出，使用独立的本机 CDP 测试
npm run test:portable
```

PowerShell 中环境变量会保留到当前终端关闭；重新做联网测试前需清除 `SHENGJI_E2E_SKIP_ONLINE`。`SHENGJI_DATA_DIR` 可指定独立资料目录，默认无需配置。

便携测试从 `package.json` 读取版本，默认检查相应的 `release/Shengji-<版本>-x64-portable.exe`，可用 `SHENGJI_PORTABLE_EXECUTABLE` 指定其他路径。它使用临时的本机调试端口与独立资料库，窗口在屏幕外、音频静音；不使用 `_electron.launch` 连接解压启动器。普通启动不会开放调试端口。

构建包含 NSIS 安装版、免安装便携版和 `release\win-unpacked`。`package-lock.json` 锁定依赖；发行包包含所需运行库。第三方依赖遵循各自许可证，本项目 MIT 许可不授予任何歌曲、封面或平台服务的再分发权。

实际验证结果与未验证项见 [TEST-RESULTS.md](TEST-RESULTS.md)。原始测试 JSON 和截图在本机 `test-artifacts`，不上传用户路径、资料库或音频。

## 常见问题

- 搜索失败：查看具体音源错误，单独重试或关闭该音源；未接入来源不能打开，不以假结果代替。
- 播放失败：免费曲目也可能被下架或地区限制。重新解析音源 / 打开原平台，或使用合法本地文件。
- 本地歌曲不见：文件已移动时重新导入，播放器不会自行移动或删除原音频。
- 没有封面：该文件可能没有内嵌封面，或平台封面暂时不可达，显示唱片占位图标。
- 没有歌词：先检查同名 LRC；本地曲目可主动联网匹配。纯音乐不伪造歌词，试听不假装有完整版同步歌词，网络失败可单独重试。
- 音色不适合：自动适配只根据标签选择预设，可改为原声、其他音色或自定义；关闭音效即可旁路均衡器、压缩和声场处理。
- 玻璃或动画不合适：在设置中分别关闭。系统减少动态效果会自动停用动画；GPU / WebGL 不可用时自动降级，不需要关闭系统安全机制。
- 媒体键无反应：检查设置以及其他程序是否占用全局媒体键。托盘与窗口按钮仍可使用。
- 没有下载按钮：当前来源不允许下载或未返回可识别许可，这是权限限制，不是功能故障。

## 许可

[MIT](LICENSE)，Copyright (c) 2026 bietou123。项目不捆绑、上传或发布用户音频。
