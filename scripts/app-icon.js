// 앱(독·Finder) 아이콘. 실제 렌더러의 슬라임을 1024px 로 찍고 iconutil 로 build/icon.icns 를 만든다.  npx electron scripts/app-icon.js
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const OUT = path.join(__dirname, '..', 'build');
const SET = path.join(OUT, 'icon.iconset');

app.whenReady().then(async () => {
  // 레티나면 창은 512 로 잡아도 캡처는 1024. 1024 논리 픽셀 창은 노트북 화면보다 커서 잘린다
  const W = Math.round(1024 / screen.getPrimaryDisplay().scaleFactor);
  // 몸통+그림자(viewBox 64~256 × 66~258)가 캔버스의 80% 를 차지하도록 SVG 상자를 키우고 가운데 맞춤
  const S = Math.round(W * 1.33), TOP = W / 2 - S * (162 / 320);
  const win = new BrowserWindow({
    width: W, height: W, show: false, transparent: true, frame: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload.js') },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  win.showInactive();
  await win.webContents.executeJavaScript(`
    document.getElementById('stage').style.cssText = 'inset:0;height:auto';
    slime.style.cssText = 'width:${S}px;height:${S}px;top:${TOP}px;bottom:auto'; // left:50% + translateX(-50%) 는 그대로 두고 가운데 맞춤
    seq = 1; pose(mood); // 잔동작 잠금
    for (const el of document.querySelectorAll('.sweat, .badge, #envelopes, #fx')) el.style.display = 'none';
  `);
  await new Promise((r) => setTimeout(r, 500));
  const png = (await win.webContents.capturePage()).toPNG();
  fs.rmSync(SET, { recursive: true, force: true });
  fs.mkdirSync(SET, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'icon.png'), png);
  for (const n of [16, 32, 128, 256, 512]) {
    execFileSync('sips', ['-z', String(n), String(n), path.join(OUT, 'icon.png'), '--out', path.join(SET, `icon_${n}x${n}.png`)], { stdio: 'ignore' });
    execFileSync('sips', ['-z', String(n * 2), String(n * 2), path.join(OUT, 'icon.png'), '--out', path.join(SET, `icon_${n}x${n}@2x.png`)], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', SET, '-o', path.join(OUT, 'icon.icns')]);
  fs.rmSync(SET, { recursive: true });
  console.log('wrote build/icon.png, build/icon.icns');
  app.quit();
});
