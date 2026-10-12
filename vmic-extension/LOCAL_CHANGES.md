# 本地示范音频适配版 1.2.9

来源：[ckckh2023/TsingHuaelt-VMIC](https://github.com/ckckh2023/TsingHuaelt-VMIC)，下载于 2026-10-11，原 manifest 版本 1.2.6。原作者 ckckh2023、greedySnake001，原 MIT LICENSE 保留。此目录为本地改版，未向上游发布。

1.2.9 修复：移除 getUserMedia、createMediaStreamSource 和 WebSocket 构造时的提前播放。接入网站延迟加载的 Html5Recorder 原型 record，保留原构造器、返回值、评分参数及全部回调；onStart 返回、录音与输出 AudioContext 恢复后，延迟 150 ms 从头送入。每次重录独立触发，onStop/onScoreError/clear/release 取消待启动操作。送完保留 300 ms 尾部缓冲，配套脚本显示进度、提前停止及未连接虚拟麦克风等状态。

网站 Html5Recorder 会缓存输入：clear/prepare 保留静音的活跃虚拟音轨，只停音源、清除旧缓冲；release 才关闭全部音轨。getUserMedia 返回独立克隆，权限探测停止自身轨道不会损坏录音输入。停用后应刷新课程页再使用真实麦克风，避免网站复用已关闭的旧流。

依据：2026-10-11 阅读网站公开 `/speech-assess/chivox/chivox-6.1.3-min.js` 和 `/assets/src-ekQmeyPC.js`；回调语义另核对[驰声官方 6.x 文档](https://www.chivox.com/en/docs/sdkDoc/JS-sdk)。参考文件 SHA-256 在项目 source-hashes.json 中，未分发网站 SDK 或业务源码。离线测试不能代替真实评分验证。

1.2.8 修复：配套协议接受 `章节ID:内容ID` 和旧脚本 1.2.0 发出的 `章节ID/内容ID`，统一返回冒号格式；音频扫描与载入采用同样的校验，缺失或无效 ID 仍拒绝。此改动兼容旧脚本，只需重新加载扩展并刷新课程页即可生效。

修改文件：`manifest.json`、`background/background.js`、四个 `content/*.js`；其他文件保留原版本。

- 仅注入 www.tsinghuaelt.com，默认关闭虚拟麦克风、外放和噪音。
- 在 MAIN 世界提供 `ELT_VMIC_COMPANION_1` 同窗口同源消息协议，支持 status、examples、prepare、clear、release。prepare 接收最大 20 MB 的 ArrayBuffer，解码成功后确认时长和题组绑定。
- 保留最近实际播放的音频来源，包括脱离 DOM 的 Audio 对象，供用户选择对应示范音频。不会自动选择最近音频。
- clear/release 使进行中的解码失效；配套脚本在切题时清除音频。release 停止录音图并关闭轨道，clear 保留缓存的静音虚拟音轨。
- 载入失败/无音频时拒绝录音，移除静音流和失败回退真实麦克风的行为。明确停用后刷新课程页，恢复真实麦克风。
- 配套模式下忽略后台音频库同步，避免覆盖本题音频。请使用脚本面板“停用虚拟麦克风”退出配套模式，再使用原扩展音频库控制。
- 自动播放仅由 Html5Recorder 录音开始回调触发，不包装 WebSocket；消息验证 source/origin，网页捕获请求省略凭据。

配套脚本的主观题辅助功能不属于 VMIC。录音和评分仍由网站实际流程完成，未接入或伪造评分接口。
