// A test creation that tries every way out of its frame. The security check reads `window.results`.
const results = {};
const attempt = async (name, fn) => {
  try {
    results[name] = `NOT BLOCKED: ${String(await fn()).slice(0, 80)}`;
  } catch (e) {
    results[name] = `blocked (${e?.name ?? 'error'})`;
  }
};
const post = (msg) => parent.postMessage({ ats: 'bridge', v: 1, msg }, '*');
const host = await new Promise((resolve) => {
  addEventListener('message', function once(e) {
    if (e.data?.msg?.type === 'init') {
      removeEventListener('message', once);
      resolve(e.data.msg.data);
    }
  });
  post({ type: 'hello', sdkVersion: 'sneaky' });
});
const appOrigin = host && location.href.replace('//play.', '//app.').split('/c/')[0];

await attempt('cookies', () => document.cookie || 'empty');
await attempt('localStorage', () => {
  localStorage.setItem('x', '1');
  return 'wrote';
});
await attempt(
  'indexedDB',
  () =>
    new Promise((ok, no) => {
      const r = indexedDB.open('x');
      r.onsuccess = () => ok('opened');
      r.onerror = () => no(r.error);
    }),
);
await attempt('the app’s API', () =>
  fetch(`${appOrigin}/api/me`, { credentials: 'include' }).then((r) => r.status),
);
await attempt('another creation’s files', () =>
  fetch(`${location.origin}/c/someone-elses-token/index.html`).then((r) => r.status),
);
await attempt('the internet', () => fetch('https://example.com/').then((r) => r.status));
await attempt('reading the page around it', () => parent.document.title);
await attempt('navigating the page away', () => {
  top.location.href = 'https://example.com/';
  return 'asked';
});
await attempt('opening a pop-up', () => {
  const w = window.open('https://example.com/');
  if (!w) throw Object.assign(new Error('no window'), { name: 'Blocked' });
  return 'opened';
});
// Browsers refuse a sandboxed form quietly (no error): the check looks at where the frame is
// afterwards instead.
document.querySelector('form').submit();
// Pretend to be someone else: a message saying it's from another player, and a forged host message.
post({ type: 'mp:send', kind: 'chat', body: { from: 'someone-else', text: 'I am the Architect' } });
post({ type: 'become-architect' });
// Flood the host.
for (let i = 0; i < 5000; i++) post({ type: 'ui:toast', text: 'spam' });
results.identity = host.me.id;
window.results = results;
post({ type: 'ready' });
