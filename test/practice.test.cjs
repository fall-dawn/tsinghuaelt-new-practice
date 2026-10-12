const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const core = require('../tsinghuaelt-new.user.js');

const route = { type: 'student_course', bizId: 100, catalogId: 10, contentId: 14, contentType: 2 };
const content = { id: 14, catalogId: 10, type: 14 };
const config = core.normalizeConfig();
const copy = value => JSON.parse(JSON.stringify(value));
const single = { id: 1, type: 'choice_single', extension: JSON.stringify([{ idx: 'uuid-A', val: 'A' }, { idx: 'uuid-B', val: 'B' }]) };
const fill = { id: 2, type: 'fill_base', extension: '', stem: '<span class="zty-exercise-item-fill-blank" id="blank-one" data-group-id="g1"></span><span id="blank-two" data-group-id="g2"></span>' };
const fillOfficial = [{ idx: 'blank-one', standardAnswer: 'habitat(s)', val: 'habitats; habitat' }, { idx: 'blank-two', standardAnswer: 'wild', val: 'wild' }];
const fillWire = JSON.stringify([{ idx: 'blank-one', answer: 'habitats' }, { idx: 'blank-two', answer: 'wild' }]);
const judge = { id: 3, type: 'judge_basic', extension: '' };
const multiple = { id: 4, type: 'choice_multiple', extension: [{ idx: 'multi-A' }, { idx: 'multi-B' }] };
const drag = { id: 5, type: 'matching_onetoonedrag', extension: { drag: [{ idx: 'zone-1' }, { idx: 'zone-2' }], dragged: [{ idx: 'source-A' }, { idx: 'source-B' }] } };
const matrix = { id: 6, type: 'judge_advanced', extension: {
    option: [{ idx: 'uuid-full', val: 'Full form' }, { idx: 'uuid-reduced', val: 'Reduced form' }],
    topic: [1, 2, 3, 4, 5].map(n => ({ idx: 'row-' + n, val: 'Listening sentence ' + n }))
} };
const matrixAnswer = ['uuid-reduced', 'uuid-full', 'uuid-reduced', 'uuid-full', 'uuid-reduced'];

test('VMIC uses its own colon binding without changing queue keys or rounding large IDs', () => {
    assert.equal(core.resultKey(10, 14), '10/14');
    assert.equal(core.vmicBinding(10, 14), '10:14');
    assert.equal(core.vmicBinding('9007199254740992', '9007199254740993'), '9007199254740992:9007199254740993');
    assert.throws(() => core.vmicBinding(null, 14), /具体录音题/);
    assert.throws(() => core.vmicBinding(10, Number('9007199254740993')), /具体录音题/);
});

test('subjective encoders preserve parent listening transcripts and accept text only with real blank IDs', () => {
    const essay = { id: 88, type: 'essay_questions_answers', obSub: 'sub', stem: 'Who does Mario work for?' };
    const questions = core.flattenQuestions([{ id: 90, instruction: 'Listen and answer.', attachmentList: [{ script: '<p>Mario works for a newspaper.</p>', url: 'private-url' }], children: [essay] }]);
    assert.equal(core.toWire(essay, 'A newspaper.'), '{"answer":"A newspaper.","annex":[]}');
    const packet = core.questionPacket(questions);
    assert.deepEqual(packet[0].context[0].transcripts, ['Mario works for a newspaper.']);
    assert(!JSON.stringify(packet).includes('private-url'));
    const imported = core.answersToMap({ answers: [{ questionId: 88, answer: 'A newspaper.' }] }, questions);
    assert.equal(imported.get(88), core.toWire(essay, 'A newspaper.'));
    assert.throws(() => core.answersToMap({ answers: [{ questionId: 88, answer: null }, { questionId: 88, answer: null }] }, questions), /重复/);
    assert.throws(() => core.answersToMap({ answers: [{ questionId: 999, answer: 'bad' }] }, questions), /未知/);
    assert.throws(() => core.toWire({ id: 89, type: 'fill_dialog' }, ['one']), /空位置/);
    assert.equal(core.correct({ answerStatus: -1, rightRate: 100 }), false);
});

test('a supplied subjective answer is saved once and stays pending review without a completion mark', async () => {
    const q = { id: 88, type: 'essay_questions_answers', obSub: 'sub', stem: 'Who does Mario work for?' };
    let item, posts = 0, prepared = 0;
    const client = { async request(path, options = {}) {
        if (path.includes('/echo/')) return { questionVOList: [q], questionAnswerItemVOList: item ? [item] : [] };
        assert(path.endsWith('/submit/answer')); posts++;
        item = { questionId: 88, answerStatus: -1, userAnswer: options.data.questionItemList[0].userAnswer };
    } };
    const result = await core.solveContent(client, route, content, config, { errorNumShow: 3 }, null, () => {}, {
        prepare: () => { prepared++; return core.answersToMap({ answers: [{ questionId: 88, answer: 'A newspaper.' }] }, [q]); }
    });
    assert.equal(posts, 1); assert.equal(prepared, 1); assert.equal(result.status, 'pending');
    assert.match(result.pending[0].reason, /等待教师/); assert.equal(result.correct, 0);
});

test('subjective fills retain valid saved pairs; supplied standard answers work without trial guesses', () => {
    const subjective = { ...fill, obSub: 'sub' };
    const old = { answerStatus: -1, userAnswer: fillWire };
    const saved = core.planSubmission([subjective, single], new Map([[2, old]]), true);
    assert.equal(saved.pending.length, 0); assert.equal(saved.questionItemList[0].userAnswer, fillWire);
    const official = core.planSubmission([subjective], new Map([[2, { answerStatus: -1, answer: fillOfficial }]]), false);
    assert.equal(official.questionItemList[0].userAnswer, fillWire); assert.equal(official.changed, true);
    const missing = core.planSubmission([subjective], new Map(), true);
    assert.equal(missing.questionItemList.length, 0); assert.match(missing.pending[0].reason, /主观题/);
});

test('AI sends only its configured credential and material, keeps null answers unresolved, and obeys pause', async () => {
    const q = { id: 88, type: 'essay_questions_answers', obSub: 'sub', stem: 'Who does Mario work for?' };
    let calls = 0;
    const fetchAI = async (url, init) => {
        calls++; assert.equal(url, 'https://example.org/v1/chat/completions');
        assert.equal(init.credentials, 'omit'); assert.equal(init.headers.Authorization, 'Bearer ai-test');
        assert(!Object.keys(init.headers).includes('elt-user-token'));
        const prompt = JSON.parse(init.body).messages[0].content;
        assert(prompt.includes('Do not invent listening details')); assert(prompt.includes('88'));
        return { ok: true, json: async () => ({ choices: [{ message: { content: '```json\n{"answers":[{"questionId":88,"answer":null}]}\n```' } }] }) };
    };
    const settings = { endpoint: 'https://example.org/v1/chat/completions', model: 'test-model', key: 'ai-test' };
    assert.equal((await core.requestAI(settings, [q], new Map(), fetchAI)).size, 0);
    const ctrl = new AbortController(); ctrl.abort();
    await assert.rejects(core.requestAI(settings, [q], new Map(), fetchAI, ctrl.signal), { name: 'AbortError' });
    assert.equal(calls, 1);
    await assert.rejects(core.requestAI({ ...settings, endpoint: 'http://example.org' }, [q], new Map(), fetchAI), /HTTPS/);
});

test('the exact eight S/C screenshot sentences map by label even when columns are reversed', async () => {
    const q = { id: 91, type: 'judge_advanced', extension: {
        option: [{ idx: 'customer-uuid', val: 'C' }, { idx: 'server-uuid', val: 'S' }],
        topic: ['Would you like French fries or a salad with that?', 'For the main dish, I would like cheese pizza.',
            'Do you have green tea?', 'How would you like the steak?', 'Does the omelet come with a side salad?',
            'Can I have a glass of water, please?', 'Is the sausage spicy?', 'What would you like to drink?'].map(val => ({ val }))
    } };
    const answer = ['server-uuid','customer-uuid','customer-uuid','server-uuid','customer-uuid','customer-uuid','customer-uuid','server-uuid'];
    assert.deepEqual(JSON.parse(core.knownMatrixAnswer(q)), answer);
    const plan = core.planSubmission([q], new Map(), false);
    assert.equal(plan.changed, true); assert.deepEqual(JSON.parse(plan.questionItemList[0].userAnswer), answer);
    const rejected = core.planSubmission([q], new Map([[91, { userAnswer: JSON.stringify(answer), answerStatus: 3 }]]), true);
    assert.equal(rejected.changed, false); assert.equal(rejected.pending.length, 1);
    const unknown = copy(q); unknown.extension.topic[0].val = 'An unseen question';
    assert.equal(core.knownMatrixAnswer(unknown), null); assert.equal(core.knownMatrixAnswer(matrix), null);
    const server = fixture([q], new Map([[91, { wire: JSON.stringify(answer), official: answer }]]), {
        initial: [{ questionId: 91, answerStatus: 3, answer: '[]', userAnswer: '' }]
    });
    const result = await core.solveContent(server.client, route, content, config, { errorNumShow: 3 });
    assert.equal(result.status, 'verified'); assert.equal(server.submissions, 1); assert.equal(server.marks, 1);
});

test('DOM blank fallback requires both the exact content and question ID; no numeric keys are invented', () => {
    const q = { id: 7, type: 'fill_dialog' }, other = { id: 8, type: 'fill_dialog' };
    const doc = { querySelector: selector => selector === '[data-content-id="14"]' ? { querySelector: sub =>
        sub === '[data-question-id="7"]' ? { querySelectorAll: () => [{ id: 'real-blank' }] } : null } : null };
    core.enrichBlankIds(doc, [q, other], content);
    assert.deepEqual(core.blankIds(q), ['real-blank']); assert.throws(() => core.blankIds(other), /空位置/);
    assert.equal(core.toWire(q, ['answer']), '[{"idx":"real-blank","answer":"answer"}]');
});

test('audio discovery uses the current content, rejects insecure URLs and deduplicates audio/source nodes', () => {
    const node = src => ({ src });
    const doc = { querySelector: () => ({ querySelectorAll: () => [node('https://cdn.example.org/a.mp3'), node('https://cdn.example.org/a.mp3'),
        node('https://cdn.example.org/ding.mp3'), node('http://cdn.example.org/b.mp3'), node('blob:https://www.tsinghuaelt.com/id')] }),
        querySelectorAll: () => { throw new Error('must scope to content'); } };
    const found = core.pageAudio(doc, 14, 'https://www.tsinghuaelt.com/reader');
    assert.equal(found.length, 2); assert.equal(found[0].url, 'https://cdn.example.org/a.mp3');
});

function fixture(questions, expected, options = {}) {
    const calls = [], waits = [], items = new Map((options.initial || []).map(x => [Number(x.questionId), copy(x)]));
    let submissions = 0, marks = 0, clock = 0;
    const leaves = core.flattenQuestions(questions);
    const result = {
        calls, waits, items,
        get submissions() { return submissions; },
        get marks() { return marks; },
        async fetch(url, init) {
            const u = new URL(url), data = init.body ? JSON.parse(init.body) : null;
            calls.push({ path: u.pathname, method: init.method, query: u.search, data });
            assert.equal(u.origin, 'https://zhjyapi.tsinghuaelt.com');
            assert.equal(init.headers['elt-user-token'], 'local-test-token');
            let response;
            if (u.pathname.endsWith('/detail')) response = { learnMode: 1, errorNumShow: 3 };
            else if (u.pathname.endsWith('/catalog/list/with/progress')) response = options.catalog || [{ id: 10, children: [] }];
            else if (/\/content\/\d+\/list$/.test(u.pathname)) response = [{ id: 14, type: 14 }, { id: 15, type: 4 }];
            else if (u.pathname.includes('/question/echo/')) response = { questionVOList: questions, questionAnswerItemVOList: [...items.values()] };
            else if (u.pathname.endsWith('/question/submit/answer')) {
                submissions++;
                assert.equal(data.bizId, 100); assert.equal(data.catalogId, 10); assert.equal(data.contentId, 14); assert.equal(data.contentType, 2);
                assert.deepEqual(data.questionItemList.map(x => x.questionId), leaves.map(x => x.id));
                for (const entry of data.questionItemList) {
                    assert.equal(typeof entry.userAnswer, 'string');
                    const item = { questionId: entry.questionId, userAnswer: entry.userAnswer, answerStatus: 3, rightRate: 0, answer: '' };
                    const wanted = expected.get(entry.questionId);
                    if (entry.userAnswer === wanted.wire) { item.answerStatus = 1; item.rightRate = 100; item.answer = wanted.official; }
                    else if (submissions >= (options.revealAt ?? 3)) item.answer = wanted.official;
                    items.set(entry.questionId, item);
                }
                options.onSubmit?.(submissions);
                response = [...items.values()];
            } else if (u.pathname.endsWith('/content/record')) { marks++; response = null; }
            else throw new Error('Unexpected endpoint ' + u.pathname);
            return { status: 200, ok: true, headers: new Headers(), json: async () => ({ code: 200, data: copy(response) }) };
        }
    };
    result.client = core.createClient({ fetch: result.fetch, token: () => 'local-test-token', signal: options.signal,
        sleep: async (ms, signal) => { if (signal?.aborted) throw new DOMException('aborted', 'AbortError'); waits.push(ms); clock += ms; }, now: () => clock });
    return result;
}

test('reader routes distinguish new course, public course and textbook; legacy cannot start', () => {
    for (const type of ['student_course', 'StudentCourse', 'public_course', 'PublicCourse']) {
        assert.equal(core.parseRoute('https://www.tsinghuaelt.com/course_center/reader/' + type + '/100?catalogId=10&contentId=14').contentType, 2);
    }
    assert.equal(core.parseRoute('https://www.tsinghuaelt.com/course_center/reader/Textbook/100?catalogId=10').contentType, 1);
    assert.equal(core.parseRoute('https://www.tsinghuaelt.com/legacy/exercise/100'), null);
    assert.equal(core.parseRoute('https://example.com/course_center/reader/student_course/100'), null);
    assert.equal(core.parseRoute('https://www.tsinghuaelt.com/course_center/reader/student_course/100/exam'), null);
});

test('a synthetic 19-digit course URL is recognized without rounding any IDs', () => {
    const url = 'https://www.tsinghuaelt.com/course_center/reader/student_course/8200000000000000001?catalogId=10001';
    assert.deepEqual(core.parseRoute(url), {
        type: 'student_course', bizId: '8200000000000000001', catalogId: 10001, contentId: null, contentType: 2
    });
    assert.equal(core.positiveId('9007199254740991'), Number.MAX_SAFE_INTEGER);
    assert.equal(core.positiveId('9007199254740992'), '9007199254740992');
    assert.equal(core.positiveId('0008200000000000000001'), '8200000000000000001');
    assert.equal(core.positiveId(BigInt('8200000000000000001')), '8200000000000000001');
    for (const invalid of [Number('8200000000000000001'), 0, -1, true, null, '1e3', '1.2', '0', '']) {
        assert.equal(core.positiveId(invalid), null);
    }
});

test('raw API JSON preserves large integer tokens and leaves answer strings intact', () => {
    const raw = '{"id":8200000000000000001,"next":8200000000000000002,"safe":9007199254740991,"unsafe":9007199254740992,"negative":-9007199254740992,"decimal":1.25,"exponent":2e3,"answer":"8200000000000000001 and \\"8200000000000000002\\"","nested":"{\\"id\\":8200000000000000001}","flag":true,"empty":null}';
    const parsed = core.parseApiJSON(raw);
    assert.deepEqual(parsed, {
        id: '8200000000000000001', next: '8200000000000000002', safe: Number.MAX_SAFE_INTEGER,
        unsafe: '9007199254740992', negative: '-9007199254740992', decimal: 1.25, exponent: 2000,
        answer: '8200000000000000001 and "8200000000000000002"', nested: '{"id":8200000000000000001}', flag: true, empty: null
    });
    assert.throws(() => core.parseApiJSON('{"id":01}'), SyntaxError);
    assert.throws(() => core.parseApiJSON('<html>login</html>'), SyntaxError);
});

test('adjacent large question and catalog IDs stay distinct across flattening, answer lookup and submissions', () => {
    const first = '8200000000000000001', second = '8200000000000000002';
    const questions = [first, second].map(id => ({ ...single, id }));
    const items = core.answerMap({ questionAnswerItemVOList: [
        { questionId: first, answer: 'uuid-A' }, { questionId: second, answer: 'uuid-B' }
    ] });
    const plan = core.planSubmission(core.flattenQuestions(questions), items, false);
    assert.equal(items.size, 2);
    assert.deepEqual(plan.questionItemList, [
        { questionId: first, userAnswer: 'uuid-A' }, { questionId: second, userAnswer: 'uuid-B' }
    ]);
    assert.deepEqual(core.catalogLeaves([{ id: first }, { id: second }]).map(x => x.id), [first, second]);
    assert.throws(() => core.flattenQuestions([single, { ...single, id: '1' }]), /重复/);
});

test('UUID single and multiple, zero-valued judge, and fill pairing use the actual server wire format', () => {
    assert.equal(core.toWire(single, 'uuid-B', true), 'uuid-B');
    assert.throws(() => core.toWire(single, 'B', true), /UUID/);
    assert.equal(core.toWire(judge, '0', true), '0');
    assert.equal(core.toWire(multiple, '["multi-A","multi-B"]', true), '["multi-A","multi-B"]');
    assert.equal(core.toWire(fill, fillOfficial, true), fillWire);
    assert.deepEqual(core.blankIds(fill), ['blank-one', 'blank-two']);
    assert.throws(() => core.toWire(fill, [{ idx: 'blank-one', standardAnswer: 'Answers will vary.' }, { idx: 'blank-two', val: 'wild' }], true), /不确定/);
    assert.throws(() => core.toWire(fill, [{ idx: 'wrong-one', val: 'hello' }, { idx: 'wrong-two', val: 'world' }], true), /ID 不匹配/);
    assert.throws(() => core.toWire({ ...fill, stem: '' }, ['one', 'two']), /位置/);
    assert.equal(core.stringifyDoRecord('uuid-B'), 'uuid-B');
});

test('drag and drag-fill have different scalar/array encodings', () => {
    assert.equal(core.toWire(drag, [{ idx: 'zone-1', answer: ['source-B'] }]), '[{"idx":"zone-1","answer":["source-B"]}]');
    assert.equal(core.toWire({ ...drag, type: 'matching_dragfillblank' }, [{ idx: 'blank-one', answer: ['source-B'] }]), '[{"idx":"blank-one","answer":"source-B"}]');
    assert.throws(() => core.toWire({ ...drag, type: 'matching_dragfillblank' }, [{ idx: 'b', answer: ['a', 'b'] }]), /单个/);
    assert.throws(() => core.toWire(drag, [{ idx: 'b', answer: [] }]), /选项/);
});

test('the five-row listening matrix uses one option UUID per row, including repeated choices', () => {
    assert.equal(core.draftAnswer(matrix), JSON.stringify(Array(5).fill('uuid-full')));
    assert.equal(core.toWire(matrix, JSON.stringify(matrixAnswer), true), JSON.stringify(matrixAnswer));
    const pairs = matrixAnswer.map((answer, i) => ({ idx: 'row-' + (i + 1), answer }));
    assert.equal(core.toWire(matrix, pairs), JSON.stringify(pairs));
    assert.throws(() => core.toWire(matrix, ['uuid-full']), /行数/);
    assert.throws(() => core.toWire(matrix, Array(5).fill('Full form')), /UUID/);
    assert.throws(() => core.toWire(matrix, Array(5).fill('0')), /UUID/);
    assert.throws(() => core.toWire(matrix, pairs.map(x => ({ ...x, idx: 'same' }))), /重复/);
    assert.throws(() => core.draftAnswer({ ...matrix, extension: { option: matrix.extension.option } }), /行数据/);
});

test('the listening matrix reveals after three wrong attempts, then corrects every row and verifies', async () => {
    const wire = JSON.stringify(matrixAnswer);
    const f = fixture([matrix], new Map([[6, { official: wire, wire }]]));
    const result = await core.solveContent(f.client, route, content, config, { errorNumShow: 3 });
    assert.equal(result.status, 'verified'); assert.equal(f.submissions, 4); assert.equal(f.marks, 1);
    assert.equal(f.calls.filter(x => x.method === 'POST' && x.path.endsWith('/answer')).at(-1).data.questionItemList[0].userAnswer, wire);
});

test('a revealed matrix answer with an unknown shape stops instead of consuming more wrong attempts', async () => {
    const f = fixture([matrix], new Map(), { initial: [{ questionId: 6, answer: '["bad-option"]', answerStatus: 3 }] });
    const result = await core.solveContent(f.client, route, content, config, { errorNumShow: 3 });
    assert.equal(result.status, 'pending'); assert.equal(f.submissions, 0);
    assert.match(result.pending[0].reason, /标准答案无法回填.*行数/);
});

test('combined questions are flattened by question ID and duplicate IDs fail before submission', () => {
    assert.deepEqual(core.flattenQuestions([{ id: 50, children: [single, { id: 51, children: [fill] }] }]).map(x => x.id), [1, 2]);
    assert.throws(() => core.flattenQuestions([single, single]), /重复/);
    assert.throws(() => core.flattenQuestions([{ id: null, type: 'choice_single' }]), /缺失/);
});

test('server partial scores are not complete; correct existing user answers survive retries', () => {
    assert.equal(core.correct({ answerStatus: 1, rightRate: 80 }), false);
    assert.equal(core.correct({ answerStatus: 1, rightRate: 100 }), true);
    const plan = core.planSubmission([single, fill], new Map([[1, { answerStatus: 1, userAnswer: 'uuid-B', rightRate: 100 }]]), true);
    assert.equal(plan.questionItemList[0].userAnswer, 'uuid-B');
    assert.equal(plan.questionItemList[1].userAnswer, '[{"idx":"blank-one","answer":"a"},{"idx":"blank-two","answer":"a"}]');
    assert.deepEqual(plan.awaiting, [2]);
});

test('end-to-end: trial, answer reveal, exact fill/UUID correction, final read and completion report', async () => {
    const questions = [{ id: 90, type: 'combined_basic', children: [single, fill, judge, multiple, drag] }];
    const expected = new Map([
        [1, { official: 'uuid-B', wire: 'uuid-B' }],
        [2, { official: JSON.stringify(fillOfficial), wire: fillWire }],
        [3, { official: '0', wire: '0' }],
        [4, { official: '["multi-A","multi-B"]', wire: '["multi-A","multi-B"]' }],
        [5, { official: '[{"idx":"zone-1","answer":["source-B"]},{"idx":"zone-2","answer":["source-A"]}]', wire: '[{"idx":"zone-1","answer":["source-B"]},{"idx":"zone-2","answer":["source-A"]}]' }]
    ]);
    const f = fixture(questions, expected);
    const result = await core.solveContent(f.client, route, content, config, { learnMode: 1, errorNumShow: 3 });
    assert.equal(result.status, 'verified'); assert.equal(result.correct, 5); assert.equal(result.total, 5);
    assert.equal(f.submissions, 4, 'three trials and one correction, not a guessed success');
    assert.equal(f.marks, 1);
    assert.ok(f.calls.filter(x => x.path.includes('/question/echo/')).length >= 5);
    assert.equal(f.waits[0], 0, 'the first read does not need to wait');
    assert.ok(f.waits.slice(1).every(x => x >= 2000));
    assert.equal(f.calls.at(-1).path, '/elt-user/user/study/course/content/record');
});

test('raw-text API end-to-end: a synthetic course and large IDs survive three wrong attempts and final correction', async () => {
    const actualRoute = core.parseRoute('https://www.tsinghuaelt.com/course_center/reader/student_course/8200000000000000001?catalogId=10001');
    const contentId = '8200000000000000002', questionId = '8200000000000000003';
    const calls = [], events = [], results = [];
    let submissions = 0, reads = 0, marks = 0;
    const client = core.createClient({ token: () => 'local-test-token', sleep: async () => {}, fetch: async (url, init) => {
        const u = new URL(url), data = init.body ? JSON.parse(init.body) : null;
        calls.push({ path: u.pathname, query: u.searchParams, data });
        let payload;
        if (u.pathname === '/elt-user/course/8200000000000000001/detail') payload = '{"errorNumShow":3,"learnMode":1}';
        else if (u.pathname === '/elt-user/course/8200000000000000001/catalog/list/with/progress') payload = '[{"id":10001}]';
        else if (u.pathname === '/elt-user/textbook/course/8200000000000000001/content/10001/list') payload = '[{"id":' + contentId + ',"type":14}]';
        else if (u.pathname === '/elt-user/question/echo/content/' + contentId + '/answer') {
            reads++;
            assert.equal(u.searchParams.get('biz_id'), '8200000000000000001');
            const questions = '[{"id":' + questionId + ',"type":"choice_single","extension":[{"idx":"uuid-A"},{"idx":"uuid-B"}]}]';
            const items = submissions ? '[{"questionId":' + questionId + ',"userAnswer":"' + (submissions === 4 ? 'uuid-B' : 'uuid-A')
                + '","answerStatus":' + (submissions === 4 ? 1 : 3) + ',"rightRate":' + (submissions === 4 ? 100 : 0)
                + ',"answer":"' + (submissions >= 3 ? 'uuid-B' : '') + '"}]' : '[]';
            payload = '{"questionVOList":' + questions + ',"questionAnswerItemVOList":' + items + '}';
        } else if (u.pathname === '/elt-user/question/submit/answer') {
            submissions++;
            assert.deepEqual(data, {
                bizId: '8200000000000000001', contentType: 2, catalogId: 10001, contentId,
                questionItemList: [{ questionId, userAnswer: submissions <= 3 ? 'uuid-A' : 'uuid-B' }]
            });
            assert.ok(submissions <= 4);
            payload = '[]';
        } else if (u.pathname === '/elt-user/user/study/course/content/record') {
            marks++;
            assert.equal(submissions, 4);
            assert.equal(reads, 5, 'completion only follows a fresh read of the corrected result');
            assert.deepEqual(data, { courseId: '8200000000000000001', catalogId: 10001, contentId });
            payload = 'null';
        } else throw new Error('Unexpected endpoint ' + u.pathname);
        return { status: 200, ok: true, headers: new Headers(), text: async () => '{"code":200,"data":' + payload + '}',
            json: async () => { throw new Error('response.json would lose integer precision'); } };
    } });
    const done = await core.runQueue(client, actualRoute, { ...config, scope: 'course' }, undefined, x => events.push(x), x => results.push(x));
    assert.equal(done.contents, 1);
    assert.equal(submissions, 4); assert.equal(marks, 1);
    assert.equal(results[0].status, 'verified'); assert.equal(results[0].contentId, contentId);
    assert.match(events[0], /答案显示阈值：3/);
    assert.equal(events.filter(x => x.includes('尝试获取答案')).length, 3);
    assert.equal(events.filter(x => x.includes('回填标准答案')).length, 1);
    assert.equal(calls.at(-1).path, '/elt-user/user/study/course/content/record');
});

test('unknown answer threshold prevents speculative submissions, but known answers can still be corrected', async () => {
    const expected = new Map([[1, { wire: 'uuid-B', official: 'uuid-B' }]]);
    const f = fixture([single], expected);
    const pending = await core.solveContent(f.client, route, content, config, {});
    assert.equal(pending.status, 'pending'); assert.equal(f.submissions, 0); assert.equal(f.marks, 0);
    const f2 = fixture([single], expected, { initial: [{ questionId: 1, answer: 'uuid-B', userAnswer: 'uuid-A', answerStatus: 3 }] });
    const corrected = await core.solveContent(f2.client, route, content, config, {});
    assert.equal(corrected.status, 'verified'); assert.equal(f2.submissions, 1);
});

test('speech or blank subjective questions in a mixed set never get empty/fake submissions or completion marks', async () => {
    for (const manual of [{ id: 7, type: 'oral_follow_along' }, { id: 7, type: 'essay_writing', obSub: 'sub' }]) {
        const f = fixture([single, manual], new Map());
        const result = await core.solveContent(f.client, route, content, config, { errorNumShow: 3 });
        assert.equal(result.status, 'pending'); assert.equal(result.pending[0].questionId, 7);
        assert.equal(f.submissions, 0); assert.equal(f.marks, 0);
    }
});

test('a graded recording already made by the user survives an objective correction in a mixed group', async () => {
    const spoken = { id: 7, type: 'oral_follow_along' };
    const recording = '[{"existingRecording":"recorded-by-user"}]';
    const f = fixture([single, spoken], new Map([
        [1, { official: 'uuid-B', wire: 'uuid-B' }], [7, { official: '', wire: recording }]
    ]), { initial: [
        { questionId: 1, answer: 'uuid-B', userAnswer: 'uuid-A', answerStatus: 3 },
        { questionId: 7, userAnswer: recording, answerStatus: 1, rightRate: 100 }
    ] });
    const result = await core.solveContent(f.client, route, content, config, { errorNumShow: 3 });
    assert.equal(result.status, 'verified'); assert.equal(f.submissions, 1);
    assert.equal(f.calls.find(x => x.path.endsWith('/question/submit/answer')).data.questionItemList[1].userAnswer, recording);
});

test('attempt budget stops unresolved content and reserves an opportunity to correct official answers', async () => {
    const f = fixture([single], new Map([[1, { wire: 'uuid-B', official: 'uuid-B' }]]), { revealAt: 100 });
    const result = await core.solveContent(f.client, route, content, { ...config, maxAttempts: 2 }, { errorNumShow: 3 });
    assert.equal(result.status, 'pending'); assert.equal(f.submissions, 1); assert.equal(f.marks, 0);
});

test('API handles HTTP and business rate limits, waits at least 90 seconds, then retries', async () => {
    for (const responseLimit of [429, 530, 200]) {
        let calls = 0, clock = 0;
        const waits = [], events = [];
        const client = core.createClient({ token: () => 't', now: () => clock,
            sleep: async ms => { waits.push(ms); clock += ms; }, onEvent: message => events.push(message),
            fetch: async () => {
                calls++;
                return { status: calls === 1 ? responseLimit : 200, ok: calls > 1 || responseLimit === 200, headers: new Headers(),
                    json: async () => calls === 1 ? { code: responseLimit === 200 ? 429 : responseLimit } : { code: 200, data: 'ok' } };
            } });
        assert.equal(await client.request('/test'), 'ok');
        assert.equal(calls, 2); assert.ok(waits.includes(90000)); assert.match(events[0], /限流/);
    }
});

test('POST network uncertainty pauses without retry; expired login and non-JSON responses do not count as success', async () => {
    let calls = 0;
    const opts = { token: () => 't', sleep: async () => {} };
    const client = core.createClient({ ...opts, fetch: async () => { calls++; throw new Error('connection reset after server accepted body'); } });
    await assert.rejects(client.request('/question/submit/answer', { method: 'POST', data: {} }), /结果未确认/);
    assert.equal(calls, 1);
    const auth = core.createClient({ ...opts, fetch: async () => ({ status: 200, ok: true, json: async () => ({ code: 401 }) }) });
    await assert.rejects(auth.request('/test'), /登录已过期/);
    const html = core.createClient({ ...opts, fetch: async () => ({ status: 200, ok: true, json: async () => { throw new Error('HTML'); } }) });
    await assert.rejects(html.request('/test'), /业务码/);
});

test('pause after a submission prevents final read, subsequent submissions and completion mark', async () => {
    const controller = new AbortController();
    const f = fixture([single], new Map([[1, { wire: 'uuid-B', official: 'uuid-B' }]]), { signal: controller.signal, onSubmit: () => controller.abort() });
    await assert.rejects(core.solveContent(f.client, route, content, config, { errorNumShow: 3 }, controller.signal), { name: 'AbortError' });
    assert.equal(f.submissions, 1); assert.equal(f.marks, 0);
    assert.equal(f.calls.filter(x => x.path.includes('/question/echo/')).length, 1);
});

test('request context is checked again after the pacing wait', async () => {
    let valid = true, sends = 0;
    const client = core.createClient({ token: () => 't', validate: () => { if (!valid) throw new Error('changed course'); },
        sleep: async () => { valid = false; }, fetch: async () => { sends++; } });
    await assert.rejects(client.request('/test'), /changed course/); assert.equal(sends, 0);
});

test('course queue respects inherited locks and skips audio/video rather than marking them completed', async () => {
    const leaves = core.catalogLeaves([{ id: 20, lock: true, children: [{ id: 21 }] }, { id: 22, lock: '1' }, { id: 10 }]);
    assert.deepEqual(leaves.map(x => x.locked), [true, true, false]);
    const f = fixture([single], new Map([[1, { wire: 'uuid-B', official: 'uuid-B' }]]), {
        catalog: [{ id: 10 }, { id: 20, lock: true }], initial: [{ questionId: 1, userAnswer: 'uuid-B', answerStatus: 1, rightRate: 100 }]
    });
    const results = [];
    const done = await core.runQueue(f.client, route, { ...config, scope: 'course' }, undefined, () => {}, x => results.push(x));
    assert.equal(done.contents, 1); assert.equal(done.blocked, 1); assert.equal(results.length, 1);
    assert.equal(f.calls.some(x => x.path.includes('/content/20/list')), false);
    assert.equal(f.calls.some(x => x.path.includes('/content/15/answer')), false);
    assert.equal(f.submissions, 0); assert.equal(f.marks, 1);
});

test('config clamps request frequency and submission budgets', () => {
    const c = core.normalizeConfig({ interval: 0, maxAttempts: 999, scope: 'other', trial: false });
    assert.equal(c.interval, 2000); assert.equal(c.maxAttempts, 20); assert.equal(c.scope, 'chapter'); assert.equal(c.trial, false);
});

test('course processing continues through more than three successive unlocks and rechecks every chapter', async () => {
    const scanned = [], solved = [], marked = new Set();
    const client = { request: async (endpoint, options = {}) => {
        if (endpoint.endsWith('/detail')) return { errorNumShow: 3 };
        if (endpoint.endsWith('/catalog/list/with/progress')) {
            return [10, 11, 12, 13, 14].map((id, i) => ({ id, lock: i > 0 && !marked.has(id - 1) }));
        }
        const list = endpoint.match(/\/content\/(\d+)\/list$/);
        if (list) { const chapter = Number(list[1]); scanned.push(chapter); return [{ id: chapter * 100, type: 14 }]; }
        const exercise = endpoint.match(/\/echo\/content\/(\d+)\/answer$/);
        if (exercise) { solved.push(Number(exercise[1])); return { questionVOList: [single], questionAnswerItemVOList: [{ questionId: 1, answerStatus: 1, rightRate: 100 }] }; }
        if (endpoint.endsWith('/content/record')) { marked.add(options.data.catalogId); return null; }
        throw new Error('Unexpected endpoint ' + endpoint);
    } };
    const done = await core.runQueue(client, { ...route, contentId: null }, { ...config, scope: 'course' });
    assert.deepEqual(scanned, [10, 11, 12, 13, 14]);
    assert.deepEqual(solved, [1000, 1100, 1200, 1300, 1400]);
    assert.equal(done.chapters, 5); assert.equal(done.blocked, 0);
});

test('queue starts at the visible content, resumes after a pending recording, and awaits page navigation', async () => {
    const read = [], shown = [], reports = [];
    const client = { request: async endpoint => {
        if (endpoint.endsWith('/detail')) return { errorNumShow: 3 };
        if (endpoint.endsWith('/list')) return [{ id: 13, type: 14 }, { id: 14, type: 14 }, { id: 15, type: 4 }, { id: 16, type: 14 }];
        if (endpoint.includes('/echo/')) {
            const id = Number(endpoint.match(/content\/(\d+)/)[1]); read.push(id);
            assert.equal(shown.at(-1), id, 'page hook must finish before the corresponding exercise is read');
            return { questionVOList: [single], questionAnswerItemVOList: [{ questionId: 1, answerStatus: 1, rightRate: 100 }] };
        }
        if (endpoint.endsWith('/record')) return null;
        throw new Error(endpoint);
    } };
    const prior = [{ catalogId: 10, contentId: 14, status: 'pending', pending: [{ type: 'oral_follow_along' }] }];
    const done = await core.runQueue(client, route, config, undefined, () => {}, x => reports.push(x), {
        results: prior, beforeContent: async c => { await Promise.resolve(); shown.push(c.id); }
    });
    assert.deepEqual(read, [16]); assert.deepEqual(shown, [16]);
    assert.equal(done.contents, 1); assert.equal(reports[0].status, 'verified');
});

function readerFixture({ disabled = false, stuck = false, mounted = false } = {}) {
    let id = 14, count = 1, clicks = 0, scrolls = 0;
    const target = { id: 17, catalogId: 10 };
    const next = { disabled, className: '', querySelector: () => null, getAttribute: () => null,
        click: () => { clicks++; if (!stuck) { count++; id++; } } };
    const previous = { ...next, click: () => { throw new Error('Must not click previous'); } };
    const node = { dataset: { contentId: '17' }, closest: () => ({ dataset: { catalogId: '10' } }),
        scrollIntoView: () => { scrolls++; id = 17; } };
    return { target, get clicks() { return clicks; }, get scrolls() { return scrolls; },
        options: { sleep: async () => {}, current: () => ({ ...route, contentId: id }), document: {
            querySelector: () => ({ textContent: count + '/10' }),
            querySelectorAll: selector => selector.includes('pagination-btn') ? (mounted ? [] : [previous, next]) : (mounted ? [node] : [])
        } }
    };
}

test('visible next-page navigation observes content and counters even though the route URL never changes', async () => {
    const f = readerFixture();
    assert.equal(await core.showReaderContent(f.options, f.target), true); assert.equal(f.clicks, 3);
    const scroll = readerFixture({ mounted: true });
    assert.equal(await core.showReaderContent(scroll.options, scroll.target), true); assert.equal(scroll.scrolls, 1);
});

test('page navigation cannot click disabled next buttons, loop on an unchanged page, or advance after pause', async () => {
    const locked = readerFixture({ disabled: true });
    assert.equal(await core.showReaderContent(locked.options, locked.target), false); assert.equal(locked.clicks, 0);
    const stuck = readerFixture({ stuck: true });
    assert.equal(await core.showReaderContent(stuck.options, stuck.target), false); assert.equal(stuck.clicks, 1);
    const controller = new AbortController(); controller.abort();
    const paused = readerFixture();
    await assert.rejects(core.showReaderContent({ ...paused.options, signal: controller.signal }, paused.target), { name: 'AbortError' });
    assert.equal(paused.clicks, 0);
});

test('cross-page continuation is bound to the exact target, current login, expiry, version and bounded reload count', async () => {
    const original = { ...route, bizId: '8200000000000000001' }, target = { catalogId: 11, id: '8200000000000000002' };
    const tag = await core.credentialTag('test-login', webcrypto);
    const reports = [{ catalogId: 10, contentId: 14, status: 'pending', pending: [{ type: 'oral_follow_along' }] }];
    const state = core.makeResumeState(original, target, config, reports, tag, 100);
    const url = core.readerURL(original, target), raw = JSON.stringify(state);
    assert.equal(core.readResumeState(raw, url, tag, 101).target.contentId, target.id);
    assert.equal(core.readResumeState(raw, url, await core.credentialTag('different-login', webcrypto), 101), null);
    assert.equal(core.readResumeState(raw, url.replace('catalogId=11', 'catalogId=12'), tag, 101), null);
    assert.equal(core.readResumeState(raw, url.replace(target.id, '8200000000000000003'), tag, 101), null);
    assert.equal(core.readResumeState(raw, url, tag, state.expires + 1), null);
    for (const replacement of [{ version: '0.0.0' }, { navigationAttempts: 3 }, { results: [{ ...reports[0], status: 'interrupted' }] }]) {
        assert.equal(core.readResumeState(JSON.stringify({ ...state, ...replacement }), url, tag, 101), null);
    }
    assert.equal(raw.includes('test-login'), false, 'resume storage must not contain the credential');
});

test('an interrupted set stays in the report, without being reported as verified', async () => {
    const results = [];
    const client = { request: async endpoint => {
        if (endpoint.endsWith('/detail')) return { errorNumShow: 3 };
        if (endpoint.endsWith('/list')) return [{ id: 14, type: 14 }];
        throw new coreError('read failed');
    } };
    function coreError(message) { return new Error(message); }
    await assert.rejects(core.runQueue(client, route, config, undefined, () => {}, result => results.push(result)), /read failed/);
    assert.equal(results.length, 1); assert.equal(results[0].status, 'interrupted');
    assert.equal(results[0].contentId, 14); assert.equal(results[0].pending[0].reason, 'read failed');
});

test('the actual browser artifact mounts one isolated panel, stays idle, and reports a missing reader route', () => {
    const elements = new Map();
    const get = id => {
        if (!elements.has(id)) elements.set(id, { textContent: '', value: '', checked: false, disabled: false });
        return elements.get(id);
    };
    const main = { hidden: false };
    const shadow = { set innerHTML(value) { assert.ok(value.includes('aria-live="polite"')); }, getElementById: get, querySelector: () => main };
    let mounted = 0, network = 0;
    const document = {
        body: { appendChild() { mounted++; } }, getElementById: () => null,
        createElement: () => ({ style: {}, attachShadow: () => shadow }), querySelectorAll: () => []
    };
    const storage = new Map();
    const listeners = new Map();
    const window = { innerHeight: 900, addEventListener: (name, handler) => listeners.set(name, handler), fetch: async () => { network++; } };
    const location = { href: 'https://www.tsinghuaelt.com/course_center/', pathname: '/course_center/' };
    let environmentChanged, disconnected = false;
    class MutationObserver {
        constructor(callback) { environmentChanged = callback; }
        observe(target, options) { assert.equal(target, document.body); assert.equal(options.subtree, true); }
        disconnect() { disconnected = true; }
    }
    window.top = window.self = window;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../tsinghuaelt-new.user.js'), 'utf8'), {
        window, document, location, MutationObserver,
        localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
        URL, URLSearchParams, AbortController, DOMException, Blob, setTimeout, clearTimeout, console
    });
    assert.equal(mounted, 1); assert.equal(network, 0);
    assert.match(get('environment').textContent, /具体章节/);
    get('fold').onclick(); assert.equal(main.hidden, true);
    get('check').onclick(); assert.match(get('status').textContent, /具体章节/);
    get('start').onclick(); assert.equal(network, 0);
    location.href = 'https://www.tsinghuaelt.com/course_center/reader/student_course/8200000000000000001?catalogId=10001';
    location.pathname = new URL(location.href).pathname;
    environmentChanged();
    assert.match(get('environment').textContent, /登录状态缺失/);
    storage.set('eltUserToken', 'local-test-token');
    environmentChanged();
    assert.match(get('environment').textContent, /已识别新版课程，可以开始/);
    assert.equal(network, 0, 'route and login detection must not start exercises');
    listeners.get('pagehide')(); assert.equal(disconnected, true);
});

function browserHarness(href, fetch, local, session, cryptoImpl = webcrypto) {
    const elements = new Map(), listeners = new Map(), destinations = [], opened = [];
    const get = id => {
        if (!elements.has(id)) elements.set(id, { textContent: '', value: '', checked: false, disabled: false });
        return elements.get(id);
    };
    const root = { set innerHTML(_) {}, getElementById: get, querySelector: () => ({ hidden: false }) };
    const document = { body: { appendChild() {} }, getElementById: () => null,
        createElement: () => ({ style: {}, attachShadow: () => root }), querySelectorAll: () => [], querySelector: () => null };
    const u = new URL(href), location = { href, pathname: u.pathname, origin: u.origin, assign: url => destinations.push(url) };
    const storage = values => ({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) });
    const window = { innerHeight: 900, fetch, crypto: cryptoImpl, addEventListener: (name, handler) => listeners.set(name, handler),
        open: url => opened.push(url) };
    window.top = window.self = window;
    // Pace instantly in this offline harness, while never firing a request's
    // 25-second timeout before its immediate mocked response has resolved.
    let timerId = 0;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../tsinghuaelt-new.user.js'), 'utf8'), {
        window, document, location, localStorage: storage(local), sessionStorage: storage(session),
        URL, URLSearchParams, AbortController, DOMException, Blob, TextEncoder, Uint8Array,
        setTimeout: (fn, ms) => { if (ms < 25000) queueMicrotask(fn); return ++timerId; }, clearTimeout() {}, console
    });
    return { get, destinations, opened, listeners };
}

async function settleBrowser(predicate) {
    for (let i = 0; i < 150; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.fail('Browser workflow did not settle');
}

test('actual userscript: skip recording, reload to the matrix, correct it, reload to the next chapter and finish without repeats', async () => {
    const local = new Map([['eltUserToken', 'local-test-token'], ['local-elt-new-practice.config.v1', JSON.stringify({ scope: 'course' })]]);
    const session = new Map(), reads = [], marks = [], submissions = [];
    const wire = JSON.stringify(matrixAnswer);
    let matrixSubmits = 0;
    const fetch = async (url, init) => {
        const u = new URL(url), data = init.body ? JSON.parse(init.body) : null;
        let response;
        if (u.pathname.endsWith('/detail')) response = { errorNumShow: 3, learnMode: 1 };
        else if (u.pathname.endsWith('/catalog/list/with/progress')) response = [{ id: 10 }, { id: 11 }];
        else if (u.pathname.endsWith('/content/10/list')) response = [{ id: 13, type: 14 }, { id: 14, type: 14 }, { id: 15, type: 4 }, { id: 17, type: 14 }];
        else if (u.pathname.endsWith('/content/11/list')) response = [{ id: 24, type: 14 }];
        else if (u.pathname.includes('/question/echo/')) {
            const id = Number(u.pathname.match(/content\/(\d+)/)[1]); reads.push(id);
            if (id === 14) response = { questionVOList: [{ id: 7, type: 'oral_follow_along' }], questionAnswerItemVOList: [] };
            else if (id === 17) response = { questionVOList: [matrix], questionAnswerItemVOList: matrixSubmits ? [{
                questionId: 6, answerStatus: matrixSubmits === 4 ? 1 : 3, rightRate: matrixSubmits === 4 ? 100 : 0,
                userAnswer: matrixSubmits === 4 ? wire : JSON.stringify(Array(5).fill('uuid-full')), answer: matrixSubmits >= 3 ? wire : ''
            }] : [] };
            else if (id === 24) response = { questionVOList: [single], questionAnswerItemVOList: [{ questionId: 1, answerStatus: 1, rightRate: 100 }] };
            else throw new Error('Unexpected read ' + id);
        } else if (u.pathname.endsWith('/question/submit/answer')) {
            assert.equal(data.contentId, 17, 'recording and already correct content must never be submitted');
            matrixSubmits++; submissions.push(data);
            assert.equal(data.questionItemList[0].userAnswer, matrixSubmits === 4 ? wire : JSON.stringify(Array(5).fill('uuid-full')));
            response = [];
        } else if (u.pathname.endsWith('/content/record')) { marks.push(data.contentId); response = null; }
        else throw new Error(u.pathname);
        return { status: 200, ok: true, headers: new Headers(), text: async () => JSON.stringify({ code: 200, data: response }) };
    };
    const firstURL = 'https://www.tsinghuaelt.com/course_center/reader/student_course/100?catalogId=10&contentId=14';
    const first = browserHarness(firstURL, fetch, local, session);
    assert.equal(reads.length, 0, 'a new task stays idle until Start');
    await first.get('start').onclick();
    assert.equal(first.destinations.length, 1);
    assert.match(first.destinations[0], /catalogId=10&contentId=17/);
    assert.deepEqual(reads, [14]); assert.equal(marks.length, 0);
    assert.equal(session.size, 1);
    assert.equal([...session.values()][0].includes('local-test-token'), false);
    first.listeners.get('pagehide')();

    const second = browserHarness(first.destinations[0], fetch, local, session);
    await settleBrowser(() => second.destinations.length === 1);
    assert.equal(submissions.length, 4); assert.deepEqual(marks, [17]);
    assert.match(second.destinations[0], /catalogId=11&contentId=24/);
    second.listeners.get('pagehide')();

    const third = browserHarness(second.destinations[0], fetch, local, session);
    await settleBrowser(() => third.get('status').textContent.includes('本次处理结束'));
    assert.equal(third.destinations.length, 0); assert.equal(session.size, 0);
    assert.equal(reads.filter(x => x === 14).length, 1, 'pending recording is retained, never repeatedly revisited');
    assert.equal(reads.filter(x => x === 17).length, 5, 'three trials, correction and fresh verification read');
    assert.equal(reads.filter(x => x === 24).length, 1);
    assert.deepEqual(marks, [17, 24]);
    assert.match(third.get('counts').textContent, /已核验 2 组 · 待处理 1 组/);
    third.get('pending').onclick(); assert.match(third.opened[0], /catalogId=10&contentId=14/);
});

test('actual userscript: Pause clears queued continuation and a changed login cannot auto-resume it', async () => {
    const resumeKey = 'local-elt-new-practice.resume.v1', local = new Map([['eltUserToken', 'new-login']]), session = new Map();
    const state = core.makeResumeState(route, { catalogId: 10, id: 17 }, config, [], await core.credentialTag('old-login', webcrypto));
    session.set(resumeKey, JSON.stringify(state));
    let network = 0;
    const page = browserHarness(core.readerURL(route, { catalogId: 10, id: 17 }), async () => { network++; throw new Error('must stay idle'); }, local, session);
    await settleBrowser(() => session.size === 0);
    assert.equal(network, 0); assert.match(page.get('status').textContent, /登录或页面已变化/);
    session.set(resumeKey, JSON.stringify(state));
    page.get('stop').onclick(); assert.equal(session.size, 0);
});

test('actual userscript: pausing during fingerprint calculation cannot resurrect a continuation', async () => {
    const local = new Map([['eltUserToken', 'test-login']]), session = new Map();
    const state = core.makeResumeState(route, { catalogId: 10, id: 17 }, config, [], await core.credentialTag('test-login', webcrypto));
    session.set('local-elt-new-practice.resume.v1', JSON.stringify(state));
    let release, network = 0;
    const delayedCrypto = { subtle: { digest: async (...args) => {
        await new Promise(resolve => { release = resolve; });
        return webcrypto.subtle.digest(...args);
    } } };
    const page = browserHarness(core.readerURL(route, { catalogId: 10, id: 17 }), async () => { network++; }, local, session, delayedCrypto);
    page.get('stop').onclick(); release();
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(network, 0); assert.equal(session.size, 0); assert.match(page.get('status').textContent, /正在暂停/);
});

test('actual userscript: login changing between resume verification and task startup cannot reuse another login results', async () => {
    const local = new Map([['eltUserToken', 'test-login']]), session = new Map();
    const state = core.makeResumeState(route, { catalogId: 10, id: 17 }, config, [], await core.credentialTag('test-login', webcrypto));
    session.set('local-elt-new-practice.resume.v1', JSON.stringify(state));
    let network = 0, hashes = 0;
    const changingCrypto = { subtle: { digest: async (...args) => {
        const digest = await webcrypto.subtle.digest(...args);
        if (++hashes === 1) local.set('eltUserToken', 'new-login');
        return digest;
    } } };
    const page = browserHarness(core.readerURL(route, { catalogId: 10, id: 17 }), async () => { network++; }, local, session, changingCrypto);
    await settleBrowser(() => page.get('status').textContent.includes('登录状态已变化'));
    assert.equal(network, 0); assert.equal(session.size, 0);
});
