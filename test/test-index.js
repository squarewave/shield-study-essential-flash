require('../lib/index');
// const { Cc, Ci } = require('chrome');

const tabs = require('sdk/tabs');
const { setTimeout } = require('sdk/timers');
const { viewFor } = require('sdk/view/core');
const { browserWindows } = require('sdk/windows');
const { when: onUnload } = require('sdk/system/unload');

const { startServerAsync } = require('./httpd');
const { panel, showView } = require('../lib/ui');

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
      assert.ok(!err, err);
      resolve();
    });
  });
}

function sleep(millis) {
  return new Promise(resolve => setTimeout(resolve, millis));
}

async function testWorkflows(assert) {
  const chromeGlobal = viewFor(browserWindows.activeWindow);
  const doc = chromeGlobal.document;

  const tab = await new Promise(resolve => tabs.open({
    url: 'http://localhost:2000/testFlashDoc',
    onOpen(tab) { resolve(tab); }
  }));

  await new Promise(resolve => tab.once('ready', resolve));

  const pluginBrick = doc.getElementById('plugins-notification-icon');
  pluginBrick.click();
  await sleep(100);

  const ctpNotification = doc.getElementById('click-to-play-plugins-notification');
  const link = doc.getAnonymousElementByAttribute(ctpNotification,
                                                  'anonid',
                                                  'click-to-play-plugins-notification-link');

  await sleep(100);
  link.click();

  await sleep(100);
  await panelAssert(assert, '!document.getElementById("ef-tell-us-more").hidden');

  await panelScript(assert, 'document.getElementById("video-broken").click()');
  await panelScript(assert, 'document.getElementById("tell-us-more-submit").click()');

  await sleep(100);
  await panelAssert(assert, '!document.getElementById("ef-tell-us-more-detail").hidden');

  tab.close();
}

exports['test workflows'] = function(assert, done) {
  testWorkflows(assert).then(done);
};

require('sdk/test').run(exports);
