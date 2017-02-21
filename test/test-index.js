require('../lib/index');
// const { Cc, Ci } = require('chrome');

const tabs = require('sdk/tabs');
const { setTimeout } = require('sdk/timers');
const { viewFor } = require('sdk/view/core');
const { browserWindows } = require('sdk/windows');
const { when: onUnload } = require('sdk/system/unload');

const { startServerAsync } = require('./httpd');
const { panel, showView, config, storeSeenHost } = require('../lib/ui');

// we can't use an anchor or else we'll get a warning
config.useAnchor = false;

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

function panelAssert(assert, condition) {
  panel.port.emit('run-test-script',
    `{
      let tmp = false;
      try {
        tmp = ${condition};
      } catch (e) {
      }
      port.emit('test-output', tmp)
    }`);

  return new Promise(resolve => {
    panel.port.once('test-output', val => {
      assert.ok(val, condition);
      resolve();
    });
  });
}

function panelScript(assert, script) {
  panel.port.emit('run-test-script',
    `try {
      ${script}; port.emit("script-done", null);
    } catch (e) {
      port.emit("script-done", e.stack);
    }`);
  return new Promise(resolve => {
    panel.port.once('script-done', (err) => {
      assert.ok(!err, err || "no error");
      resolve();
    });
  });
}

function sleep(millis) {
  return new Promise(resolve => setTimeout(resolve, millis));
}

function tabReady(tab) {
  return new Promise(resolve => tab.once('ready', resolve));
}

async function clickPanelElement(assert, id) {
  await panelScript(assert, `document.getElementById('${id}').click()`);
}

async function panelAssertElementShowing(assert, id) {
  await panelAssert(assert, `!document.getElementById("${id}").hidden`);
}

function asyncTest(name, cb) {
  exports[name] = (assert, done) => cb(assert).then(done);
}

asyncTest("test about:addons", async function(assert) {
  const chromeGlobal = viewFor(browserWindows.activeWindow);

  chromeGlobal.openNewTabWith("about:addons");
  await sleep(500);
  chromeGlobal.switchToTabHavingURI("about:addons");
  await sleep(100);
  chromeGlobal.gBrowser.removeCurrentTab();
  await sleep(100);
});

asyncTest("test showView", async function (assert) {
  const chromeGlobal = viewFor(browserWindows.activeWindow);

  const tab = await new Promise(resolve => tabs.open({
    url: 'about:home',
    onOpen(tab) { resolve(tab); }
  }));

  await tabReady(tab);
  panel.port.emit('run-test-script', 'port.emit("having-problems", "yes")');
  await sleep(100);
  await panelAssertElementShowing(assert, 'ef-tell-us-more');

  panel.port.emit('run-test-script', 'port.emit("having-problems", "yes")');
  await sleep(100);
  await panelAssertElementShowing(assert, 'ef-tell-us-more');

  panel.hide();
  await sleep(100);

  tab.close();
});

asyncTest("test ui workflows", async function(assert) {
  const chromeGlobal = viewFor(browserWindows.activeWindow);
  const doc = chromeGlobal.document;

  const tab = await new Promise(resolve => tabs.open({
    url: 'http://localhost:2000/testFlashDoc',
    onOpen(tab) { resolve(tab); }
  }));

  await tabReady(tab);
  chromeGlobal.BrowserReload();

  await tabReady(tab);
  await panelAssertElementShowing(assert, 'ef-having-problems');
  await clickPanelElement(assert, 'having-problems-no');
  await sleep(100);

  storeSeenHost(chromeGlobal, false);
  chromeGlobal.BrowserReload();

  await tabReady(tab);
  await panelAssertElementShowing(assert, 'ef-having-problems');
  await clickPanelElement(assert, 'having-problems-yes');

  await panelAssertElementShowing(assert, 'ef-tell-us-more');

  await sleep(100);
  await clickPanelElement(assert, 'video-broken');
  await clickPanelElement(assert, 'tell-us-more-submit');

  await sleep(100);
  await panelAssertElementShowing(assert, 'ef-tell-us-more-detail');

  await clickPanelElement(assert, 'tell-us-more-detail-submit');
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
  await panelAssertElementShowing(assert, 'ef-tell-us-more');

  await clickPanelElement(assert, 'video-broken');
  await clickPanelElement(assert, 'tell-us-more-submit');

  await sleep(100);
  await panelAssertElementShowing(assert, 'ef-tell-us-more-detail');

  await clickPanelElement(assert, 'tell-us-more-detail-submit');
  await sleep(100);

  assert.ok(!panel.isShowing);
  ctpNotification = doc.getElementById('click-to-play-plugins-notification');
  const allowNow = doc.getAnonymousElementByAttribute(ctpNotification,
                                                      'anonid',
                                                      'secondarybutton');
  allowNow.click();

  await sleep(100);
  await panelAssertElementShowing(assert, 'ef-has-activating-solved');

  config.tellUsMoreAfterHasThisSolvedTimeout = 0;
  storeSeenHost(chromeGlobal, false);
  await clickPanelElement(assert, 'has-activating-solved-yes');
  await sleep(100);

  await panelAssertElementShowing(assert, 'ef-tell-us-more');
  await clickPanelElement(assert, 'video-broken');
  await clickPanelElement(assert, 'tell-us-more-submit');

  await sleep(100);
  await panelAssertElementShowing(assert, 'ef-tell-us-more-detail');

  await clickPanelElement(assert, 'tell-us-more-detail-submit');
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
  await panelAssertElementShowing(assert, 'ef-has-deactivating-solved');

  await clickPanelElement(assert, 'has-activating-solved-no');
  await sleep(100);  

  tab.close();
});

require('sdk/test').run(exports);
