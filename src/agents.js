// Claude Code 와 Codex 세션 로그를 꼬리만 읽어서 상태·토큰을 뽑는다. 의존성 없음.
//  Claude : ~/.claude/projects/<proj>/<session>.jsonl   assistant 줄마다 message.usage
//  Codex  : ~/.codex/sessions/Y/M/D/rollout-*.jsonl      task_started/complete, token_count(누적)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RECENT_MS = 8 * 3600e3;      // 이보다 오래 조용한 세션은 목록에서 뺀다 (합계에는 이번 달 것 모두 들어간다)
const WORKING_MS = 8000;           // 로그가 이 안에 늘고 있으면 작업 중
const WAITING_MS = 30 * 60e3;      // 끝난 뒤 이만큼은 "내 차례"로 본다
const TOOL_MS = 10 * 60e3;         // 도구 결과를 기다리는 중이면 이만큼은 작업 중으로 본다

const ROOTS = [
  { agent: 'claude', dir: path.join(os.homedir(), '.claude', 'projects') },
  { agent: 'codex', dir: path.join(os.homedir(), '.codex', 'sessions') },
];

const sessions = new Map(); // file -> session (이번 달에 건드린 파일 전부)

const dayStart = () => new Date().setHours(0, 0, 0, 0);
const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };

function newSession(agent, file) {
  return { agent, file, offset: 0, rest: '', cwd: null, topic: null, title: null, model: null, input: 0, output: 0, turns: 0, last: null, mtime: 0 };
}

/** 사용자 프롬프트의 첫 구절만. 지시문(<system-reminder>, # AGENTS.md, [interrupted])은 무시. 세션 "요약" 대용. */
// ponytail: 첫 문장·첫 쉼표까지 잘라 쓴다. 진짜 요약이 필요하면 여기서 LLM 을 부르되 토큰을 먹는다.
function topicOf(text) {
  const t = (text || '').trim();
  if (!t || '<#['.includes(t[0])) return null;
  const first = t.replace(/^(그리고|또|아니다|근데)\s+/, '').split(/[.!?。\n]|\.\.\.|,\s|…/)[0].replace(/\s+/g, ' ').trim();
  return first.length > 28 ? `${first.slice(0, 27)}…` : first || null;
}

/** 새로 붙은 줄만 읽어서 session 에 누적한다. */
function ingest(s) {
  const st = fs.statSync(s.file);
  s.mtime = st.mtimeMs;
  if (st.size < s.offset) { s.offset = 0; s.rest = ''; } // 잘렸으면 처음부터
  if (st.size === s.offset) return;
  const fd = fs.openSync(s.file, 'r');
  try {
    const buf = Buffer.alloc(st.size - s.offset);
    fs.readSync(fd, buf, 0, buf.length, s.offset);
    s.offset = st.size;
    const lines = (s.rest + buf.toString('utf8')).split('\n');
    s.rest = lines.pop();
    // ponytail: 오래된 파일은 토큰 줄만 파싱한다 (turns 는 셀 필요 없음). 정확한 턴 수가 필요하면 조건 제거.
    const cold = Date.now() - s.mtime > RECENT_MS;
    for (const line of lines) {
      if (!line) continue;
      if (cold && !line.includes('"usage"') && !line.includes('token_count')) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      (s.agent === 'claude' ? ingestClaude : ingestCodex)(s, e);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function ingestClaude(s, e) {
  if (e.cwd && !s.cwd) s.cwd = e.cwd;
  // Claude Code 가 `--resume` 목록에 쓰는 제목. 있으면 첫 구절 대신 이걸 보여준다.
  if (e.type === 'ai-title' && e.aiTitle) s.title = e.aiTitle;
  if (e.type === 'custom-title' && e.customTitle) s.title = e.customTitle;
  // 사용자 메시지: 턴 시작 메시지 + 턴 중간에 끼워 넣은 메시지(queue-operation/enqueue)
  let text = null;
  if (e.type === 'user' && !e.toolUseResult) {
    const c = e.message?.content;
    text = typeof c === 'string' ? c : (c || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  } else if (e.type === 'queue-operation' && e.operation === 'enqueue') {
    text = e.content;
  }
  if (text !== null && !text.startsWith('[Request interrupted')) { s.turns += 1; s.topic = topicOf(text) || s.topic; }
  if (e.type !== 'assistant') return;
  if (e.message?.model && e.message.model[0] !== '<') s.model = e.message.model; // <synthetic> 은 무시
  const u = e.message?.usage;
  if (u) {
    s.input += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    s.output += u.output_tokens || 0;
  }
  const content = e.message?.content;
  const usesTool = Array.isArray(content) && content.some((b) => b.type === 'tool_use');
  s.last = usesTool ? 'tool' : 'said';
}

function ingestCodex(s, e) {
  const p = e.payload || {};
  if (e.type === 'session_meta' && p.cwd) s.cwd = p.cwd;
  if (e.type === 'turn_context' && p.model) s.model = p.model;
  if (e.type === 'response_item' && p.role === 'user') {
    const text = (p.content || []).filter((b) => b.type === 'input_text').map((b) => b.text).join(' ');
    s.topic = topicOf(text) || s.topic;
  }
  if (e.type !== 'event_msg') return;
  if (p.type === 'task_started') { s.turns += 1; s.last = 'tool'; }
  if (p.type === 'task_complete' || p.type === 'turn_aborted') s.last = 'said';
  const t = p.type === 'token_count' && p.info?.total_token_usage;
  if (t) { s.input = t.input_tokens || 0; s.output = t.output_tokens || 0; }
}

/**
 *  working : 로그가 방금까지 늘고 있다, 또는 도구(Codex 는 task) 결과를 기다리는 중
 *  waiting : 에이전트가 말을 마치고 멈췄다 = 내 차례
 *  idle    : 그 외
 */
function classify(last, ageMs) {
  if (ageMs < WORKING_MS) return 'working';
  if (last === 'tool') return ageMs < TOOL_MS ? 'working' : 'idle';
  return last === 'said' && ageMs < WAITING_MS ? 'waiting' : 'idle';
}

/** 살아있는 pid 집합. 종료 중에 커널에서 멈춘 것(ps STAT 에 Z 또는 E, 터미널을 닫아도 남는 좀비)은 뺀다. ps 가 없으면(Windows) null. */
function livePids() {
  try {
    const ps = execFileSync('ps', ['-axo', 'pid=,stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const out = new Set();
    for (const l of ps.split('\n')) { const [pid, stat] = l.trim().split(/\s+/); if (pid && !/[ZE]/.test(stat)) out.add(Number(pid)); }
    return out;
  } catch { return null; }
}
const isLive = (live, pid) => live ? live.has(pid) : (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();

/** 살아있는 Claude Code 세션: ~/.claude/sessions/<pid>.json → sessionId → {status(busy|idle), pid}. pid 가 죽었으면 뺀다. */
function claudeRegistry(live) {
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (isLive(live, r.pid)) out.set(r.sessionId, { status: r.status, pid: r.pid });
    } catch { /* 깨진 파일 */ }
  }
  return out;
}

/** 지금 떠 있는 codex 프로세스: cwd → [pid]. lsof 가 없으면 null(모른다). Codex 는 세션 레지스트리가 없어서 cwd 로 판별. */
function codexByCwd(live) {
  try {
    const out = execFileSync('lsof', ['-a', '-d', 'cwd', '-c', 'codex', '-Fpn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = new Map();
    let pid = null;
    for (const l of out.split('\n')) {
      if (l[0] === 'p') pid = Number(l.slice(1));
      else if (l[0] === 'n' && isLive(live, pid)) m.set(l.slice(1), [...(m.get(l.slice(1)) || []), pid]);
    }
    return m;
  } catch { return null; }
}

/** 살아있는 세션만, 같은 repo 가 이웃하도록 정렬(repo 는 가장 최근 활동 순, 그 안은 활동 순). 화면에서 repo 헤더 아래 나열한다. */
function alive(list, cwds) {
  const kept = list.filter((s) => s.agent === 'claude' || s.state === 'working' || !cwds || cwds.has(s.cwd));
  const rank = new Map(); // repo → 그 repo 에서 가장 최근 idleMs
  for (const s of kept) rank.set(s.cwd, Math.min(rank.get(s.cwd) ?? Infinity, s.idleMs));
  return kept.sort((a, b) => (rank.get(a.cwd) - rank.get(b.cwd)) || (a.idleMs - b.idleMs));
}

function discover() {
  for (const { agent, dir } of ROOTS) {
    let files;
    try { files = fs.readdirSync(dir, { recursive: true }); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      if (sessions.has(file)) continue;
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs >= monthStart()) sessions.set(file, newSession(agent, file));
    }
  }
}

/** 최근 세션 목록(활동 순) + 오늘·이번 달 토큰 합계. */
// ponytail: 날짜 구분은 파일 mtime 기준. 자정을 넘긴 세션은 통째로 오늘로 잡힌다. 줄별 timestamp 로 나누면 정확.
function readAgents() {
  discover();
  const now = Date.now();
  const out = [];
  const live = livePids();
  const reg = claudeRegistry(live);
  const cwds = codexByCwd(live);
  const usage = {};
  for (const { agent } of ROOTS) usage[agent] = { today: { input: 0, output: 0 }, month: { input: 0, output: 0 } };
  for (const s of sessions.values()) {
    try { ingest(s); } catch { sessions.delete(s.file); continue; }
    if (s.mtime < monthStart()) { sessions.delete(s.file); continue; }
    const u = usage[s.agent];
    u.month.input += s.input; u.month.output += s.output;
    if (s.mtime >= dayStart()) { u.today.input += s.input; u.today.output += s.output; }
    if (now - s.mtime > RECENT_MS) continue;
    let state = classify(s.last, now - s.mtime);
    const r = s.agent === 'claude' && reg.get(path.basename(s.file, '.jsonl'));
    if (s.agent === 'claude') {
      if (!r) continue; // 닫힌 세션
      state = r.status === 'busy' ? 'working' : 'waiting'; // idle = 말 끝내고 내 차례
    }
    const codexPids = cwds?.get(s.cwd) || [];
    out.push({
      agent: s.agent,
      pid: r ? r.pid : (codexPids.length === 1 ? codexPids[0] : null), // 같은 cwd 에 codex 가 둘이면 어느 게 이 세션인지 몰라서 × 없음
      cwd: s.cwd,
      project: s.cwd ? path.basename(s.cwd) : '?',
      topic: s.title || s.topic,
      model: s.model,
      state,
      input: s.input,
      output: s.output,
      turns: s.turns,
      idleMs: now - s.mtime,
    });
  }
  return { sessions: alive(out, cwds), usage };
}

module.exports = { readAgents, classify, alive, topicOf };

if (require.main === module) {
  const assert = require('node:assert');
  assert.equal(classify('said', 1000), 'working');
  assert.equal(classify('said', 20e3), 'waiting');
  assert.equal(classify('tool', 20e3), 'working');
  assert.equal(classify('tool', 20 * 60e3), 'idle');
  assert.equal(classify('said', 2 * 3600e3), 'idle');
  assert.equal(classify(null, 20e3), 'idle');
  const two = (state, idleMs, cwd = '/a') => ({ agent: 'codex', cwd, project: 'a', state, input: 1, output: 1, turns: 1, idleMs });
  const g = alive([two('idle', 9), two('waiting', 5, '/b'), two('working', 1), two('idle', 3, '/c')], new Set(['/a', '/b']));
  assert.deepEqual(g.map((x) => [x.cwd, x.idleMs]), [['/a', 1], ['/a', 9], ['/b', 5]]); // /c 는 죽었고, /a 가 최근이라 먼저
  assert.equal(topicOf('<system-reminder>x</system-reminder>'), null);
  assert.equal(topicOf('  그리고 슬라임 고쳐줘, 핑크로\n두번째 줄'), '슬라임 고쳐줘');
  assert.equal(topicOf('[Request interrupted by user]'), null);
  const { sessions: list, usage } = readAgents();
  console.table(list);
  console.log(usage);
  console.log('ok');
}
