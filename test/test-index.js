require('../lib/index');
// const { Cc, Ci } = require('chrome');

const tabs = require('sdk/tabs');
const { setTimeout } = require('sdk/timers');
const { viewFor } = require('sdk/view/core');
const { browserWindows } = require('sdk/windows');
const { when: onUnload } = require('sdk/system/unload');

const { startServerAsync } = require('./httpd');
const { panel, showView, config } = require('../lib/ui');
const { storeSeenHost } = require('../lib/utils');

// we can't use an anchor or else we'll get a warning
config.useAnchor = false;

let assert = null;

var srv = startServerAsync(2000);
onUnload(() => {
  srv.stop(() => {});
});

srv.registerPathHandler('/testFlashDoc', (req, res) => {
  res.write(`
<!DOCTYPE HTML>
<html>
<head>
  <title>Test Essential Flash</title>
</head>
<h1>Testing...</h1>
<body><object type="application/x-shockwave-flash"><embed src="not_here.swf"></object></body>
</html>
`);
});

let scriptId = 1;
let initialized = false;
const scriptPromises = new Map();

function panelScript(arg, cb) {
  if (!initialized) {
    initialized = true;
    panel.port.on('script-done', ({id, error, result, bob}) => {
      let deferred = scriptPromises.get(id);
      scriptPromises.delete(id);

      if (error) {
        deferred.reject(error);
      } else {
        deferred.resolve(result);
      }
    });
  }

  const script = cb.toString();
  const id = scriptId++;

  const deferred = { script, arg };
  deferred.promise = new Promise((resolve, reject) => {
    deferred.resolve = resolve;
    deferred.reject = reject;
  });

  scriptPromises.set(id, deferred);

  panel.port.emit('run-test-script', { script, id, arg });

  return deferred.promise;
}

async function panelAssert(arg, condition) {
  const result = await panelScript(arg, condition);
  assert.ok(result, condition.toString() + " (" + arg + ")");
}

function sleep(millis) {
  return new Promise(resolve => setTimeout(resolve, millis));
}

function tabReady(tab) {
  return new Promise(resolve => tab.once('ready', resolve));
}

async function clickPanelElement(id) {
  await panelScript(id, (id) => document.getElementById(id).click());
}

async function panelAssertElementShowing(id) {
  await panelAssert(id, (id) => !document.getElementById(id).hidden);
}

function asyncTest(name, cb) {
  exports[name] = (aAssert, done) => {
    assert = aAssert;
    cb(assert).then(done);
  };
}

asyncTest("test about:addons", async function() {
  const chromeGlobal = viewFor(browserWindows.activeWindow);

  chromeGlobal.openNewTabWith("about:addons");
  await sleep(500);
  chromeGlobal.switchToTabHavingURI("about:addons");
  await sleep(100);
  chromeGlobal.gBrowser.removeCurrentTab();
  await sleep(100);
});

asyncTest("test showView", async function () {
  const chromeGlobal = viewFor(browserWindows.activeWindow);

  const tab = await new Promise(resolve => tabs.open({
    url: 'about:home',
    onOpen(tab) { resolve(tab); }
  }));

  await tabReady(tab);
  await panelScript(null, () => port.emit('having-problems', 'yes'));
  await sleep(100);
  await panelAssertElementShowing('tell-us-more');

  await panelScript(null, () => port.emit('having-problems', 'yes'));
  await sleep(100);
  await panelAssertElementShowing('tell-us-more');

  panel.hide();
  await sleep(100);

  tab.close();
});

asyncTest("test ui workflows", async function() {
  const chromeGlobal = viewFor(browserWindows.activeWindow);
  const doc = chromeGlobal.document;

  const tab = await new Promise(resolve => tabs.open({
    url: 'http://localhost:2000/testFlashDoc',
    onOpen(tab) { resolve(tab); }
  }));

  await tabReady(tab);
  chromeGlobal.BrowserReload();

  await tabReady(tab);
  await sleep(100);
  await panelAssertElementShowing('having-problems');
  await clickPanelElement('having-problems-no');
  await sleep(100);

  storeSeenHost(chromeGlobal, false);
  chromeGlobal.BrowserReload();

  await tabReady(tab);
  await sleep(100);
  await panelAssertElementShowing('having-problems');
  await clickPanelElement('having-problems-yes');

  await panelAssertElementShowing('tell-us-more');

  await sleep(100);
  await clickPanelElement('video-broken');
  await clickPanelElement('tell-us-more-submit');

  await sleep(100);
  await panelAssertElementShowing('tell-us-more-detail');

  await clickPanelElement('tell-us-more-detail-submit');
  await sleep(100);

  assert.ok(!panel.isShowing);

  const pluginBrick = doc.getElementById('plugins-notification-icon');
  pluginBrick.click();
  await sleep(100);

  let ctpNotification = doc.getElementById('click-to-play-plugins-notification');
  const link = doc.getAnonymousElementByAttribute(ctpNotification,
                                                  'anonid',
                                                  'click-to-play-plugins-notification-link');

  await sleep(100);
  link.click();

  await sleep(100);
  await panelAssertElementShowing('tell-us-more');

  await clickPanelElement('video-broken');
  await clickPanelElement('tell-us-more-submit');

  await sleep(100);
  await panelAssertElementShowing('tell-us-more-detail');

  await clickPanelElement('tell-us-more-detail-submit');
  await sleep(100);

  assert.ok(!panel.isShowing);
  ctpNotification = doc.getElementById('click-to-play-plugins-notification');
  const allowNow = doc.getAnonymousElementByAttribute(ctpNotification,
                                                      'anonid',
                                                      'secondarybutton');
  allowNow.click();

  await sleep(100);
  await panelAssertElementShowing('has-activating-solved');

  config.tellUsMoreAfterHasThisSolvedTimeout = 0;
  storeSeenHost(chromeGlobal, false);
  await clickPanelElement('has-activating-solved-yes');
  await sleep(100);

  await panelAssertElementShowing('tell-us-more');
  await clickPanelElement('video-broken');
  await clickPanelElement('tell-us-more-submit');

  await sleep(100);
  await panelAssertElementShowing('tell-us-more-detail');

  await clickPanelElement('tell-us-more-detail-submit');
  await sleep(100);

  assert.ok(!panel.isShowing);

  await sleep(100);
  pluginBrick.click();

  await sleep(100);
  ctpNotification = doc.getElementById('click-to-play-plugins-notification');
  const continueAllowing = doc.getAnonymousElementByAttribute(ctpNotification,
                                                              'anonid',
                                                              'secondarybutton');
  continueAllowing.click();
  assert.ok(!panel.isShowing);


  await sleep(100);
  pluginBrick.click();

  await sleep(100);
  ctpNotification = doc.getElementById('click-to-play-plugins-notification');
  const blockPlugin = doc.getAnonymousElementByAttribute(ctpNotification,
                                                         'anonid',
                                                         'primarybutton');
  blockPlugin.click();

  await sleep(100);
  await panelAssertElementShowing('has-deactivating-solved');

  await clickPanelElement('has-activating-solved-no');
  await sleep(100);

  tab.close();
});

require('sdk/test').run(exports);
