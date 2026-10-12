const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const core = require('../tsinghuaelt-new.user.js');
const source = fs.readFileSync(path.join(__dirname, '../vmic-extension/content/content-main.js'), 'utf8');
const practiceSource = fs.readFileSync(path.join(__dirname, '../tsinghuaelt-new.user.js'), 'utf8');

function fixture() {
    const listeners = new Map(), realCalls = [], sources = [], tracks = [], contexts = [];
    let deferred = null, hashDeferred = null, nextTrack = 1;
    const track = prefix => { const t = { id: prefix + nextTrack++, readyState: 'live', stop() { this.readyState = 'ended'; } }; tracks.push(t); return t; };
    const stream = t => ({ getAudioTracks: () => [t], getTracks: () => [t], clone: () => stream(track('clone-')) });
    const node = extra => ({ connect() {}, disconnect() {}, ...extra });
    class AudioContext {
        constructor() { this.state = 'running'; this.currentTime = 0; this.destination = node(); contexts.push(this); }
        async resume() { this.state = 'running'; }
        decodeAudioData(buffer) { return deferred ? deferred(buffer) : Promise.resolve({ duration: 2, numberOfChannels: 1, input: buffer }); }
        createMediaStreamDestination() { return node({ stream: stream(track('virtual-')) }); }
        createGain() { return node({ gain: { value: 1 } }); }
        createBufferSource() { const src = node({ playbackRate: { value: 1 }, start(time) { this.started = true; this.startTime = time; }, stop() { this.stopped = true; } }); sources.push(src); return src; }
        createMediaStreamSource() { return node(); }
    }
    class WebSocket { constructor(url) { this.url = url; } }
    class HTMLMediaElement { constructor(src) { this.src = src; } play() { this.played = true; return Promise.resolve(); } }
    Object.assign(WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    const location = { origin: 'https://www.tsinghuaelt.com', href: 'https://www.tsinghuaelt.com/course_center/reader/student_course/100?catalogId=10&contentId=14' };
    const win = { location, AudioContext, WebSocket, HTMLMediaElement,
        addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
        removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
        postMessage(data, origin) { assert.equal(origin, location.origin);
            queueMicrotask(() => { for (const fn of [...listeners.get('message') || []]) fn({ data, source: win, origin }); }); }
    };
    const md = { async getUserMedia(c) { realCalls.push(c); return stream(track('real-')); },
        async enumerateDevices() { return [{ kind: 'audioinput', deviceId: 'real' }]; } };
    vm.runInNewContext(source, { window: win, location, navigator: { mediaDevices: md }, document: { addEventListener() {} },
        console: { log() {}, warn() {}, error() {} },
        crypto: { subtle: { digest: (...args) => hashDeferred ? hashDeferred(...args) : webcrypto.subtle.digest(...args) } }, performance: { now: () => 0 },
        setTimeout, clearTimeout, ArrayBuffer, Uint8Array, URL, DOMException, atob, btoa, MediaStream: class {} });
    return { win, md, realCalls, sources, tracks, contexts, setDeferred(value) { deferred = value; },
        setHashDeferred(value) { hashDeferred = value; },
        advance(seconds) { for (const context of contexts) context.currentTime += seconds; },
        recorder(input) {
            class Recorder {
                constructor() { this.context = new win.AudioContext(); this.context.createMediaStreamSource(input); }
                record(params) { this.params = params; this.recordThis = this; return 'sdk-return'; }
                start() { this.params.onStart.call(this, 'started'); }
                stop() { this.params.onStop.call(this, 'stopped'); }
            }
            win.Html5Recorder = Recorder; // exercise the deferred SDK assignment hook
            return new Recorder();
        },
        request: (action, payload = {}, signal, timeout) => core.vmicRequest(win, action, payload, signal, timeout),
        foreign(data) { for (const fn of listeners.get('message') || []) fn({ data, source: {}, origin: 'https://evil.example' }); },
        get listenerCount() { return listeners.get('message')?.size; }
    };
}

test('actual VMIC defaults to real microphone; enabled-without-audio refuses silent or real fallback', async () => {
    const f = fixture();
    assert.equal((await f.request('status')).enabled, false);
    await f.md.getUserMedia({ audio: true }); assert.equal(f.realCalls.length, 1);
    await f.request('clear');
    await assert.rejects(f.md.getUserMedia({ audio: true }), { name: 'NotFoundError' });
    assert.equal(f.realCalls.length, 1); assert.equal(f.sources.length, 0);
});

test('actual VMIC prepares decoded audio, exposes a virtual stream, ignores library overwrite and unrelated sockets', async () => {
    const f = fixture(), result = await f.request('prepare', { buffer: new Uint8Array([1, 2, 3]).buffer, binding: '10:14' });
    assert.equal(result.ready, true); assert.equal(result.duration, 2); assert.equal(result.binding, '10:14');
    f.win.postMessage({ __vmic: 'VMIC_TSINGHUAELT_01', to: 'main', kind: 'sync', state: { enabled: false }, audio: null }, f.win.location.origin);
    assert.equal((await f.request('status')).ready, true);
    const stream = await f.md.getUserMedia({ audio: true });
    assert.match(stream.getAudioTracks()[0].id, /^clone-/); assert.equal(f.realCalls.length, 0);
    assert.equal(f.sources[0].started, undefined); assert.equal(f.sources[0].loop, false);
    new f.win.WebSocket('wss://example.org/notifications'); assert.equal(f.sources.length, 1);
    new f.win.WebSocket('wss://cloud.chivox.com/ws'); assert.equal(f.sources.length, 1);
    await f.request('clear'); assert.equal(stream.getAudioTracks()[0].readyState, 'live');
    assert.equal((await f.request('status')).ready, false);
    await f.request('release'); assert.equal(stream.getAudioTracks()[0].readyState, 'ended');
    await f.md.getUserMedia({ audio: true }); assert.equal(f.realCalls.length, 1);
});

test('clear during async decoding invalidates the old audio and foreign-frame commands are ignored', async () => {
    const f = fixture(); let finish;
    f.setDeferred(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.request('prepare', { buffer: new Uint8Array([1]).buffer, binding: '10:14' });
    await new Promise(setImmediate);
    await f.request('clear'); finish({ duration: 5 });
    await assert.rejects(pending, /已取消/);
    f.foreign({ __eltVmic: 'ELT_VMIC_COMPANION_1', direction: 'request', requestId: 'foreign', action: 'release' });
    const status = await f.request('status'); assert.equal(status.enabled, true); assert.equal(status.ready, false);
});

test('prepare cancellation clears pending decode and removes RPC listeners', async () => {
    const f = fixture(); let finish;
    f.setDeferred(() => new Promise(resolve => { finish = resolve; }));
    const initial = f.listenerCount, ctrl = new AbortController();
    const pending = f.request('prepare', { buffer: new Uint8Array([1]).buffer, binding: '10:14' }, ctrl.signal);
    await new Promise(setImmediate); ctrl.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    finish({ duration: 5 }); await new Promise(setImmediate);
    assert.equal((await f.request('status')).ready, false); assert.equal(f.listenerCount, initial);
});

test('invalid or undecodable audio leaves no previous audio ready', async () => {
    const f = fixture();
    await f.request('prepare', { buffer: new Uint8Array([1]).buffer, binding: '10:14' });
    f.setDeferred(async () => { throw new Error('invalid audio'); });
    await assert.rejects(f.request('prepare', { buffer: new Uint8Array([2]).buffer, binding: '10:15' }), /invalid audio/);
    assert.equal((await f.request('status')).ready, false);
    await assert.rejects(f.md.getUserMedia({ audio: true }), { name: 'NotFoundError' });
    assert.equal(f.realCalls.length, 0);
});

test('extension manifest references existing assets and injects MAIN at document_start only on the requested site', () => {
    const base = path.join(__dirname, '../vmic-extension'), manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json')));
    assert.equal(manifest.manifest_version, 3);
    for (const entry of manifest.content_scripts) {
        assert.deepEqual(entry.matches, ['https://www.tsinghuaelt.com/*']);
        for (const file of entry.js) assert(fs.existsSync(path.join(base, file)));
        if (entry.js.includes('content/content-main.js')) { assert.equal(entry.world, 'MAIN'); assert.equal(entry.run_at, 'document_start'); }
    }
    for (const file of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page, ...Object.values(manifest.icons)]) {
        assert(fs.existsSync(path.join(base, file)));
    }
});

test('detached website Audio playback is discoverable without changing playback or leaking another mounted content', async () => {
    const f = fixture();
    const first = new f.win.HTMLMediaElement('https://cdn.example.org/example.mp3'); await first.play();
    const other = new f.win.HTMLMediaElement('https://cdn.example.org/other.mp3');
    other.closest = () => ({ getAttribute: () => '999' }); await other.play();
    const ding = new f.win.HTMLMediaElement('https://cdn.example.org/ding.mp3'); await ding.play();
    const found = await f.request('examples', { binding: '10:14' });
    assert.equal(first.played, true); assert.equal(found.length, 1); assert.equal(found[0].url, first.src);
    assert.equal((await f.request('status')).enabled, false);
});

test('VMIC accepts old slash bindings, normalizes both spellings, and rejects absent or invalid IDs', async () => {
    const f = fixture();
    const recent = new f.win.HTMLMediaElement('https://cdn.example.org/current.mp3');
    recent.closest = () => ({ getAttribute: () => '14' }); await recent.play();
    const old = new f.win.HTMLMediaElement('https://cdn.example.org/old.mp3');
    old.closest = () => ({ getAttribute: () => '99' }); await old.play();
    for (const binding of ['10/14', '10:14']) {
        const examples = await f.request('examples', { binding });
        assert.equal(examples.length, 1); assert.equal(examples[0].url, recent.src);
        const status = await f.request('prepare', { buffer: new Uint8Array([1]).buffer, binding });
        assert.equal(status.ready, true); assert.equal(status.binding, '10:14');
    }
    for (const binding of [undefined, null, '', '10', '0:14', '10:0', '10/null', '10:14/99', '../14', {}]) {
        await assert.rejects(f.request('prepare', { buffer: new Uint8Array([1]).buffer, binding }), /有效题组绑定/);
        assert.equal((await f.request('status')).ready, false);
    }
});

function mountPractice(f, ids) {
    const elements = new Map(), sent = [];
    const get = id => {
        if (!elements.has(id)) elements.set(id, { textContent: '', value: '', checked: false, disabled: false,
            options: [], replaceChildren() { this.options = []; }, appendChild(option) { this.options.push(option); } });
        return elements.get(id);
    };
    const root = { set innerHTML(_) {}, getElementById: get, querySelector: () => ({ hidden: false }) };
    const sampleURL = 'https://cdn.example.org/example.mp3';
    const document = { body: { appendChild() {} }, getElementById: () => null,
        createElement: () => ({ style: {}, attachShadow: () => root }), querySelector: () => null,
        querySelectorAll: selector => selector === 'audio,audio source' ? [{ src: sampleURL }] : [] };
    const location = f.win.location;
    location.href = 'https://www.tsinghuaelt.com/course_center/reader/student_course/' + ids.bizId
        + '?catalogId=' + ids.catalogId + '&contentId=' + ids.contentId;
    location.pathname = new URL(location.href).pathname;
    const win = f.win; win.top = win.self = win; win.innerHeight = 900;
    win.fetch = async url => {
        assert.equal(url, sampleURL);
        return { ok: true, headers: new Headers(), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    };
    const originalPost = win.postMessage;
    win.postMessage = (data, origin) => { sent.push(data); return originalPost(data, origin); };
    const storage = { getItem: () => null, setItem() {}, removeItem() {} };
    vm.runInNewContext(practiceSource, { window: win, document, location, localStorage: storage, sessionStorage: storage,
        URL, URLSearchParams, AbortController, DOMException, Blob, TextEncoder, Uint8Array, ArrayBuffer, setTimeout, clearTimeout, console });
    return { get, sent, sampleURL };
}

test('actual panel scan -> select -> load reaches actual VMIC with colon bindings and preserves large IDs', async () => {
    for (const ids of [{ bizId: '100', catalogId: '10', contentId: '14' },
        { bizId: '8200000000000000001', catalogId: '9007199254740992', contentId: '9007199254740993' }]) {
        const f = fixture(), page = mountPractice(f, ids);
        await page.get('audio-scan').onclick();
        assert.equal(page.get('audio-list').options.length, 2);
        page.get('audio-list').value = page.sampleURL;
        await page.get('audio-prepare').onclick();
        assert.match(page.get('audio-status').textContent, /已载入 2.0 秒/);
        const expected = ids.catalogId + ':' + ids.contentId;
        for (const action of ['examples', 'prepare']) {
            const message = page.sent.find(x => x.__eltVmic === 'ELT_VMIC_COMPANION_1' && x.action === action);
            assert(message, 'actual panel must send ' + action); assert.equal(message.binding, expected);
        }
        assert.equal((await f.request('status')).binding, expected);
        const stream = await f.md.getUserMedia({ audio: true });
        assert.match(stream.getAudioTracks()[0].id, /^clone-/); assert.equal(f.realCalls.length, 0);
        await f.request('release');
    }
});

test('SDK initialization and slow WebSocket never consume audio; actual onStart starts once after worker reset', async () => {
    const f = fixture();
    await f.request('prepare', { buffer: new Uint8Array([1]).buffer, binding: '10:14' });
    const input = await f.md.getUserMedia({ audio: true }), sdk = f.recorder(input), events = [];
    f.advance(30); // arbitrary device initialization delay
    const WebSocket = f.win.WebSocket;
    new WebSocket('wss://cloud.chivox.com/en.sent.score'); f.advance(30);
    assert.equal(f.sources.filter(x => x.started).length, 0);
    const params = { duration: 6000, serverParams: { refText: 'Hello', signature: 'unchanged' },
        onStart(value) { assert.equal(this, sdk); events.push(value); }, onStop(value) { events.push(value); } };
    assert.equal(sdk.record(params), 'sdk-return');
    assert.equal((await f.request('status')).phase, 'waiting');
    assert.equal(sdk.params.serverParams, params.serverParams);
    sdk.start(); sdk.start(); events.push('worker-reset');
    assert.equal(f.sources.filter(x => x.started).length, 0, 'onStart must return before injection');
    await new Promise(setImmediate);
    const src = f.sources.find(x => x.started);
    assert(src); assert.equal(src.startTime, 60.15); assert.equal(src.loop, false);
    assert.deepEqual(events, ['started', 'started', 'worker-reset']);
    assert.equal(f.win.WebSocket, WebSocket, 'leave networking constructor unchanged');
    f.advance(0.65);
    assert.equal((await f.request('status')).sentSeconds, 0.5);
    sdk.stop(); assert(src.stopped);
    const status = await f.request('status'); assert.equal(status.truncated, true); assert.equal(status.phase, 'stopped');
    assert.deepEqual(events, ['started', 'started', 'worker-reset', 'stopped']);
});

test('a library sync already hashing cannot overwrite a newly prepared question sample', async () => {
    const f = fixture(); let finishHash;
    f.setHashDeferred(() => new Promise(resolve => { finishHash = resolve; }));
    f.win.postMessage({ __vmic: 'VMIC_TSINGHUAELT_01', to: 'main', kind: 'audio', audio: btoa('old-library-audio') }, f.win.location.origin);
    await new Promise(setImmediate); assert(finishHash);
    await f.request('prepare', { buffer: new Uint8Array([1]).buffer, binding: '10:14' });
    f.setDeferred(() => { throw new Error('old library decoding must not run'); });
    finishHash(new Uint8Array(32).buffer); await new Promise(setImmediate);
    const status = await f.request('status'); assert.equal(status.ready, true); assert.equal(status.binding, '10:14');
    assert.equal(status.duration, 2);
});

test('cached SDK stream replays on every retry and after replacing the sample; permission probes are isolated', async () => {
    const f = fixture();
    await f.request('prepare', { buffer: new Uint8Array([1]).buffer, binding: '10:14' });
    const probe = await f.md.getUserMedia({ audio: true }); probe.getTracks()[0].stop();
    const input = await f.md.getUserMedia({ audio: true }), sdk = f.recorder(input);
    for (let n = 0; n < 3; n++) {
        if (n === 2) {
            await f.request('clear');
            assert.throws(() => sdk.record({}), { name: 'NotFoundError' });
            await f.request('prepare', { buffer: new Uint8Array([2]).buffer, binding: '10:15' });
        }
        sdk.record({}); sdk.start(); await new Promise(setImmediate);
        const src = f.sources.at(-1); assert(src.started); assert.equal(input.getTracks()[0].readyState, 'live');
        f.advance(3); src.onended();
        assert.equal((await f.request('status')).phase, 'draining'); f.advance(0.4);
        assert.equal((await f.request('status')).phase, 'finished'); sdk.stop();
        assert.equal((await f.request('status')).truncated, false);
    }
    assert.equal(f.sources.filter(x => x.started).length, 3);
    assert.equal(f.realCalls.length, 0);
    await f.request('release'); assert(f.tracks.every(x => x.readyState === 'ended'));
});

test('suspended capture context is resumed before playback and pending start cannot survive clear or release', async () => {
    for (const action of ['clear', 'release']) {
        const f = fixture();
        await f.request('prepare', { buffer: new Uint8Array([1]).buffer, binding: '10:14' });
        const sdk = f.recorder(await f.md.getUserMedia({ audio: true }));
        let resume;
        sdk.context.state = 'suspended'; sdk.context.resume = () => new Promise(resolve => { resume = () => { sdk.context.state = 'running'; resolve(); }; });
        sdk.record({}); sdk.start(); await new Promise(setImmediate);
        assert.equal(f.sources.filter(x => x.started).length, 0);
        await f.request(action); resume(); await new Promise(setImmediate);
        assert.equal(f.sources.filter(x => x.started).length, 0);
        assert.equal((await f.request('status')).ready, false);
    }
    const f = fixture();
    await f.request('prepare', { buffer: new Uint8Array([1]).buffer, binding: '10:14' });
    const sdk = f.recorder(await f.md.getUserMedia({ audio: true }));
    sdk.context.state = 'suspended'; sdk.record({}); sdk.start(); await new Promise(setImmediate);
    assert.equal(sdk.context.state, 'running'); assert(f.sources.at(-1).started);
    sdk.stop();
});

test('stop before context resume cancels injection, and a recorder still using a real stream reports the connection problem', async () => {
    const f = fixture();
    await f.request('prepare', { buffer: new Uint8Array([1]).buffer, binding: '10:14' });
    const sdk = f.recorder(await f.md.getUserMedia({ audio: true }));
    let resume;
    sdk.context.state = 'suspended'; sdk.context.resume = () => new Promise(resolve => { resume = () => { sdk.context.state = 'running'; resolve(); }; });
    sdk.record({}); sdk.start(); await new Promise(setImmediate); sdk.stop(); resume(); await new Promise(setImmediate);
    assert.equal(f.sources.filter(x => x.started).length, 0);
    const cachedReal = f.recorder({ getAudioTracks: () => [{ id: 'real-mic' }] });
    cachedReal.record({}); cachedReal.start(); await new Promise(setImmediate);
    assert.equal((await f.request('status')).phase, 'blocked');
    assert.match((await f.request('status')).error, /尚未连接虚拟麦克风/);
    assert.equal(f.sources.filter(x => x.started).length, 0);
});

test('actual panel reports audio in progress, completed playback and an early stop', async () => {
    const f = fixture(), page = mountPractice(f, { bizId: '100', catalogId: '10', contentId: '14' });
    await page.get('audio-scan').onclick(); page.get('audio-list').value = page.sampleURL;
    await page.get('audio-prepare').onclick();
    const sdk = f.recorder(await f.md.getUserMedia({ audio: true }));
    sdk.record({}); sdk.start(); await new Promise(setImmediate);
    await page.get('audio-check').onclick(); assert.match(page.get('audio-live').textContent, /正在送入.*剩余 2.0 秒/);
    f.advance(0.65); sdk.stop();
    await page.get('audio-check').onclick(); assert.match(page.get('audio-live').textContent, /提前结束.*0.5 秒/);
    sdk.record({}); sdk.start(); await new Promise(setImmediate); f.advance(3); f.sources.at(-1).onended();
    await page.get('audio-check').onclick(); assert.match(page.get('audio-live').textContent, /尾部缓冲/); f.advance(0.4);
    await page.get('audio-check').onclick(); assert.match(page.get('audio-live').textContent, /已送完/);
    sdk.stop(); await f.request('release');
});
