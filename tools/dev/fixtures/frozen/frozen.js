// A test creation that says it's ready, then locks up for good.
const post = (msg) => parent.postMessage({ ats: 'bridge', v: 1, msg }, '*');
addEventListener('message', (e) => {
  if (e.data?.msg?.type === 'init') {
    post({ type: 'ready' });
    setTimeout(() => {
      for (;;) {} // never returns
    }, 1500);
  }
});
post({ type: 'hello', sdkVersion: 'frozen' });
