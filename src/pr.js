// PR 소스: gh CLI 로 GitHub 검색 API 를 친다. 토큰 관리는 gh 에 맡긴다.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// 프로젝트 루트의 .env (있으면) → process.env. 셸 env 가 우선. 라이브러리 없이 KEY=VALUE 만 읽는다. npm run build 하면 .app 안에 같이 들어간다
try {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch { /* .env 없음 */ }

const GH_HOST = process.env.GH_HOST || 'github.com';
const STALE_HOURS = 48;

function gh(query) {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      ['api', `search/issues?q=${encodeURIComponent(query)}&per_page=30`],
      { env: { ...process.env, GH_HOST } },
      (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout).items))
    );
  });
}

/** requested: 내가 리뷰어로 지정된 남의 PR(draft 제외) · changes/approved: 내 PR 중 수정 요청/승인 · mine: 내 열린 PR 전부(status 포함). 실패하면 null. */
async function fetchPRs() {
  try {
    const [requested, changes, approved, mine] = await Promise.all([
      gh('is:pr is:open review-requested:@me -is:draft'),
      gh('is:pr is:open author:@me review:changes_requested'),
      gh('is:pr is:open author:@me review:approved'),
      gh('is:pr is:open author:@me'),
    ]);
    const now = Date.now();
    const pick = (p) => ({
      title: p.title,
      url: p.html_url,
      author: p.user.login,
      repo: p.repository_url.split('/').slice(-2).join('/'),
      created: Date.parse(p.created_at),
      stale: now - Date.parse(p.updated_at) > STALE_HOURS * 3600e3,
    });
    const has = (list, p) => list.some((q) => q.html_url === p.html_url);
    return {
      requested: requested.map(pick),
      changes: changes.map(pick),   // 수정 요청 받은 내 PR (땀)
      approved: approved.map(pick), // 승인됐는데 아직 열려 있는 내 PR (하트)
      // 내 열린 PR 전부. status 로 목록에 표시
      mine: mine.map((p) => ({ ...pick(p), status: has(changes, p) ? 'changes' : has(approved, p) ? 'approved' : 'pending' })),
    };
  } catch (err) {
    console.error('[pr]', err.message);
    return null;
  }
}

module.exports = { fetchPRs };

if (require.main === module) {
  fetchPRs().then((r) => console.log(JSON.stringify(r, null, 1)));
}
