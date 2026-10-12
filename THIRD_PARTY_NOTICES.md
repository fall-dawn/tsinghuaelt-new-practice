# 源码来源与改动说明

源码阅读与下载日期：2026-10-11（Asia/Shanghai）。本仓库整理了用户脚本、VMIC 适配源码和安装文档；原作者署名及许可证保留。

## 使用的来源

1. **WASD258-jpg/tsh-auto-brush**，GPL-3.0-only，Copyright WASD258-jpg and contributors。
   - 仓库：https://github.com/WASD258-jpg/tsh-auto-brush
   - 阅读文件：`engines/new-engine.user.js`、`tsh-auto-brush.user.js`、`DEVELOPMENT.md`、`EVIDENCE.md` 和 `test/`。
   - 采用或改写：新版 API 地址及参数约定、登录令牌键、`stringifyDoRecord` 编码规则、标准答案和用户作答分离、题型分类、组合题递归展开及填空/拖拽编码。
   - 此项目的 2026-10-08 线上验证是上游作者提供的证据，不代表本地交付版本已在线实测。

2. **FmCoral/tsinghuaelt**，README 和脚本声明 MIT，Copyright FmCoral。
   - 仓库：https://github.com/FmCoral/tsinghuaelt
   - 阅读文件：`main.js`。
   - 参考：按题型分流、可配置尝试与处理间隔的设计。未直接复制其打包代码。

3. **Wesuiliye/tsinghuaelt-auto-answer**。
   - 仓库：https://github.com/Wesuiliye/tsinghuaelt-auto-answer
   - 阅读文件：`auto_submit.py`。
   - 参考：接口批处理及先提交、重新取题、再修正的流程思路。未直接复制 Python 源码；新版实现使用其自身 API 契约。

4. **ckckh2023/TsingHuaelt-VMIC**，MIT，Copyright (c) 2026 ckckh2023, greedySnake001。
   - 仓库：https://github.com/ckckh2023/TsingHuaelt-VMIC
   - 原版本 1.2.6；完整扩展源码及 MIT LICENSE 在 `vmic-extension/` 中保留。本地改版为 1.2.9。
   - 采用：AudioContext 音频解码、MediaStreamDestination 虚拟麦克风、录音图和设备包装、网页音频捕获及扩展音频库。
   - 改动：新增配套脚本协议和解码确认、动态音频捕获、题组清除及取消、拒绝空音频、录音开始回调同步、缓存音轨和权限探测隔离、默认停用/原声及同源校验。详见 `vmic-extension/LOCAL_CHANGES.md`。

其余搜索结果用于项目背景与功能范围对照，未复制源码。版本较早、使用 Angular/旧版签名的代码不构成本文件的接口实现依据。

## 本地实现的主要改动

- 独立实现新版单文件脚本和 Shadow DOM 面板；去掉上游双引擎切换所需的旧站代码。
- 通过明确的课程、章节和内容 ID 处理队列，规避阅读器翻页不更新 URL 的上下文错位。
- 直接编码 API 答案，保留 UUID 与填空 `idx`；按服务器逐题判分确认成功。
- 客观题试错采用有限预算，保留回填机会；人工题和未适配结构纳入报告。
- 引入 AbortController、请求超时、节流、限流退避和写请求不确定时暂停。
- 结果仅在服务器核验后上报完成；语音、媒体、未解锁内容不会被伪报为完成。
- 仅保存数字/布尔设置与运行摘要，支持用户主动导出报告。
- 1.0.1：课程、章节、内容和题目大整数 ID 保留完整精度；原始 JSON 响应在解析前保护大整数；站内导航后自动刷新环境提示；新增错三次后显示答案的完整流程回归测试。
- 1.1.0：依据上游 JudgeHigh 数组契约补齐逐行二选一编码；参考阅读器分页计数和内容 ID 的判断方式，实现页面跟随；独立实现当前标签页的跨页续跑与登录指纹校验；保留待录音结果及已有录音；新增多页面完整流程回归测试。
- 1.2.0：参考上游主观题 `{answer,annex}` 与听力 `attachmentList[].script` 契约，独立实现答案导入、父题材料保留、可选 AI 请求与待评阅处理；增加截图确切 S/C 句子编码、当前题组诊断和 VMIC 配套入口。VMIC 目录保持 MIT，主脚本保持 GPL-3.0-only。
- 1.2.1 / VMIC 1.2.8：修复本地配套协议斜线/冒号绑定格式不一致；两端可独立更新；增加真实面板按钮到扩展接收的回归测试。此问题为本地适配引入，不属于原上游扩展。
- 1.2.2 / VMIC 1.2.9：独立实现 Html5Recorder 录音开始同步、逐次重播、暂停上下文恢复、克隆虚拟音轨、保留 SDK 缓存输入和进度显示。阅读网站公开 chivox-6.1.3-min.js、src-ekQmeyPC.js 及驰声官方文档以核对生命周期，未将这些网站源码加入安装包，也未改动评分或签名参数。

## 许可证

交付代码按 **GNU General Public License version 3 only (GPL-3.0-only)** 分发，许可证全文在 `LICENSE`。

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, version 3 of the License.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

## 阅读源文件的 SHA-256

以下校验值由本地下载的参考源文件生成，见 `source-hashes.json`。参考文件保存在工作区 `.cache/tsinghuaelt-references/`，不包含在安装包内。GitHub 的 `main`/`master` 分支会变动，校验值用于辨别本次实际阅读的版本。
