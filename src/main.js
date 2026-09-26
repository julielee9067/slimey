const { app, BrowserWindow, Tray, Menu, ipcMain, screen, shell, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { fetchPRs } = require('./pr');
const { readAgents } = require('./agents');
const { fetchLimits } = require('./usage');

const SIZE = { width: 300, height: 170 };       // 슬라임 + 말풍선만. 던질 때 슬라임 머리가 곧 천장이 된다
const LIST = { height: 470, bottom: 130 };      // 목록은 별도 자식 창. 슬라임 창 바닥에서 bottom 만큼 위에 아랫변이 온다
const PR_POLL_MS = 60e3;
const LIMIT_POLL_MS = 5 * 60e3; // 한도 API 는 자주 치면 429. 실패하면 두 배씩 늦춘다 (최대 20분)
const AGENT_POLL_MS = 3e3;

let win, listWin, tray;
let state = { prs: { requested: [], changes: [], approved: [], mine: [] }, sessions: [], usage: {}, limits: {} };

// 트레이 메뉴에서 켜고 끄는 것들. 끄면 안 보이고 안 긁는다(1인 개발이면 리뷰 요청은 안 온다). userData/settings.json 에 저장.
const SETTINGS = path.join(app.getPath('userData'), 'settings.json');
const on = { claude: true, codex: true, requested: true, mine: true };
try { Object.assign(on, JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))); } catch { /* 첫 실행 */ }
const saveOn = () => fs.writeFileSync(SETTINGS, JSON.stringify(on));
const prsOn = () => on.requested || on.mine;

/** 렌더러·트레이에 보내는 상태: 꺼둔 것은 비운다. 원본 state 는 그대로 두어 다시 켜면 바로 돌아온다 */
function view() {
  const p = state.prs, z = [];
  return {
    ...state, on,
    prs: { requested: on.requested ? p.requested : z, mine: on.mine ? p.mine : z, changes: on.mine ? p.changes : z, approved: on.mine ? p.approved : z },
    sessions: state.sessions.filter((s) => on[s.agent]),
  };
}

app.disableHardwareAcceleration(); // GPU 프로세스 ~180MB → ~45MB. 투명 창도 소프트웨어 합성으로 문제없다
if (!app.requestSingleInstanceLock()) app.quit();

// 창 크기를 바꾸면 새 프레임이 오기 전까지 이전 그림이 왼쪽 위에 붙어 보여서 슬라임이 한 프레임 튄다.
// 그래서 슬라임 창은 고정하고 목록은 자식 창으로 띄운다(부모를 옮기면 같이 따라온다).
function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const mk = (opts, query) => {
    const w = new BrowserWindow({
      transparent: true, frame: false, resizable: false, hasShadow: false,
      skipTaskbar: true, alwaysOnTop: true, focusable: false, ...opts,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // 보이는 창이 없는 트레이 앱이라 렌더러 로그를 여기로 끌어와야 디버깅이 된다.
    w.webContents.on('console-message', (_e, level, msg, line, src) =>
      console[level >= 2 ? 'error' : 'log'](`[renderer] ${msg} (${path.basename(src || '')}:${line})`));
    w.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query });
    return w;
  };
  win = mk({ width: SIZE.width, height: SIZE.height, x: area.x + area.width - SIZE.width - 20, y: area.y + area.height - SIZE.height });
  listWin = mk({ width: SIZE.width, height: LIST.height, parent: win, show: false }, { list: 1 });
  if (process.argv.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach' });
}

function push() {
  if (!win || win.isDestroyed() || !tray || tray.isDestroyed()) return; // 종료 중에 타이머가 마지막으로 한 번 더 돈다
  const v = view();
  for (const w of [win, listWin]) w.webContents.send('state', v);
  refreshTray(v);
}

// 트레이: 슬라임 아이콘(내 차례 세션이 있으면 말풍선 달린 버전) + 리뷰 대기 수. 메뉴는 켜기/끄기 체크박스 + 종료.
const icon = (name) => nativeImage.createFromPath(path.join(__dirname, `${name}Template.png`)); // *Template 이라 다크/라이트 자동
const ICONS = { idle: icon('tray'), wait: icon('trayWait') };
function refreshTray(v) {
  const n = v.prs.requested.length;
  const waiting = v.sessions.some((s) => s.state === 'waiting');
  tray.setImage(ICONS[waiting ? 'wait' : 'idle']);
  tray.setTitle(n ? ` ${n}` : '');
}

async function pollPRs() {
  if (!prsOn()) return; // 둘 다 꺼져 있으면 gh 도 안 친다
  const prs = await fetchPRs();
  if (prs) { state.prs = prs; push(); }
}

let limitDelay = LIMIT_POLL_MS, limitTimer = null;
async function pollLimits() {
  clearTimeout(limitTimer); // 메뉴에서 켰을 때 바로 부르면 루프가 둘이 되지 않게
  const limits = await fetchLimits(on);
  // 실패(429 등)하면 마지막 값을 그대로 두고 다음 시도를 두 배 늦춘다. 성공하면 5분으로 복귀.
  for (const [agent, v] of Object.entries(limits)) if (v) state.limits[agent] = { ...v, at: Date.now() };
  limitDelay = Object.values(limits).some((v) => !v) ? Math.min(limitDelay * 2, 20 * 60e3) : LIMIT_POLL_MS;
  limitTimer = setTimeout(pollLimits, limitDelay);
  push();
}

function pollAgents() {
  const { sessions, usage } = readAgents();
  if (JSON.stringify([sessions, usage]) !== JSON.stringify([state.sessions, state.usage])) { Object.assign(state, { sessions, usage }); push(); }
}

// 던지기: 중력에 포물선을 그리며 날고, 벽·천장·바닥에 닿으면 그 축의 속도만 반전(입사각 = 반사각). 공기 마찰로 느려지고 바닥에선 굴러서 멈춘다.
// 창이 작아서 창 테두리가 곧 슬라임이다.
const THROW_SCALE = 0.5; // 손 속도의 이만큼만 (손은 빠르다)
const MAX_SPEED = 1400;  // px/s 상한
const GRAVITY = 1800;    // px/s²
const BOUNCE = 0.8;      // 벽 반사 때 남는 속도
const ROLL = 0.3;        // 바닥에 붙어 구를 때 초당 남는 가로 속도
const FRICTION = 0.85;   // 초당 남는 속도 비율 (0.85 = 1초 뒤 85%, 4~5초 굴러간다)
let fly = null;
function stopFlight() { if (fly) { clearInterval(fly); fly = null; } }

ipcMain.on('throw', (_e, vx, vy) => {
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) return;
  stopFlight();
  const k = THROW_SCALE * Math.min(1, MAX_SPEED / (Math.hypot(vx, vy) * THROW_SCALE || 1));
  vx *= k; vy *= k;
  const { width: w, height: h } = win.getBounds();
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const minX = area.x, maxX = area.x + area.width - w;
  const minY = area.y, maxY = area.y + area.height - h; // 창이 작아서 창 테두리 ≈ 슬라임
  let [px, py] = win.getPosition();
  let last = Date.now();
  fly = setInterval(() => {
    const now = Date.now();
    const dt = Math.min((now - last) / 1000, 0.05); // 프레임이 밀려도 벽을 뚫지 않게
    last = now;
    vy += GRAVITY * dt;
    px += vx * dt; py += vy * dt;
    let hit = null, impact = 0; // impact: 벽에 수직인 속도 성분. 렌더러가 이걸로 납작해지는 정도를 정한다
    if (px < minX) { px = minX; impact = -vx; vx = -vx * BOUNCE; hit = 'left'; }
    if (px > maxX) { px = maxX; impact = vx; vx = -vx * BOUNCE; hit = 'right'; }
    if (py < minY) { py = minY; impact = -vy; vy = -vy * BOUNCE; hit = 'top'; }
    let onFloor = false;
    if (py > maxY) {
      py = maxY; onFloor = true;
      if (vy > 120) { impact = vy; vy = -vy * BOUNCE; hit = 'bottom'; } else vy = 0; // 약하면 튕기지 않고 붙는다
    }
    const k = (onFloor ? ROLL : FRICTION) ** dt; vx *= k; vy *= k;
    win.setPosition(Math.round(px), Math.round(py));
    if (hit) win.webContents.send('bounce', hit, impact);
    if (onFloor && Math.abs(vx) < 25) { stopFlight(); win.webContents.send('bounce', 'stop'); }
  }, 16);
});

// 목록: 슬라임 머리 위에 자식 창을 띄운다. open 이 없으면 토글. 닫을 땐 CSS 가 사라지는 동안 기다렸다가 숨긴다
let hideTimer = null;
ipcMain.on('list', (_e, open = !listWin.isVisible()) => {
  clearTimeout(hideTimer);
  if (open) {
    const b = win.getBounds();
    listWin.setPosition(b.x, b.y + b.height - LIST.bottom - LIST.height);
    listWin.showInactive();
  } else hideTimer = setTimeout(() => listWin.hide(), 220);
  listWin.webContents.send('list', open);
});

ipcMain.on('open', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); }); // PR 클릭 → 브라우저

// 목록의 × → 그 세션 프로세스 종료. 목록에 있는 pid 만. SIGTERM 으로 안 죽으면 1.5초 뒤 SIGKILL. 죽으면 다음 pollAgents 에서 빠진다
ipcMain.on('kill', (_e, pid) => {
  if (!state.sessions.some((s) => s.pid === pid)) return;
  const sig = (name) => { try { process.kill(pid, name); } catch { /* 이미 없음 */ } };
  sig('SIGTERM');
  setTimeout(() => { sig('SIGKILL'); pollAgents(); }, 1500);
});
ipcMain.on('stop', stopFlight); // 날아가는 중에 잡으면 멈춘다. 창은 건드리지 않는다(setPosition 은 드래그 추적을 끊는다)

ipcMain.on('move', (_e, dx, dy) => {
  stopFlight();
  const [x, y] = win.getPosition();
  const nx = Math.round(x + dx), ny = Math.round(y + dy);
  if (Number.isFinite(nx) && Number.isFinite(ny)) win.setPosition(nx, ny); // NaN 이면 setPosition 이 예외를 던져 앱이 죽는다
});

app.whenReady().then(() => {
  app.dock?.hide();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true }); // .app 으로 띄우면 로그인 시 자동 실행
  createWindow();
  tray = new Tray(ICONS.idle);
  // 체크박스 항목: 끄면 목록·표정에서 빠지고, 켜면 바로 다시 긁어온다
  const toggle = (key, label, refetch) => ({
    label, type: 'checkbox', checked: on[key],
    click: (item) => { on[key] = item.checked; saveOn(); push(); if (item.checked) refetch(); },
  });
  tray.setContextMenu(Menu.buildFromTemplate([
    toggle('claude', 'Claude 세션', pollLimits),
    toggle('codex', 'Codex 세션', pollLimits),
    { type: 'separator' },
    toggle('requested', '리뷰 요청 받은 PR', pollPRs),
    toggle('mine', '내 PR', pollPRs),
    { type: 'separator' },
    { label: 'Slimey 종료', click: () => app.quit() },
  ]));
  refreshTray(view());
  pollPRs();
  setInterval(pollPRs, PR_POLL_MS);
  pollLimits();
  pollAgents();
  setInterval(pollAgents, AGENT_POLL_MS);
});

app.on('window-all-closed', () => {});
// TEMP TEST
if (process.env.SLIME_THROW) app.whenReady().then(() => setTimeout(() => {
  ipcMain.emit('throw', null, 1400, -1100);
  const t0 = Date.now(); const log = setInterval(() => { console.log('pos', Date.now() - t0, win.getPosition().join(','), fly ? 'flying' : 'stopped'); if (!fly || Date.now() - t0 > 6000) clearInterval(log); }, 250);
}, 2500));
