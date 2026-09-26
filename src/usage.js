// 구독 한도 사용률. 로컬 로그엔 없고, 각 CLI 가 남긴 로그인 토큰으로 본 서비스 API 를 친다.
//  Claude : Keychain "Claude Code-credentials" → api.anthropic.com/api/oauth/usage  (5시간·7일 utilization %)
//  Codex  : ~/.codex/auth.json → chatgpt.com/backend-api/wham/usage  (rate_limit 창, 없으면 spend_control 크레딧)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function claude() {
  const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const token = JSON.parse(raw).claudeAiOauth.accessToken;
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
  });
  if (!res.ok) throw new Error(`claude usage ${res.status}`);
  const d = await res.json();
  // 응답의 모든 사용률 창을 보여준다. 모델별 창(Opus·Sonnet·Fable 등)은 키 이름이 그대로 라벨.
  const LABEL = { five_hour: '5시간', seven_day: '7일', seven_day_opus: '7일 Opus', seven_day_sonnet: '7일 Sonnet', seven_day_oauth_apps: '7일 앱' };
  // 이름 모르는 창(실험용 코드명)은 실제로 쓴 게 있을 때만 보여준다
  return Object.entries(d)
    .filter(([k, w]) => w && typeof w.utilization === 'number' && (LABEL[k] || w.utilization > 0))
    .map(([k, w]) => ({ label: LABEL[k] || k.replace(/_/g, ' '), pct: Math.round(w.utilization), resetsAt: w.resets_at ? Date.parse(w.resets_at) : null }));
}

async function codex() {
  const { tokens } = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'));
  const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
    headers: { Authorization: `Bearer ${tokens.access_token}`, 'ChatGPT-Account-Id': tokens.account_id },
  });
  if (!res.ok) throw new Error(`codex usage ${res.status}`);
  const d = await res.json();
  const out = [];
  for (const w of [d.rate_limit?.primary, d.rate_limit?.secondary]) {
    if (w) out.push({ label: w.window_minutes >= 1440 ? `${Math.round(w.window_minutes / 1440)}일` : `${Math.round(w.window_minutes / 60)}시간`, pct: Math.round(w.used_percent), resetsAt: w.resets_at * 1000 });
  }
  const sc = d.spend_control?.individual_limit;
  if (sc) out.push({ label: '크레딧', pct: Math.round(sc.used_percent), resetsAt: sc.reset_at * 1000 });
  return out;
}

/** { claude: {windows:[{label, pct, resetsAt}]} | null, codex: ... } — 못 가져오면 null(호출 쪽이 이전 값을 유지). on 에서 꺼진 것은 키 자체가 없다. */
async function fetchLimits(on = { claude: true, codex: true }) {
  const out = {};
  await Promise.all(Object.entries({ claude, codex }).filter(([k]) => on[k]).map(async ([k, f]) => {
    try { out[k] = { windows: await f() }; } catch (err) { console.error('[usage]', err.message); out[k] = null; }
  }));
  return out;
}

module.exports = { fetchLimits };

if (require.main === module) fetchLimits().then((r) => console.log(JSON.stringify(r, null, 1)));
