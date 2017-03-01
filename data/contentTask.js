// NOTE: this file was copied, with edits, from:
// https://hg.mozilla.org/mozilla-central/file/tip/testing/mochitest/BrowserTestUtils/content/content-task.js

addMessageListener('ps-content-task:spawn', {
  receiveMessage(msg) {
    const id = msg.data.id;
    const source = msg.data.runnable || '()=>{}';

    const runnablestr = `
      (() => {
        return (${source});
      })();`

    try {
      const runnable = eval(runnablestr);
      const val = runnable.call(this, msg.data.arg);
      sendAsyncMessage('ps-content-task:complete', {
        id: id,
        result: val,
      });
    } catch (e) {
      sendAsyncMessage('ps-content-task:complete', {
        id: id,
        error: e.toString(),
      });
    }
  }
});
