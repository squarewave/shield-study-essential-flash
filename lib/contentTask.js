const { data } = require('sdk/self');
const { viewFor } = require('sdk/view/core');
const { browserWindows } = require('sdk/windows');
const { Services } = viewFor(browserWindows.activeWindow);

const gPromises = new Map();

let gFrameScriptLoaded = false;
let gMessageId = 1;

module.exports = {
  spawn(browser, arg, task) {
    if (!gFrameScriptLoaded) {
      Services.mm.loadFrameScript(data.url('contentTask.js'), true);

      Services.mm.addMessageListener('ps-content-task:complete', (msg) => {
        const { id, error, result } = msg.data;

        let deferred = gPromises.get(id);
        gPromises.delete(id);

        if (error) {
          deferred.reject(error);
        } else {
          deferred.resolve(result);
        }
      });

      gFrameScriptLoaded = true;
    }

    const deferred = {};
    deferred.promise = new Promise((resolve, reject) => {
      deferred.resolve = resolve;
      deferred.reject = reject;
    });

    const id = gMessageId++;
    gPromises.set(id, deferred);

    browser.messageManager.sendAsyncMessage(
      'ps-content-task:spawn',
      {
        id: id,
        runnable: task.toString(),
        arg: arg,
      });

    return deferred.promise;
  }
};
