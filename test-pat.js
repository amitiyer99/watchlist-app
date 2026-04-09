// Usage: node test-pat.js ghp_yourtoken
const https = require('https');
const token = process.argv[2];
if (!token || !token.startsWith('ghp_')) {
  console.log('Usage: node test-pat.js ghp_yourtoken');
  process.exit(1);
}

function apiGet(path) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'api.github.com',
      path,
      headers: { Authorization: 'token ' + token, 'User-Agent': 'watchlist-app', Accept: 'application/vnd.github.v3+json' }
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    }).on('error', reject);
  });
}

function apiPut(path, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req = https.request({
      hostname: 'api.github.com', path, method: 'PUT',
      headers: { Authorization: 'token ' + token, 'User-Agent': 'watchlist-app', 'Content-Type': 'application/json', Accept: 'application/vnd.github.v3+json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

(async () => {
  console.log('Testing PAT against amitiyer99/watchlist-app...\n');

  // 1. Read user-alerts.json
  const get = await apiGet('/repos/amitiyer99/watchlist-app/contents/user-alerts.json');
  if (get.status !== 200) {
    console.log('READ FAILED (' + get.status + '):', get.body.message);
    console.log('\nPossible issues:');
    if (get.status === 401) console.log(' - Token is invalid or expired');
    if (get.status === 403) console.log(' - Token lacks Contents: Read permission');
    if (get.status === 404) console.log(' - Repo not found or token has no access to it');
    process.exit(1);
  }
  console.log('READ OK  - user-alerts.json found (sha: ' + get.body.sha.slice(0, 8) + ')');

  // 2. Write back same content to verify write permission
  const put = await apiPut('/repos/amitiyer99/watchlist-app/contents/user-alerts.json', {
    message: 'test: verify PAT write access [skip ci]',
    content: get.body.content,
    sha: get.body.sha
  });
  if (put.status === 200 || put.status === 201) {
    console.log('WRITE OK - token has Read+Write access\n');
    console.log('Your token works! Paste it into the blue PAT bar on your dashboard page.');
  } else {
    console.log('WRITE FAILED (' + put.status + '):', put.body.message);
    console.log('\nToken has Read but NOT Write. Re-generate with Contents: Read and Write permission.');
  }
})();
