const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-audio-test-'));
process.env.AUDIO_CACHE_DIR = cacheDir;

const fakeYtDlp = path.join(cacheDir, 'fake-yt-dlp');
fs.writeFileSync(fakeYtDlp, `#!/usr/bin/env node
const fs = require('node:fs');
const outputIndex = process.argv.indexOf('-o');
if (outputIndex < 0) process.exit(2);
const content = Buffer.alloc(512 * 1024, 173);
fs.writeFileSync(process.argv[outputIndex + 1], content);
setTimeout(() => process.exit(0), 150);
`);
fs.chmodSync(fakeYtDlp, 0o700);
process.env.YT_DLP_PYTHON = fakeYtDlp;

const videoId = 'testAudio01';
const fixture = Buffer.alloc(256 * 1024);
for (let index = 0; index < fixture.length; index += 1) fixture[index] = index % 251;
fs.writeFileSync(path.join(cacheDir, `${videoId}.m4a`), fixture);

const { startServer, parseByteRange } = require('../server');
let server;
let baseUrl;

test.before(async () => {
    server = startServer(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(cacheDir, { recursive: true, force: true });
});

test('parses standard and suffix byte ranges', () => {
    assert.deepEqual(parseByteRange('bytes=10-19', 100), { start: 10, end: 19, partial: true });
    assert.deepEqual(parseByteRange('bytes=-10', 100), { start: 90, end: 99, partial: true });
    assert.equal(parseByteRange('bytes=100-101', 100), null);
    assert.equal(parseByteRange('bytes=0-1,4-5', 100), null);
});

test('publishes a cache miss atomically and reuses it', async () => {
    const missId = 'cacheMiss01';
    const finalPath = path.join(cacheDir, `${missId}.m4a`);
    const responsePromise = fetch(`${baseUrl}/api/stream/${missId}`);

    const tempDeadline = Date.now() + 1000;
    let tempFiles = [];
    while (Date.now() < tempDeadline) {
        tempFiles = fs.readdirSync(cacheDir).filter(name => name.startsWith(`${missId}.m4a.`) && name.endsWith('.tmp'));
        if (tempFiles.length) break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(tempFiles.length, 1);
    assert.equal(fs.existsSync(finalPath), false);

    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-audio-cache'), 'MISS');
    assert.equal((await response.arrayBuffer()).byteLength, 512 * 1024);
    assert.equal(fs.existsSync(finalPath), true);
    assert.equal(fs.readdirSync(cacheDir).some(name => name.endsWith('.tmp')), false);

    const cachedResponse = await fetch(`${baseUrl}/api/stream/${missId}`, {
        headers: { Range: 'bytes=0-1023' }
    });
    assert.equal(cachedResponse.status, 206);
    assert.equal(cachedResponse.headers.get('x-audio-cache'), 'HIT');
    assert.equal((await cachedResponse.arrayBuffer()).byteLength, 1024);
});

test('serves a complete cached audio file', async () => {
    const response = await fetch(`${baseUrl}/api/stream/${videoId}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('content-length'), String(fixture.length));
    assert.equal(response.headers.get('x-audio-cache'), 'HIT');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixture);
});

test('serves an exact byte range with complete headers', async () => {
    const response = await fetch(`${baseUrl}/api/stream/${videoId}`, {
        headers: { Range: 'bytes=1024-8191' }
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes 1024-8191/${fixture.length}`);
    assert.equal(response.headers.get('content-length'), '7168');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixture.subarray(1024, 8192));
});

test('serves a suffix range', async () => {
    const response = await fetch(`${baseUrl}/api/stream/${videoId}`, {
        headers: { Range: 'bytes=-512' }
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${fixture.length - 512}-${fixture.length - 1}/${fixture.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixture.subarray(fixture.length - 512));
});

test('rejects an unsatisfiable range with 416', async () => {
    const response = await fetch(`${baseUrl}/api/stream/${videoId}`, {
        headers: { Range: `bytes=${fixture.length}-` }
    });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), `bytes */${fixture.length}`);
    assert.equal(response.headers.get('content-length'), '0');
});

test('supports HEAD without sending a body', async () => {
    const response = await fetch(`${baseUrl}/api/stream/${videoId}`, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(fixture.length));
    assert.equal((await response.arrayBuffer()).byteLength, 0);
});
