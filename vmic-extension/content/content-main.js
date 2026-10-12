// 多文件播放列表
(() => {
  'use strict';
  const TOKEN = 'VMIC_TSINGHUAELT_01';
  // 内置噪音名
  const NOISE_NAMES = ['ocean-waves', 'rain', 'stream', 'thunder'];

  const state = {
    enabled: false,    // 本地适配：显式载入音频后启用
    delayMs: 800,      // 延时时间
    volume: 1,         // 录音音量
    monitor: false,    // 避免播放和录音串音
    loop: false,       // 循环播放
    mode: 'auto',      // 自动模式
    audioSig: '',      // 当前文件源的内容签名
    noiseOn: false,    // 示范音频保持原声
    noiseRandom: true, // 启用随机噪音
    noiseId: 'rain',   // 指定噪音名
    noiseVol: 0.1,     // 噪音音量
    playbackRate: 1    // 变速变调
  };

  let ctx = null;              // 共享 AudioContext
  let audioRaw = null;         // 原始 ArrayBuffer
  let audioBuffer = null;      // 解码后的 AudioBuffer
  let decodeDone = true;       // 当前 audioRaw 是否已解码完成
  let everSynced = false;      // 是否已收到过 bridge 的首次同步
  // Local companion protocol, 2026-10-11. Original implementation: MIT / ckckh2023.
  const COMPANION = 'ELT_VMIC_COMPANION_1';
  let companionActive = false, companionEpoch = 0, companionBinding = '';
  let recorderHooked = false, activeAttempt = null, recordingPhase = 'empty', recordingError = '';
  let lastSentSeconds = 0, lastTruncated = false, tailUntil = 0;
  const virtualTracks = new Set(), consumerContexts = new Set();
  const playedExamples = [];
  // Some textbook speakers create detached new Audio() objects, so a DOM-only
  // scan cannot see them. Remember the actual source when the site plays it.
  const mediaPrototype = window.HTMLMediaElement?.prototype;
  if (mediaPrototype?.play) {
    const originalPlay = mediaPrototype.play;
    mediaPrototype.play = function (...args) {
      try {
        const url = new URL(this.currentSrc || this.src, location.href);
        if ((url.protocol === 'https:' || (url.protocol === 'blob:' && url.origin === location.origin))
            && !/\bding\.(mp3|wav)(?:[?#]|$)/i.test(url.href) && !url.username && !url.password) {
          const contentId = this.closest?.('[data-content-id]')?.getAttribute('data-content-id') || null;
          const old = playedExamples.findIndex(x => x.url === url.href);
          if (old >= 0) playedExamples.splice(old, 1);
          playedExamples.unshift({ url: url.href, at: Date.now(), contentId,
            label: '最近播放 · ' + decodeURIComponent(url.pathname.split('/').pop()).slice(0, 70) });
          playedExamples.splice(12);
        }
      } catch (_) {}
      return originalPlay.apply(this, args);
    };
  }

  let recSrc = null;
  let recDest = null;
  let recGain = null;
  let monGain = null;
  let recDestTrackId = null;   // 伪流 audio track 的 id

  // 噪音覆盖
  let noiseSrc = null;
  let noiseGain = null;
  const noiseBuffers = {};
  let noiseLoaded = false;
  let noiseLoadRequested = false;

  const clampVol = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  const clampRate = (v) => Math.min(4, Math.max(0.25, Number(v) || 1));

  // ---------- 调试日志 ----------
  function dbgSnapshot() {
    const track = recDest && recDest.stream && recDest.stream.getAudioTracks()[0];
    return {
      ctx: ctx ? ctx.state : 'null',
      hasBuf: !!audioBuffer,
      mode: state.mode,
      enabled: state.enabled,
      loop: state.loop,
      recSrc: recSrc ? { started: !!recSrc.__started, stopping: !!recSrc.__stopping } : null,
      recDest: !!recDest,
      recGain: !!recGain,
      monGain: !!monGain,
      noiseSrc: noiseSrc ? { started: !!noiseSrc.__started } : null,
      trackState: track ? track.readyState : 'none'
    };
  }
  function dbg(tag, extra) {
    const t = ((performance.now() % 100000) / 1000).toFixed(2);
    console.log('[VMIC DBG] t=' + t + 's ' + tag, dbgSnapshot(), extra || '');
  }

  // ---------- AudioContext 生命周期 ----------
  function ensureCtx() {
    if (!ctx) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
      } catch (e) {
        console.error('[VMIC] 创建 AudioContext 失败:', e);
        return null;
      }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function hookGestures() {
    const resume = () => { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); };
    document.addEventListener('pointerdown', resume, true);
    document.addEventListener('keydown', resume, true);
  }

  // ---------- 与 isolated 世界通信 ----------
  function postToBridge(d) {
    window.postMessage({ __vmic: TOKEN, to: 'bridge', ...d }, location.origin);
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || e.origin !== location.origin) return;
    if (d?.__eltVmic === COMPANION && d.direction === 'request') {
      handleCompanion(d).then(result => replyCompanion(d, true, result))
        .catch(error => replyCompanion(d, false, null, error.message));
      return;
    }
    if (!d || d.__vmic !== TOKEN || d.to !== 'main') return;
    if (companionActive) return; // Popup/library sync must not replace the selected question's audio.
    if (d.kind === 'state' && d.state) { applyState(d.state); everSynced = true; maybeLoadNoises(); }
    if (d.kind === 'audio' && d.audio !== undefined) { setAudioData(d.audio); everSynced = true; maybeLoadNoises(); }
    if (d.kind === 'noise' && d.name && d.audio !== undefined) setNoiseData(d.name, d.audio);
    if (d.kind === 'sync') {
      if (d.clearAudio) { clearAudio(); everSynced = true; }
      if (d.state) { applyState(d.state); everSynced = true; }
      if (d.audio !== undefined) { setAudioData(d.audio); everSynced = true; }
      if (d.transport) doTransport(d.transport);
      maybeLoadNoises();
    }
  });

  function replyCompanion(request, ok, result, error) {
    window.postMessage({ __eltVmic: COMPANION, direction: 'reply', requestId: request.requestId, ok, result, error }, location.origin);
  }
  function companionStatus() {
    const duration = audioBuffer?.duration || 0;
    const sent = recSrc?.__started ? Math.max(0, Math.min(duration,
      (ctx.currentTime - recSrc.__startTime) * clampRate(state.playbackRate))) : lastSentSeconds;
    return { version: '1.2.9', enabled: state.enabled, ready: !!audioBuffer && decodeDone,
      duration, binding: companionBinding, recorderHooked,
      phase: recordingPhase === 'finished' && ctx.currentTime < tailUntil ? 'draining' : recordingPhase,
      sentSeconds: sent, remainingSeconds: Math.max(0, duration - sent),
      truncated: lastTruncated, error: recordingError };
  }
  function normalizeBinding(raw) {
    // v1.2.0 userscripts used report keys (catalog/content). Accept them so the
    // extension can be updated independently; keep colon as the wire contract.
    const match = typeof raw === 'string' && raw.match(/^([1-9]\d*)[:/]([1-9]\d*)$/);
    if (!match) throw new Error('缺少有效题组绑定信息，请打开具体录音题后重新扫描音频');
    return match[1] + ':' + match[2];
  }
  async function handleCompanion(request) {
    if (typeof request.requestId !== 'string' || request.requestId.length > 100) throw new Error('Invalid request ID');
    if (request.action === 'status') return companionStatus();
    if (request.action === 'examples') {
      const contentId = normalizeBinding(request.binding).split(':')[1];
      return playedExamples.filter(x => Date.now() - x.at < 180000 && (!x.contentId || x.contentId === contentId))
        .map(x => ({ url: x.url, label: x.label }));
    }
    if (!['prepare', 'clear', 'release'].includes(request.action)) throw new Error('Unsupported VMIC action');
    const epoch = ++companionEpoch;
    companionActive = request.action !== 'release';
    clearAudio(companionActive); companionBinding = ''; everSynced = true;
    applyState({ enabled: companionActive, monitor: false, noiseOn: false, loop: false, mode: 'auto', volume: 1, playbackRate: 1, delayMs: 800 });
    if (request.action !== 'prepare') return companionStatus();
    const buf = request.buffer;
    if (!(buf instanceof ArrayBuffer) || !buf.byteLength || buf.byteLength > 20 * 1024 * 1024) throw new Error('音频为空或超过 20 MB');
    const binding = normalizeBinding(request.binding);
    audioRaw = buf; decodeDone = false;
    try {
      const c = ensureCtx();
      if (!c) throw new Error('浏览器无法创建 AudioContext');
      const decoded = await c.decodeAudioData(buf.slice(0));
      if (companionEpoch !== epoch) throw new Error('音频准备已取消或题组已切换');
      if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) throw new Error('示范音频解码后为空');
      audioBuffer = decoded; decodeDone = true; companionBinding = binding;
      recordingPhase = 'ready';
      return companionStatus();
    } catch (error) {
      if (companionEpoch === epoch) clearAudio(companionActive);
      throw error;
    }
  }

  function applyState(patch) {
    const prev = { ...state };
    Object.assign(state, patch || {});
    dbg('applyState', { patch });
    if (state.enabled === false && prev.enabled === true) stopRec();
    if (state.playbackRate !== prev.playbackRate && recSrc) {
      recSrc.playbackRate.value = clampRate(state.playbackRate);
    }
    applyVolume();
  }

  function clearAudio(preserveStream = false) {
    // Html5Recorder caches its input stream across questions. Stop the source,
    // but keep a silent, live virtual track until explicit release/disposal.
    cancelAttempt();
    if (preserveStream) stopSrcOnly(); else stopRec();
    audioRaw = null;
    audioBuffer = null;
    decodeDone = true;
    state.audioSig = '';
    recordingPhase = 'empty'; recordingError = ''; lastSentSeconds = 0; lastTruncated = false; tailUntil = 0;
  }

  // ---------- 输入模块 ----------
  async function hashBuf(buf) {
    try {
      const h = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(h)).slice(0, 8)
        .map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      console.warn('[VMIC] SHA-256 不可用，退化为不去重(仍安全):', e);
      return null;
    }
  }

  async function setAudioData(b64) {
    if (companionActive) return;
    let buf = null;
    if (typeof b64 === 'string' && b64) {
      try {
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        buf = u8.buffer;
      } catch (e) {
        console.warn('[VMIC] base64 解码失败:', e);
      }
    }
    if (!buf || !buf.byteLength) {
      if (audioRaw) {
        console.warn('[VMIC] 收到空/非法音频数据, 已忽略并保留当前文件源');
        return;
      }
      audioRaw = null;
      audioBuffer = null;
      decodeDone = true;
      return;
    }
    const sig = await hashBuf(buf);
    if (companionActive) return; // A library sync may already have been hashing when prepare began.
    if (audioRaw && sig && sig === state.audioSig) return;
    state.audioSig = sig || '';

    audioRaw = buf;
    audioBuffer = null;
    decodeDone = false;
    try {
      const c = ensureCtx();
      if (!c) { decodeDone = true; return; }
      const snapshot = buf;
      c.decodeAudioData(buf.slice(0)).then((ab) => {
        if (audioRaw === snapshot) { audioBuffer = ab; decodeDone = true; dbg('decode OK', { dur: ab.duration, ch: ab.numberOfChannels }); }
      }).catch((e) => {
        console.error('[VMIC] 音频解码失败(请换 mp3/wav):', e);
        decodeDone = true;
      });
    } catch (e) {
      console.error('[VMIC] 解码流程异常:', e);
      decodeDone = true;
    }
  }

  // ---------- 噪音加载 ----------
  function maybeLoadNoises() {
    if (noiseLoadRequested || !everSynced) return;
    noiseLoadRequested = true;
    dbg('maybeLoadNoises: requesting', { names: NOISE_NAMES });
    for (const name of NOISE_NAMES) postToBridge({ kind: 'getNoise', name });
  }

  async function setNoiseData(name, b64) {
    if (noiseBuffers[name]) return;
    let buf = null;
    if (typeof b64 === 'string' && b64) {
      try {
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        buf = u8.buffer;
      } catch (e) {
        console.warn('[VMIC] 噪音 base64 解码失败 ' + name + ':', e);
        return;
      }
    }
    if (!buf || !buf.byteLength) { dbg('setNoiseData empty', { name }); return; }
    try {
      const c = ensureCtx();
      if (!c) return;
      const ab = await c.decodeAudioData(buf.slice(0));
      noiseBuffers[name] = ab;
      if (NOISE_NAMES.every((n) => noiseBuffers[n])) { noiseLoaded = true; dbg('noiseLoaded ALL'); }
      else { dbg('noise decoded one', { name, loaded: Object.keys(noiseBuffers) }); }
    } catch (e) {
      console.warn('[VMIC] 噪音解码失败 ' + name + ':', e);
    }
  }

  // ---------- 处理模块 ----------
  function stopRec() {
    cancelAttempt();
    dbg('stopRec begin');
    if (recSrc) {
      recSrc.__stopping = true; // 标记手动停止
      try { if (recSrc.__started) recSrc.stop(); } catch (e) { console.warn('[VMIC] recSrc.stop:', e); }
      try { recSrc.disconnect(); } catch (e) { console.warn('[VMIC] recSrc.disconnect:', e); }
      recSrc = null;
    }
    if (recGain) { try { recGain.disconnect(); } catch (e) { console.warn('[VMIC] recGain.disconnect:', e); } recGain = null; }
    if (monGain) { try { monGain.disconnect(); } catch (e) { console.warn('[VMIC] monGain.disconnect:', e); } monGain = null; }
    if (noiseSrc) {
      try { if (noiseSrc.__started) noiseSrc.stop(); } catch (e) { console.warn('[VMIC] noiseSrc.stop:', e); }
      try { noiseSrc.disconnect(); } catch (e) { console.warn('[VMIC] noiseSrc.disconnect:', e); }
      noiseSrc = null;
    }
    if (noiseGain) { try { noiseGain.disconnect(); } catch (e) { console.warn('[VMIC] noiseGain.disconnect:', e); } noiseGain = null; }
    if (recDest) {
      for (const track of recDest.stream.getTracks()) { try { track.stop(); } catch (_) {} }
      try { recDest.disconnect(); } catch (e) { console.warn('[VMIC] recDest.disconnect:', e); } recDest = null;
    }
    for (const track of virtualTracks) { try { track.stop(); } catch (_) {} }
    virtualTracks.clear(); consumerContexts.clear();
    recDestTrackId = null;
  }

  function stopSrcOnly() {
    dbg('stopSrcOnly begin');
    if (recSrc) {
      recSrc.__stopping = true;
      try { if (recSrc.__started) recSrc.stop(); } catch (e) { console.warn('[VMIC] recSrc.stop:', e); }
      try { recSrc.disconnect(); } catch (e) { console.warn('[VMIC] recSrc.disconnect:', e); }
      recSrc = null;
    }
    if (noiseSrc) {
      try { if (noiseSrc.__started) noiseSrc.stop(); } catch (e) { console.warn('[VMIC] noiseSrc.stop:', e); }
      try { noiseSrc.disconnect(); } catch (e) { console.warn('[VMIC] noiseSrc.disconnect:', e); }
      noiseSrc = null;
    }
  }

  function startRecGraph() {
    stopRec();
    const c = ensureCtx();
    if (!c || !audioBuffer) return null;

    recDest = c.createMediaStreamDestination();
    try { recDestTrackId = recDest.stream.getAudioTracks()[0].id; } catch (e) { recDestTrackId = null; }
    for (const track of recDest.stream.getAudioTracks()) virtualTracks.add(track);
    recGain = c.createGain();
    recGain.gain.value = clampVol(state.volume);
    recGain.connect(recDest);

    monGain = c.createGain();
    monGain.gain.value = state.monitor ? clampVol(state.volume) : 0;
    monGain.connect(c.destination);

    recSrc = c.createBufferSource();
    recSrc.buffer = audioBuffer;
    recSrc.loop = !!state.loop;
    recSrc.playbackRate.value = clampRate(state.playbackRate);
    recSrc.__started = false;
    recSrc.__stopping = false;
    recSrc.connect(recGain);
    recSrc.connect(monGain);

    const src = recSrc;
    recSrc.onended = () => {
      dbg('onended fired', { stopping: !!src.__stopping, isCurrent: recSrc === src });
      if (src.__stopping) return;
      try { src.disconnect(); } catch (e) {}
      if (recSrc === src) { recSrc = null; lastSentSeconds = audioBuffer?.duration || 0; tailUntil = ctx.currentTime + 0.3; recordingPhase = 'finished'; }
      if (noiseSrc) {
        try { if (noiseSrc.__started) noiseSrc.stop(); } catch (e) {}
        try { noiseSrc.disconnect(); } catch (e) {}
        noiseSrc = null;
      }
      dbg('onended natural-end cleanup done');
    };

    // 噪音覆盖
    dbg('noise check', { noiseOn: state.noiseOn, noiseLoaded, loadedKeys: Object.keys(noiseBuffers) });
    if (state.noiseOn && noiseLoaded) {
      const noiseName = state.noiseRandom
        ? NOISE_NAMES[Math.floor(Math.random() * NOISE_NAMES.length)]
        : (NOISE_NAMES.includes(state.noiseId) ? state.noiseId : NOISE_NAMES[0]);
      const nb = noiseBuffers[noiseName];
      if (nb) {
        noiseGain = c.createGain();
        noiseGain.gain.value = clampVol(state.noiseVol);
        noiseGain.connect(recDest);
        noiseSrc = c.createBufferSource();
        noiseSrc.buffer = nb;
        noiseSrc.loop = true;
        noiseSrc.connect(noiseGain);
        noiseSrc.__started = false;
        dbg('noise src created', { name: noiseName, vol: state.noiseVol });
      }
    }

    dbg('startRecGraph done');
    return { src: recSrc, dest: recDest };
  }

  function ensureRecSrc() {
    if (recSrc) { dbg('ensureRecSrc skip: recSrc exists'); return true; }
    if (!ctx || !audioBuffer || !recGain || !monGain) { dbg('ensureRecSrc fail: missing deps', { ctx: !!ctx, buf: !!audioBuffer, rg: !!recGain, mg: !!monGain }); return false; }
    recSrc = ctx.createBufferSource();
    recSrc.buffer = audioBuffer;
    recSrc.loop = !!state.loop;
    recSrc.playbackRate.value = clampRate(state.playbackRate);
    recSrc.__started = false;
    recSrc.__stopping = false;
    recSrc.connect(recGain);
    recSrc.connect(monGain);
    const src = recSrc;
    recSrc.onended = () => {
      dbg('onended(ensure) fired', { stopping: !!src.__stopping, isCurrent: recSrc === src });
      if (src.__stopping) return;
      try { src.disconnect(); } catch (e) {}
      if (recSrc === src) { recSrc = null; lastSentSeconds = audioBuffer?.duration || 0; tailUntil = ctx.currentTime + 0.3; recordingPhase = 'finished'; }
      if (noiseSrc) {
        try { if (noiseSrc.__started) noiseSrc.stop(); } catch (e) {}
        try { noiseSrc.disconnect(); } catch (e) {}
        noiseSrc = null;
      }
      dbg('onended(ensure) natural-end cleanup done');
    };

    if (state.noiseOn && noiseLoaded && !noiseSrc && recDest) {
      const noiseName = state.noiseRandom
        ? NOISE_NAMES[Math.floor(Math.random() * NOISE_NAMES.length)]
        : (NOISE_NAMES.includes(state.noiseId) ? state.noiseId : NOISE_NAMES[0]);
      const nb = noiseBuffers[noiseName];
      if (nb) {
        if (!noiseGain) {
          noiseGain = ctx.createGain();
          noiseGain.gain.value = clampVol(state.noiseVol);
          noiseGain.connect(recDest);
        }
        noiseSrc = ctx.createBufferSource();
        noiseSrc.buffer = nb;
        noiseSrc.loop = true;
        noiseSrc.connect(noiseGain);
        noiseSrc.__started = false;
        dbg('noise src re-created in ensureRecSrc', { name: noiseName });
      }
    }

    dbg('ensureRecSrc done');
    return true;
  }

  function playNow(delayMs) {
    const c = ctx;
    if (!c || !recSrc || recSrc.__started) { dbg('playNow FAIL', { reason: !c ? 'no ctx' : (!recSrc ? 'no recSrc' : 'already started'), delayMs }); return false; }
    const t = c.currentTime + (Math.max(0, Number(delayMs) || 0)) / 1000;
    try {
      recSrc.start(t);
      recSrc.__started = true;
      recSrc.__startTime = t;
      if (noiseSrc && !noiseSrc.__started) {
        try { noiseSrc.start(t); noiseSrc.__started = true; }
        catch (e) { console.warn('[VMIC] 噪音启动失败:', e); }
      }
      dbg('playNow OK', { delayMs });
      return true;
    } catch (e) {
      console.error('[VMIC] 播放启动失败:', e);
      dbg('playNow EXCEPTION', { msg: e.message });
      return false;
    }
  }

  function applyVolume() {
    const v = clampVol(state.volume);
    if (recGain) recGain.gain.value = v;
    if (monGain) monGain.gain.value = state.monitor ? v : 0;
  }

  function cancelAttempt(attempt = activeAttempt) {
    if (!attempt || activeAttempt !== attempt) return;
    lastSentSeconds = companionStatus().sentSeconds;
    lastTruncated = !!attempt.started && !!audioBuffer && lastSentSeconds < audioBuffer.duration - 0.1;
    activeAttempt = null;
    stopSrcOnly();
    if (recordingPhase === 'finished') { recordingPhase = 'completed'; tailUntil = 0; }
    else if (recordingPhase !== 'empty' && recordingPhase !== 'blocked') recordingPhase = 'stopped';
  }

  function liveGraph() {
    return recDest && recDest.stream.getAudioTracks().some(track => track.readyState === 'live');
  }

  async function beginAttempt(attempt, recorder) {
    if (activeAttempt !== attempt || attempt.epoch !== companionEpoch || attempt.started) return;
    attempt.started = true;
    await Promise.resolve();
    try {
      // onStart occurs after the SDK's ding and before its worker reset. Resume
      // both contexts, then start on the next turn with a short capture lead-in.
      const contexts = new Set([ensureCtx(), recorder.context]);
      for (const c of contexts) {
        if (!c) continue;
        if (c.state === 'suspended') await c.resume();
        if (c.state !== 'running') throw new Error('录音音频上下文未运行，请点击页面后重录');
      }
      if (activeAttempt !== attempt || attempt.epoch !== companionEpoch || !state.enabled
          || audioBuffer !== attempt.buffer) return;
      if (!liveGraph() || !consumerContexts.has(recorder.context)) throw new Error('网站尚未连接虚拟麦克风，请刷新课程页，先载入音频再点击麦克风');
      stopSrcOnly();
      if (!ensureRecSrc() || !playNow(150)) throw new Error('示范音频未能开始送入，请重新载入后重录');
      recordingPhase = 'playing'; recordingError = ''; lastSentSeconds = 0;
    } catch (error) {
      if (activeAttempt === attempt) { recordingPhase = 'blocked'; recordingError = error.message; stopSrcOnly(); }
    }
  }

  // Chivox 6.1.3 calls record({onStart}) only when capture actually starts.
  // GUM, createMediaStreamSource and WebSocket construction are initialization
  // events and must never consume a one-shot sample. Preserve SDK callbacks and
  // arguments; do not inspect or change any assessment/signature/score payload.
  const wrappedRecorders = new WeakSet();
  function hookRecorder(Recorder) {
    const proto = Recorder?.prototype;
    if (!proto || typeof proto.record !== 'function' || wrappedRecorders.has(proto)) return;
    const original = proto.record;
    proto.record = function (params, ...args) {
      if (!state.enabled || state.mode !== 'auto') return original.call(this, params, ...args);
      if (!audioBuffer || !decodeDone) throw new DOMException('请先载入本题的有效示范音频', 'NotFoundError');
      cancelAttempt();
      const attempt = { epoch: companionEpoch, buffer: audioBuffer, started: false };
      activeAttempt = attempt; recordingPhase = 'waiting'; recordingError = ''; lastSentSeconds = 0; lastTruncated = false; tailUntil = 0;
      const recorder = this, next = { ...params };
      next.onStart = function (...values) {
        void beginAttempt(attempt, recorder);
        return params?.onStart?.apply(this, values);
      };
      for (const name of ['onStop', 'onScoreError']) {
        next[name] = function (...values) { cancelAttempt(attempt); return params?.[name]?.apply(this, values); };
      }
      try { return original.call(this, next, ...args); }
      catch (error) { cancelAttempt(attempt); throw error; }
    };
    wrappedRecorders.add(proto); recorderHooked = true;
  }
  // MAIN is injected at document_start; the site's deferred SDK assigns this
  // public constructor later. Keep the constructor's identity and statics.
  const recorderDescriptor = Object.getOwnPropertyDescriptor(window, 'Html5Recorder');
  if (!recorderDescriptor || (recorderDescriptor.configurable && 'value' in recorderDescriptor)) {
    let Recorder = window.Html5Recorder;
    hookRecorder(Recorder);
    Object.defineProperty(window, 'Html5Recorder', {
      configurable: true, enumerable: recorderDescriptor?.enumerable ?? true,
      get: () => Recorder, set(value) { Recorder = value; hookRecorder(value); }
    });
  } else {
    hookRecorder(window.Html5Recorder);
    document.addEventListener('load', () => hookRecorder(window.Html5Recorder), true);
  }

  // ---------- 输出模块 ----------
  const md = navigator.mediaDevices;
  const origGUM = md && md.getUserMedia ? md.getUserMedia.bind(md) : null;
  const origEnum = md && md.enumerateDevices ? md.enumerateDevices.bind(md) : null;
  const wantsAudio = (c) => !!(c && (c.audio === true || (c.audio && typeof c.audio === 'object')));
  const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

  async function ensureReady() {
    if (!everSynced) postToBridge({ kind: 'hello' });
    for (let i = 0; i < 80; i++) {
      if (everSynced && (audioRaw === null || decodeDone)) return;
      await waitMs(50);
    }
  }

  if (origGUM && md) {
    md.getUserMedia = async function (constraints) {
      const wantAudio = state.enabled && wantsAudio(constraints);
      dbg('getUserMedia called', { wantAudio, constraints });
      if (!wantAudio) return origGUM(constraints);

      await ensureReady();
      if (!state.enabled) { dbg('getUserMedia disabled after wait'); return origGUM(constraints); }

      let stream = null;
      try {
        if (audioBuffer) {
          if (!liveGraph()) startRecGraph();
          if (recDest) {
            // Permission probes often stop their returned stream. A cloned
            // track isolates those probes from the SDK's cached recording input.
            stream = recDest.stream.clone();
            for (const track of stream.getAudioTracks()) virtualTracks.add(track);
          }
        }
        if (!stream) throw new DOMException('请先载入本题的有效示范音频', 'NotFoundError');
        if (ctx.state === 'suspended') await ctx.resume();
        if (ctx.state !== 'running') throw new DOMException('请点击页面后重新开始录音', 'NotAllowedError');

        const wantVideo = !!(constraints && (constraints.video === true ||
          (constraints.video && typeof constraints.video === 'object')));
        if (wantVideo) {
          const v = await origGUM({ video: constraints.video });
          return new MediaStream([...v.getVideoTracks(), stream.getAudioTracks()[0]]);
        }
        dbg('getUserMedia return stream');
        return stream;
      } catch (e) {
        console.error('[VMIC] 音频流创建失败，已停止:', e);
        stopRec();
        throw e;
      }
    };
  }

  // 启用时隐藏真麦
  if (origEnum && md) {
    md.enumerateDevices = async function () {
      let devs;
      try { devs = await origEnum(); } catch (e) { console.warn('[VMIC] enumerateDevices 首次失败，重试:', e); return origEnum(); }
      if (!state.enabled) return devs;
      const out = devs.filter((d) => d.kind !== 'audioinput');
      out.push({
        deviceId: 'vmic-local-audio',
        kind: 'audioinput',
        label: '本地音频 (VMIC)',
        groupId: 'vmic-group'
      });
      return out;
    };
  }

  const ACProto = (window.AudioContext || window.webkitAudioContext);
  if (ACProto && ACProto.prototype && ACProto.prototype.createMediaStreamSource) {
    const origCreateMSS = ACProto.prototype.createMediaStreamSource;
    ACProto.prototype.createMediaStreamSource = function (stream) {
      const result = origCreateMSS.call(this, stream);
      try {
        const tracks = stream && stream.getAudioTracks ? stream.getAudioTracks() : [];
        if (tracks.some(track => virtualTracks.has(track))) {
          dbg('createMediaStreamSource on our stream', { mode: state.mode, enabled: state.enabled });
          consumerContexts.add(this);
        }
      } catch (e) { console.warn('[VMIC] createMediaStreamSource 包装异常:', e); }
      return result;
    };
  }

  // ---------- popup 控制 ----------
  function doTransport(op) {
    if (!op) return;
    dbg('doTransport', { action: op.action, value: op.value });
    const c = ensureCtx();
    switch (op.action) {
      case 'play': {
        if (c && c.state === 'suspended') c.resume().catch(() => {});
        if (!recDest) { dbg('play: no recDest -> startRecGraph'); startRecGraph(); }
        else if (!recSrc) { dbg('play: recDest alive, no recSrc -> ensureRecSrc'); ensureRecSrc(); }
        else { dbg('play: both exist -> playNow only'); }
        playNow(0);
        break;
      }
      case 'pause':
        stopSrcOnly();
        break;
      case 'restart':
        if (c && c.state === 'suspended') c.resume().catch(() => {});
        if (audioBuffer) {
          if (recDest) {
            dbg('restart: recDest alive -> rebuild src only');
            if (recSrc) {
              recSrc.__stopping = true;
              try { if (recSrc.__started) recSrc.stop(); } catch (e) {}
              try { recSrc.disconnect(); } catch (e) {}
              recSrc = null;
            }
            ensureRecSrc();
          } else {
            dbg('restart: no recDest -> startRecGraph');
            startRecGraph();
          }
          playNow(0);
        }
        break;
      case 'volume':
        state.volume = clampVol(op.value);
        applyVolume();
        break;
      case 'monitor':
        state.monitor = !!op.value;
        applyVolume();
        break;
      case 'loop':
        state.loop = !!op.value;
        if (recSrc) recSrc.loop = state.loop;
        break;
      case 'playbackRate':
        state.playbackRate = clampRate(op.value);
        if (recSrc) recSrc.playbackRate.value = state.playbackRate;
        break;
      case 'noiseVol':
        state.noiseVol = clampVol(op.value);
        if (noiseGain) noiseGain.gain.value = state.noiseVol;
        break;
    }
  }

  hookGestures();
  postToBridge({ kind: 'hello' });
})();
