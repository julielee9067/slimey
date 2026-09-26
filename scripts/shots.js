// README 용 슬라임 캡처. 실제 렌더러를 띄워 포즈·상태를 넣고 창을 PNG 로 찍는다.  npx electron scripts/shots.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'docs');
const pr = (title, repo = 'team/service', status = 'pending') => ({ title, repo, url: '#', author: 'me', created: Date.now(), stale: false, status });
const sess = (state, project, topic, model = 'claude-fable-5-1') => ({ agent: 'claude', cwd: `/w/${project}`, project, topic, model, state, input: 12.3e6, output: 210e3, turns: 17, idleMs: 0 });
const usage = { claude: { today: { input: 18.3e6, output: 280e3 }, month: { input: 1.09e9, output: 6.1e6 } }, codex: { today: { input: 0, output: 0 }, month: { input: 128e6, output: 630e3 } } };
const limits = { claude: { at: Date.now(), windows: [{ label: '5시간', pct: 18, resetsAt: Date.now() + 3e6 }, { label: '7일', pct: 13, resetsAt: Date.now() + 4e8 }] }, codex: { at: Date.now(), windows: [{ label: '크레딧', pct: 100, resetsAt: Date.now() + 7e8 }] } };
const base = { prs: { requested: [], changes: [], approved: [], mine: [] }, sessions: [], usage, limits };

// [파일명, 상태, 추가로 덮어쓸 포즈]
const SHOTS = [
  ['neutral', base],
  ['working', { ...base, sessions: [sess('working', 'slimey', '슬라임 UI 스타일'), sess('working', 'api', 'LOGG-165')] }],
  ['waiting', { ...base, sessions: [sess('waiting', 'slimey', '슬라임 UI 스타일')] }, 'wink'],
  ['envelopes', { ...base, prs: { ...base.prs, requested: [pr('a'), pr('b'), pr('c')] } }],
  ['sad', { ...base, prs: { ...base.prs, changes: [pr('fix')], mine: [pr('fix', 'team/service', 'changes')] } }],
  ['heart', base, 'heart'],
  ['pressed', base, 'flat'],
  ['dragging', base, 'lift'],
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 300, height: 170, show: false, transparent: true, frame: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload.js') },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  win.showInactive();
  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(400);
  for (const [name, state, extra] of SHOTS) {
    await js(`seq = 1; render(${JSON.stringify(state)}); seq = 0; pose(mood);`); // seq 로 잔동작 잠금
    if (extra) await js(`seq = 1; pose('${extra}');`);
    await wait(450);
    fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    await js('seq = 0;');
  }
  // 목록이 열린 모습
  win.setSize(300, 620);
  await js(`seq = 1; render(${JSON.stringify({ ...base, prs: { ...base.prs, requested: [pr('feat: 결제 재시도 큐', 'team/payments'), pr('fix: 타임아웃 상향', 'team/gateway')], mine: [pr('feat: 핑크 슬라임', 'julie/slimey'), pr('chore: 로그 정리', 'julie/tools', 'approved')] }, sessions: [sess('working', 'slimey', '슬라임 UI 스타일'), sess('waiting', 'api', 'LOGG-165', 'claude-sonnet-5')] })}); pose(mood); list.hidden = false;`);
  await wait(500);
  fs.writeFileSync(path.join(OUT, 'list.png'), (await win.webContents.capturePage()).toPNG());
  console.log('wrote', fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).join(', '));
  app.quit();
});
