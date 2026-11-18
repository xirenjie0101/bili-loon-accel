# BiliAccel · B 站双端加速 Loon 插件（实时诊断版）

让 **哔哩哔哩国际版（白色图标）** 和 **国内版** 在海外看视频时，取视频数据走「线程撕裂者」的办法：把 App 要的那一段拆成小块，**同时向多个大陆 / 海外 CDN 节点要**，多取的放进预读缓存，App 下一段直接命中。

和之前几版最大的不同：**它会告诉你（和 Claude）到底有没有加速**。开着插件看视频，每一个视频请求、App 拿到的播放地址、每个节点的速度，都会实时写进你自己的私有 GitHub 仓库；Claude 在对话里直接读这个仓库，边看边分析。

| | 链接 |
| --- | --- |
| 插件地址（Loon → 配置 → 插件 → `+`） | `https://raw.githubusercontent.com/xirenjie0101/bili-loon-accel/main/dist/BiliAccel.plugin` |
| iPhone 上一键导入 | [导入到 Loon](https://www.nsloon.com/openloon/import?plugin=https%3A%2F%2Fraw.githubusercontent.com%2Fxirenjie0101%2Fbili-loon-accel%2Fmain%2Fdist%2FBiliAccel.plugin) |
| 统计页（Safari） | `https://www.bilibili.com/__bla__/` |

> 非官方工具，与哔哩哔哩无关。只优化你本来就有权看的视频的下载方式，不绕过登录、会员、地区或版权限制。加速内核来自 [BTR-iOS](https://github.com/xirenjie0101/btr-ios) 1.5，最初移植自 [Bilibili-thread-ripper](https://github.com/MrTangLuyao/Bilibili-thread-ripper)（MIT）。

---

## 更新记录

- **2.0.1**（2026-11-17）第一次真机实时遥测（洛杉矶）之后的修正：两个 App 拿到的都是海外节点（Akamai + cosov），都走**明文 HTTP**，App 自己单连接就有 0.8～1.3 MB/s；而插件用 HTTPS 去大陆镜像只有 2～70 KB/s，每次等满 8 秒，反而让 App 卡住、反复重试。改为：**App 自己的节点排第一、开多条连接**；子请求跟 App 用同一个协议（HTTP）；App 要的字节只交给它自己的节点和测过速的节点，没测过的节点只做预读探测；等待上限不超过 App 自己那条路线所需的时间（最短 2.5 秒），拿不齐立刻放行；保险丝 3 次失败就跳。网速体检改成测「原地址 1 连接 / 4 连接 / 海外镜像 / 大陆镜像（HTTP）/ HTTPS 4 路」。统计页加了「▶ 开始实时诊断」「▶ 网速体检」两个链接（也可以直接打开 `https://www.bilibili.com/__bla__/live`、`/__bla__/speed`），不用再去 Loon 里找手动脚本。
- **2.0.0**（2026-11-17）首个版本：双端识别、实时遥测、播放地址侦察、自检页、网速体检。

---

## 为什么之前「国际版没反应」，这次怎么查

之前没有办法知道问题出在哪一层。可能的原因有好几种，每一种的修法都不一样：

| 可能的原因 | 现在从哪里看出来 |
| --- | --- |
| App 的视频请求根本没进脚本（走了 QUIC、被你的本地规则抢先匹配、MITM 证书没被信任、域名或端口没覆盖） | 「播放地址侦察」看到了 App 拿到的 CDN 地址，但没有任何对应的媒体请求事件 |
| App 拿到的全是 PCDN / 中转地址（`*.mcdn.bilivideo.cn:4483`、`szbdyd.com` 等），镜像节点不认 | 侦察事件里 `PCDN n`；媒体事件 `relay` |
| 国际版用了网页式播放器（请求带 `Origin`），脚本按规矩不碰 | 媒体事件 `skip`，原因「网页发出的请求」 |
| 请求进来了，但走了没见过的路径 / 播放器不接受分块答复 / 节点全拒绝 | 媒体事件 `unknown` / `pass` / `fail`，带原因 |
| 加速了，但这条网络上多连接也不比单连接快 | 「网速体检」直接给出 单连接 vs 8 路 vs 16 路 的速度 |
| 真的加速了 | 媒体事件 `miss`/`part`/`hit`，带每批速度、参与的节点、App 实际取数速度 |

另外两个之前没覆盖的地方这次补上了：明文 HTTP（端口 80）的媒体请求，以及 `.mp4` 渐进式文件。

---

## 安装（3 步）

**前提**：Loon 3.5.1（build 983）以上；已安装并**信任** Loon 的 MITM 证书（设置 → 通用 → 关于本机 → 证书信任设置），MITM 总开关打开。先关掉 BiliUniverse Redirect、btr-ios、bilibili-thread-ripper-loon 等同类插件。

1. **加插件**：用上面的「一键导入」，或在 Loon 里粘贴插件地址。
2. **开实时遥测**（推荐，3 分钟）：
   1. 打开 [新建 fine-grained token](https://github.com/settings/personal-access-tokens/new?name=BiliAccel+telemetry&description=Loon+plugin+writes+live+telemetry+into+bili-loon-accel-telemetry&target_name=xirenjie0101&expires_in=90&contents=write)（名称、过期时间、Contents 权限已经预填）；
   2. **Repository access** 选 **Only select repositories** → 只勾 `bili-loon-accel-telemetry`；
   3. 确认 **Repository permissions → Contents = Read and write**，其余都不要；
   4. 生成后复制令牌，粘到 Loon 插件参数「遥测令牌（GitHub）」里。「遥测仓库」保持 `xirenjie0101/bili-loon-accel-telemetry`。
3. **看一遍是否通**（见下一节）。

> 为什么单独建一个私有仓库：这个令牌放在手机上。它只能写那个遥测仓库，碰不到插件仓库本身——即使令牌泄露，别人也改不了你 Loon 里运行的脚本。

---

## 验证流程（每一步都会实时上报）

1. **规则自检**：Safari 打开 [HTTPS 自检](https://upos-sz-mirrorali.bilivideo.com/__bla_selftest__.m4s) 和 [HTTP 自检](http://upos-sz-mirrorali.bilivideo.com/__bla_selftest__.m4s)。看到「✅ … 媒体规则已触发」说明脚本下载、规则、MITM 证书都没问题。
2. **开始实时诊断**：Safari 打开 `https://www.bilibili.com/__bla__/live`（或统计页里的「▶ 开始实时诊断」）。收到通知「实时诊断已开始 · 设备 xxxxxxxx」= 遥测通了。接下来 30 分钟每分钟上报一次（播放期间每 20 秒）。
3. **播放**：国际版、国内版各挑一个平时会卡的视频看 2～3 分钟（冷门、高码率最好）。
4. **网速体检**：Safari 打开 `https://www.bilibili.com/__bla__/speed`，等约 1 分钟出结果（用你刚看的视频地址测：原地址 1 连接 / 4 连接 / 海外镜像 / 大陆镜像 / HTTPS）。
5. **对照**（可选）：插件参数「工作模式」改成「只观察（对照）」，再看同类视频 2 分钟，再改回「加速」。同一把尺子（App 实际取数速度）比较两种模式。

做完这些，在对话里告诉 Claude，它会直接读遥测仓库给出结论和下一步改法。

---

## 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| 工作模式 | 加速 | 只观察（对照）：所有视频请求原样放行，但照样计时、上报 |
| 并发连接数 | 自动 | 16 条起步，App 等得久就加一档（最多 48），加了没变快就退回，节点限流就退一档 |
| 预读大小 | 4MB | App 要一小段时顺便多取多少放进缓存 |
| 缓存上限 | 16MB | Loon 不稳定（VPN 自己断开）就调到 8MB |
| CDN 优先 | 海外CDN | App 自己的节点永远第一个用；这里决定其次先试海外还是大陆镜像 |
| 大范围取流请求 | 分块答复 | 开着插件 App 放不了视频时改成「原样放行」 |
| 侦察播放地址 | 开 | 只读，记录 App 拿到的播放地址指向哪些 CDN |
| 遥测令牌 | 空 | 留空 = 不上报任何东西 |
| 遥测仓库 | xirenjie0101/bili-loon-accel-telemetry | owner/repo |
| 通知 | 开 | 每个 App 第一次加速成功、保险丝跳闸、诊断结果各一条 |

---

## 遥测写了什么、不写什么

**写**：CDN 主机名和端口、http/https、路径类型（如 `upgcxcode`）、清晰度编号（如 30080 = 1080P）、请求的字节范围大小、答复用时、App 等待时间、取回字节数和速度、参与的节点、放行原因、App 类型（国际版 / 国内版，来自地址里的 `platform=`）和版本号、插件设置、各节点的速度表。

**不写**：Cookie、账号、`mid`、`buvid`、`access_key`、完整视频地址（签名 `upsig` / `hdnts`）、视频编号（cid / BV 号）。文件标识只用一段哈希。最近一次视频地址只留在手机里，给「网速体检」用。

文件位置：`live/<设备ID>/<日期>/<序号>.json`（心跳是 `hb-<时间>.json`）。同一批记录重发不会重复存（GitHub 对已存在的文件返回 422，插件当作已送达）。

---

## 原理（简）

- **媒体请求**：App 要 `Range: bytes=a-b`（约 1 MB）。缓存里有 → 立即答复；没有 → 一批并行取回 `[a,b]` 和后面几 MB：每条连接按它的节点实测速度分到「约 1 秒能送到」的量，App 要的那段交给最快的几条，其余预读进 `$persistentStore`。`bytes=a-`（一直读到底）的请求只答复一块（206 + `Connection: close`），播放器会从下一个位置重新要；反复重要同一位置就自动放行。任何错误都原样放行。
- **对照基线**：每 45 秒有一块预读交给 App 自己的原地址、单连接去取（数据照样有用），得到「App 自己能拿到多快」。
- **App 实际取数速度**：同一条流上两次相邻请求的间隔 = App 拿到上一段花的时间。加速和只观察两种模式都用这把尺子。
- **侦察**：`PlayView` / `PlayViewUnite`（gRPC，`$utils.ungzip` 解压）和 REST `playurl` 的响应里找出所有媒体地址，只数主机名，不改任何内容。

Loon 的限制（脚本必须整块答复、`$done` 之后脚本立刻结束）决定了它不能像桌面版那样边下边写，所以是「预读缓存」而不是流式；实际效果以遥测为准。

---

## 开发

```bash
node build.js                    # 生成 dist/
bash test/setup.sh               # 第一次：生成测试用视频（ffmpeg）和自签证书（openssl）
npm test                         # 36 个测试：模拟 Loon 运行环境 + 限速的假 CDN + 假 GitHub API
node tools/live.mjs <遥测仓库的本地 clone> --minutes 30 [--watch 20]   # 读遥测、给结论
```

`src/bili-accel.template.js` 是唯一的脚本（媒体加速、侦察、统计页、定时上报、手动诊断）；`src/BiliAccel.plugin.template` 是插件（Loon 3.5.1 新脚本语法）。

## 许可与致谢

MIT。加速内核与思路来自 [MrTangLuyao/Bilibili-thread-ripper](https://github.com/MrTangLuyao/Bilibili-thread-ripper)（MIT，© 2026 Bilibili-thread-ripper contributors），见 `LICENSE-BTR`。
