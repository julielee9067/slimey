const slime = document.getElementById('slime');
const hit = document.getElementById('hit'); // 몸통 모양의 클릭 영역
const face = document.getElementById('face');
const envelopes = document.getElementById('envelopes');
const count = document.getElementById('count');
const fx = document.getElementById('fx');
const list = document.getElementById('list');
const badge = document.getElementById('badge');
// 같은 페이지를 두 창이 쓴다: 슬라임 창과 목록 창(?list). 목록 창은 슬라임을 숨기고 잔동작도 돌리지 않는다
const LIST_MODE = new URLSearchParams(location.search).has('list');
document.body.classList.toggle('is-list', LIST_MODE);

let prevApproved = 0;
let sighTimer = null;
let tab = 'claude'; // 세션 탭: claude | codex
let last = null; // 마지막 state. 탭을 바꿔도 다시 그릴 수 있게
const total = (u) => u.input + u.output;

const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const NAME = { claude: 'Claude', codex: 'Codex' };
const when = (ms) => (ms ? new Date(ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
// 포즈: pink_slime_frames 각 프레임에서 뽑은 파라미터. 빠진 값은 기본(E1). CSS transition 이 사이를 채운다.
const POSE = {
  neutral: {},
  waiting: {},                                                                   // 내 차례: 눈 뜬 기본. 잔동작에서 윙크로 재촉
  lookup: { ey: -14, esy: 11 / 13 },                                             // E9
  surprised: { esx: 1.5, esy: 12 / 13, eyes: 'dot' },                            // E5
  sad: { eyes: 'sad' },                                                          // E8
  heavy: { sx: 1.3, sy: .6, shx: 1.17, shy: 1.12, sho: .32, esy: 9 / 13 },       // Q2
  flat: { sx: 1.52, sy: .42, shx: 1.33, shy: 1.25, sho: .36, esy: 6 / 13 },      // Q3
  rebound: { sx: .92, sy: 1.1, shx: .93, esx: 1.5, esy: 12 / 13, eyes: 'dot' },  // Q4
  squash: { sx: 1.16, sy: .8, shx: 1.09, esy: 11 / 13 },                         // B2
  launch: { ty: -44, sx: .88, sy: 1.18, shx: .8, sho: .2, esy: 15 / 13 },        // B3
  apex: { ty: -96, sy: 1.02, shx: .63, sho: .12, eyes: 'happy' },                // B4
  land: { sx: 1.24, sy: .72, shx: 1.15, sho: .32, esy: 6 / 13 },                 // B5
  heart: { eyes: 'heart' },                                                      // E10
  blink: { eyes: 'line' },                                                       // E3
  leanL: { sk: -9, ex: -12, ey: 2 },                                             // W1
  leanR: { sk: 9, ex: 12, ey: 2 },                                               // W3
  happy: { eyes: 'happy' },                                                      // E2
  sleepy: { eyes: 'sleepy' },                                                    // E4
  wink: { eyes: 'wink', sk: 3 },                                                 // E6
  annoyed: { eyes: 'annoyed' },                                                  // E7
  lift: { sx: .8, sy: 1.28, shx: .7, sho: .18, ey: -8, esy: 17 / 13 },           // T3: 들려서 위로 늘어남. 기울기는 드래그 방향에서
};
// 한가할 때 랜덤으로 하나. [포즈, ms] 시퀀스
const IDLE_ACTS = [
  [['blink', 130]], [['blink', 130]], [['blink', 110], ['neutral', 120], ['blink', 110]],
  [['happy', 900]], [['heart', 1000]], [['sleepy', 1400]], [['wink', 700]], [['annoyed', 800]],
  [['lookup', 900]], [['leanL', 500], ['leanR', 500]], [['leanR', 600]],
  [['squash', 120], ['launch', 140], ['land', 120], ['squash', 90]],           // 깡총
];
const UNIT = { sk: 'deg', ex: 'px', ey: 'px' }; // ty 는 viewBox 단위 그대로(CSS 에서 % 로 환산)
const DEFAULT = { ty: 0, sk: 0, sx: 1, sy: 1, shx: 1, shy: 1, sho: .2, ex: 0, ey: 0, esx: 1, esy: 1 };
let mood = 'neutral';
let seq = 0; // 진행 중인 시퀀스 id. 새 시퀀스가 시작되면 이전 것은 조용히 무시된다

function pose(name, extra = {}) {
  const p = { ...DEFAULT, ...POSE[name], ...extra };
  for (const k of Object.keys(DEFAULT)) slime.style.setProperty(`--${k}`, `${p[k]}${UNIT[k] || ''}`);
  face.dataset.eyes = p.eyes || 'open';
}

/** [포즈, ms] 를 차례로. 끝나면 mood 로 돌아온다(hold 면 마지막에 멈춤). */
function play(steps, { hold = false } = {}) {
  const id = ++seq;
  let t = 0;
  for (const [name, ms] of steps) { setTimeout(() => { if (id === seq) pose(name); }, t); t += ms; }
  if (!hold) setTimeout(() => { if (id === seq) { seq = 0; pose(mood); } }, t);
}

const FULL_TOKENS = 30e6; // 최근 8시간 세션 합계가 이만큼이면 색이 가장 진해진다 (캐시 읽기 포함이라 금방 큼)

function render(state) {
  const { prs, sessions } = state;
  const n = prs.requested.length;
  const working = sessions.filter((s) => s.state === 'working');
  const waiting = sessions.filter((s) => s.state === 'waiting'); // 내 차례인 세션. 작업 중인 게 있어도 따로 알린다
  const eaten = sessions.reduce((a, s) => a + s.input + s.output, 0);
  slime.style.setProperty('--food', Math.min(eaten / FULL_TOKENS, 1));

  // 몸: 봉투 수만큼 커지고, 3개부터 무거워서 납작해진다
  slime.style.setProperty('--size', 1 + Math.min(n, 6) * 0.07);
  // 표정: 수정 요청(슬픔) > 내 차례(기본 눈 + 가끔 윙크) > 작업 중(위를 봄, 배지 쪽) > 봉투 3개 이상(눌림) > 기본
  mood = prs.changes.length ? 'sad' : waiting.length ? 'waiting' : working.length ? 'lookup' : n >= 3 ? 'heavy' : 'neutral';
  if (!seq) pose(mood); // 시퀀스 중이면 끝날 때 알아서 돌아온다
  badge.hidden = !waiting.length;
  // 말풍선: 어느 세션이 내 차례인지. 여럿이면 가장 최근 것 + 외 N개
  const w = waiting[0];
  badge.textContent = w ? `${w.project} · ${w.topic || '(제목 없음)'}${waiting.length > 1 ? ` 외 ${waiting.length - 1}개` : ''}` : '';
  badge.title = waiting.map((s) => `${s.project} · ${s.topic || ''}`).join('\n');
  slime.classList.toggle('is-sweating', prs.changes.length > 0); // 슬픈 얼굴 + 땀

  envelopes.replaceChildren(...prs.requested.map((p) => {
    const e = document.createElement('span');
    e.className = 'env' + (p.stale ? ' is-stale' : '');
    e.textContent = '✉️';
    e.title = p.title;
    return e;
  }));

  // 작업 중인 세션 수: 우측 상단 배지
  count.hidden = !working.length;
  count.textContent = working.length;
  count.title = working.map((s) => `${s.project} · ${s.topic || ''}`).join('\n');

  // 승인이 늘면 하트 + 점프
  if (prs.approved.length > prevApproved) celebrate();
  prevApproved = prs.approved.length;

  clearInterval(sighTimer);
  sighTimer = n >= 3 ? setInterval(() => pop('💨', 30), 20e3) : null;

  last = state;
  renderList();
}

function celebrate() {
  // 웅크림 → 점프 → 정점(웃음) → 착지 → 하트 눈
  play([['squash', 130], ['launch', 120], ['apex', 280], ['land', 130], ['squash', 100], ['heart', 1800]]);
  for (let i = 0; i < 5; i++) setTimeout(() => pop('💗', (Math.random() - 0.5) * 80), 350 + i * 120);
}

function pop(text, dx) {
  const el = document.createElement('span');
  el.className = 'pop';
  el.textContent = text;
  el.style.setProperty('--dx', `${dx}px`);
  el.addEventListener('animationend', () => el.remove());
  fx.append(el);
}

function li(cls, html) {
  const el = document.createElement('li');
  el.className = cls;
  el.innerHTML = html;
  return el;
}

const STATUS = { pending: 'review', changes: 'changes', approved: 'approved' }; // 내 PR 상태 태그
const day = (ms) => new Date(ms).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }); // 9. 23.
function prItem(p, mark = '') {
  const el = li('', `${mark ? `<span class="tag is-${mark}">${mark}</span> ` : ''}<small>${p.repo}</small> ${p.title} <small class="date">${day(p.created)}</small>`);
  el.onclick = () => { window.api.open(p.url); toggleList(false); };
  return el;
}

function sessionItem(s) {
  // 1줄 제목, 2줄 모델, 3줄 토큰·턴
  const el = li(`sess is-${s.state}`,
    `${s.model ? `<div class="meta"><code>${s.model}</code></div>` : ''}<div class="meta">입력 ${fmt(s.input)} · 출력 ${fmt(s.output)} · ${s.turns}턴</div>`);
  const t = document.createElement('span'); t.className = 'topic'; t.textContent = s.topic || '(제목 없음)'; el.prepend(t); // 사용자 텍스트는 textContent 로
  if (s.pid) {
    const x = document.createElement('button'); x.className = 'kill'; x.textContent = '×'; x.title = '세션 종료';
    x.onclick = (e) => { e.stopPropagation(); window.api.kill(s.pid); el.classList.add('is-dying'); };
    el.prepend(x);
  }
  return el;
}

function limitItem(w) {
  const el = li('usage', `<div>${w.label} <small>${w.resetsAt ? `${when(w.resetsAt)} 초기화` : ''}</small><b class="pct">${w.pct}%</b></div><div class="bar"><i></i></div>`);
  el.querySelector('.bar i').style.width = `${Math.min(100, w.pct)}%`; // CSP 가 인라인 style 속성을 막아서 JS 로
  el.classList.toggle('is-full', w.pct >= 90);
  return el;
}

function renderList() {
  const { prs, usage, limits } = last;
  const agents = Object.keys(NAME).filter((a) => last.on?.[a] ?? true); // 트레이 메뉴에서 켜둔 것만 탭으로
  if (!agents.includes(tab)) tab = agents[0];
  const sessions = last.sessions.filter((s) => s.agent === tab);
  const items = [];
  // 헤더 + 항목들. empty 가 null 이면 비어 있을 때 섹션을 통째로 숨긴다
  const section = (title, arr, item, empty = 'N/A') => {
    if (!arr.length && empty === null) return;
    items.push(li('head', title));
    if (!arr.length) items.push(li('empty', empty));
    items.push(...arr.map((x) => item(x))); // map 의 index 가 item 의 두 번째 인자로 새지 않게
  };

  section('Waiting for review', prs.requested, prItem, null);
  section('My open PRs', prs.mine, (p) => prItem(p, STATUS[p.status]), null);
  if (!tab) { list.replaceChildren(...items); return; } // 세션 감시를 다 꺼둔 경우

  // 탭: Claude 세션 / Codex 세션
  const tabs = li('tabs', agents.map((a) =>
    `<button class="tab${a === tab ? ' is-on' : ''}" data-tab="${a}">${NAME[a]}</button>`).join(''));
  tabs.onclick = (e) => { const t = e.target.dataset.tab; if (t) { tab = t; renderList(); } };
  items.push(tabs);
  if (!sessions.length) items.push(li('empty', 'N/A'));
  // repo 헤더 아래 세션을 하나씩. sessions 는 같은 repo 가 이웃하게 정렬돼 온다.
  let repo = null;
  for (const s of sessions) {
    if (s.cwd !== repo) { repo = s.cwd; items.push(li('repo', s.project)); }
    items.push(sessionItem(s));
  }

  // 구독 한도: API 가 주는 % 그대로. 없으면 못 가져온 것, 오래됐으면 기준 시각
  const lim = limits[tab];
  const stale = lim && Date.now() - lim.at > 15 * 60e3;
  section(`${NAME[tab]} 한도 사용률`, lim?.windows || [], limitItem, lim ? '' : 'Failed to fetch');
  if (stale) items.push(li('empty', `${when(lim.at)} 기준 (지금은 못 가져오는 중)`));

  // 로그에서 센 토큰 수
  const u = usage[tab];
  section(`${NAME[tab]} 토큰 사용량`, u ? ['today', 'month'] : [], (key) =>
    li('usage', `${key === 'today' ? '오늘' : '이번 달'} <b>${fmt(total(u[key]))}</b> <small>입력 ${fmt(u[key].input)} · 출력 ${fmt(u[key].output)}</small>`));
  list.replaceChildren(...items);
}

// 누르면 납작, 끌면 창이 따라오고, 거의 안 움직였으면 클릭 = 목록 토글
let drag = null;
/** 목록 열고 닫기(open 없으면 토글). 목록 창은 main 이 띄우고, 나타나는 동작은 CSS transition */
function toggleList(open) { window.api.list(open); }
window.api.onList((open) => list.classList.toggle('is-open', open));

hit.addEventListener('pointerdown', (e) => {
  window.api.stop(); // 날아가는 중이면 잡아서 멈춘다
  drag = { x: e.screenX, y: e.screenY, moved: 0, trail: [{ t: e.timeStamp, x: e.screenX, y: e.screenY }] };
  hit.setPointerCapture(e.pointerId);
  play([['heavy', 80], ['flat', 0]], { hold: true }); // 눌리면 두 단계로 납작. hold 라 놓을 때까지 seq 가 살아 있다
});
hit.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (e.buttons === 0) { release(e); return; } // 버튼이 이미 떨어져 있으면 pointerup 이 유실된 것. 지금 놓는다
  const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
  if ((dx || dy) && Number.isFinite(dx) && Number.isFinite(dy)) {
    window.api.move(dx, dy);
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.screenX; drag.y = e.screenY;
    // 최근 100ms 의 이동 기록으로 놓는 순간 속도를 잰다
    drag.trail.push({ t: e.timeStamp, x: e.screenX, y: e.screenY });
    while (drag.trail.length > 2 && e.timeStamp - drag.trail[0].t > 100) drag.trail.shift();
    // 끌리는 동안: 들려서 늘어나고, 움직이는 반대쪽으로 늘어진다
    pose('lift', { sk: Math.max(-14, Math.min(14, -dx * 1.2)) });
  }
});
function release(e) {
  if (!drag) return;
  const clicked = drag.moved < 4;
  const first = drag.trail[0]; // pointerdown 때 하나는 항상 들어 있다
  const dt = (e.timeStamp - first.t) / 1000;
  const [vx, vy] = dt > 0.02 ? [(e.screenX - first.x) / dt, (e.screenY - first.y) / dt] : [0, 0]; // px/s
  drag = null;
  if (clicked) toggleList();
  if (Math.hypot(vx, vy) > 350) { // 세게 놓았으면 던진다. 벽에 닿을 때마다 bounce 가 온다
    toggleList(false);
    window.api.throw(vx, vy);
    play([['launch', 0]], { hold: true });
    return;
  }
  // 클릭이면 튕김, 끌어다 놓았으면 착지 → 튕김. 둘 다 살짝 눌렸다가 제자리
  play(clicked ? [['rebound', 180], ['squash', 100]] : [['land', 140], ['rebound', 160], ['squash', 90]]);
}
hit.addEventListener('pointerup', release);
hit.addEventListener('pointercancel', release); // 시스템이 포인터를 가져가도 놓은 것으로
// 창이 움직이는 동안 macOS 가 마우스 추적을 끊어 hit 에 pointerup 이 안 올 수 있다. 어디서든 떨어지면 놓는다
window.addEventListener('pointerup', release, true);
window.addEventListener('blur', () => { if (drag) release({ timeStamp: performance.now(), screenX: drag.x, screenY: drag.y }); });
// 날아가다 벽에 닿으면 찌부 + 방울이 튄다(splash), 멈추면 표정 복귀.
// 세게(높은 데서) 부딪힐수록 더 납작하게, 더 오래, 더 많이 튄다. impact 는 벽에 수직인 속도(px/s).
const AWAY = { left: [1, 0], right: [-1, 0], top: [0, 1], bottom: [0, -1] }; // 벽에서 멀어지는 방향 [ax, ay]
const HARD = 1400; // 이 속도면 최대로 납작 (main 의 MAX_SPEED 와 같다)
window.api.onBounce((hit, impact = 0) => {
  if (hit === 'stop') { play([['land', 120], ['rebound', 150], ['squash', 90]]); return; }
  const [ax, ay] = AWAY[hit];
  const t = Math.min(1, Math.max(0.15, impact / HARD));
  const mix = (soft, hard) => soft + (hard - soft) * t;
  const id = seq; // 비행 중 hold 시퀀스. 그동안만 찌부를 덮어쓴다
  pose('launch', ax
    ? { sx: mix(.95, .62), sy: mix(1.05, 1.4), sk: ax * mix(4, 16), ex: ax * mix(3, 12) }      // 옆 벽: 가로로 눌리고 벽 반대쪽으로 기운다
    : { sx: mix(1.06, 1.55), sy: mix(.9, .4), shx: mix(1.02, 1.35), sho: mix(.22, .36), esy: mix(.95, .45) }); // 위아래: 세게 떨어질수록 flat(Q3)
  setTimeout(() => { if (seq === id) pose('launch'); }, mix(80, 170));
  splash([ax, ay], t);
});

/** 슬라임 조각이 벽 반대쪽으로 튀어 떨어진다. 세기 t(0~1)에 따라 3~10개, 0.6초 뒤 사라짐 */
function splash([ax, ay], t = 0.5) {
  const n = 3 + Math.round(7 * t);
  for (let i = 0; i < n; i++) {
    const el = document.createElement('span');
    el.className = 'drop';
    const spread = (Math.random() - 0.5) * 120;           // 벽을 따라 퍼지는 거리
    const out = (15 + Math.random() * 40) * (0.6 + t);      // 벽에서 튀어 나오는 거리. 세게 부딪히면 멀리
    const dx = ax * out + spread * Math.abs(ay), dy = ay * out + spread * Math.abs(ax) + 25; // 벽에 수직으로 out, 나란히 spread, 끝엔 살짝 아래로
    el.style.setProperty('--dx', `${dx}px`);
    el.style.setProperty('--dy', `${dy}px`);
    el.style.setProperty('--r', `${4 + Math.random() * 6}px`);
    el.style.left = `calc(50% + ${-ax * 34}px)`; // 벽에 닿은 쪽에서 출발
    el.style.bottom = `${40 - ay * 30}px`;
    el.addEventListener('animationend', () => el.remove());
    fx.append(el);
  }
}
// 내 차례일 때의 재촉: 윙크, 기울임, 둘 다
const WAIT_ACTS = [[['wink', 700]], [['wink', 700]], [['leanL', 450], ['leanR', 450]], [['wink', 500], ['leanR', 500]]];
const pick = (acts) => acts[Math.floor(Math.random() * acts.length)];

// 한가할 때의 잔동작: 4~12초마다 랜덤 표정 하나. 내 차례면 3~6초마다 재촉, 슬플 땐 가만히
// ponytail: 잔동작이 CPU 의 대부분(움직이는 동안 ~6%). 더 아끼려면 간격을 늘린다.
function idle() {
  if (!seq) { // 시퀀스(눌림 hold 포함) 중이면 건너뛴다
    if (mood === 'waiting') play(pick(WAIT_ACTS));
    else if (mood !== 'sad') play(pick(IDLE_ACTS));
  }
  setTimeout(idle, mood === 'waiting' ? 3000 + Math.random() * 3000 : 4000 + Math.random() * 8000);
}
if (!LIST_MODE) idle();
window.api.onState(render);
