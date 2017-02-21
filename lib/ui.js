/** ui.js **/
const { Ci } = require('chrome');

const { attachTo } = require('sdk/content/mod');
const localized = require('sdk/l10n').get;
const { data } = require('sdk/self');
const ss = require('sdk/simple-storage');
const { Style } = require('sdk/stylesheet/style');
const { setTimeout } = require('sdk/timers');
const { viewFor } = require('sdk/view/core');
const { browserWindows } = require('sdk/windows');
const { Panel } = require('sdk/panel');

const utils = require('./utils');

const { PLUGIN_ACTIVE } = Ci.nsIObjectLoadingContent;

const HAVING_PROBLEMS_HEIGHT = 150;
const HAS_ACTIVATING_SOLVED_HEIGHT = 206;

const config = {
  tellUsMoreAfterHasThisSolvedTimeout: 60 * 1000,
  useAnchor: true,
};

let ignoreActivatePluginOnce = false;

const panel = new Panel({
  width: 334,
  contentURL: data.url('popups.html'),
  contentScriptFile: data.url('popups.js'),
  contentStyleFile: data.url('popups.css'),
});

function submitTellUsMoreData(data) {

}

function getSeenHosts() {
  if (!ss.storage.seenHosts) {
    ss.storage.seenHosts = {};
  }

  return ss.storage.seenHosts;
}

function storeSeenHost(chromeGlobal, val = true) {
  const host = utils.getHostFromChromeGlobal(chromeGlobal);

  getSeenHosts()[host] = val;
}

function testIfSeenHostBefore(chromeGlobal) {
  const host = utils.getHostFromChromeGlobal(chromeGlobal);

  return getSeenHosts()[host];
}

function storeClickedOnBrick(val = true) {
  return ss.storage.clickedOnBrick = val;
}

function testIfClickedOnBrickBefore() {
  return ss.storage.clickedOnBrick;
}

function showView(name, options = { height: 334 }) {
  panel.port.emit('show-view', name);
  if (!panel.isShowing) {
    const chromeGlobal = utils.getActiveChromeGlobal();

    let anchor = chromeGlobal.document.getElementById('plugins-notification-icon');
    if (!anchor || anchor.hidden || anchor.parentElement.hidden) {
      anchor = chromeGlobal.document.getElementById('identity-icon');
    }

    // this produces a warning, but there doesn't really seem to be an alternative
    panel.show(options, config.useAnchor && anchor);
  }
}

function wireUpGlobalHandlers(win) {
  const chromeGlobal = viewFor(win);

  chromeGlobal.Services.obs.addObserver((subject, topic) => {
    attachTo(Style({
      uri: data.url('aboutAddons.css')
    }), subject);
  }, 'EM-loaded', false);
}

function replaceLearnMoreWithReportAProblem(chromeGlobal) {
  const doc = chromeGlobal.document;

  const style = Style({
    uri: data.url('essentialFlash.css')
  });

  attachTo(style, chromeGlobal);

  // Note: this is quite a hack just to get the 'Report a problem...' link to show
  // up. That link only makes sense in the context of our study, so it kind of makes
  // sense to contain it here, but we could also just put it behind a pref.
  chromeGlobal.PopupNotifications.panel.addEventListener('popupshowing', () => {
    const ctpNotification = doc.getElementById('click-to-play-plugins-notification');
    if (ctpNotification) {
      const link = doc.getAnonymousElementByAttribute(ctpNotification,
                                                      'anonid',
                                                      'click-to-play-plugins-notification-link');

      link.textContent = localized('report_a_problem');

      link.classList.remove('text-link');
      link.classList.add('ef-text-link');

      link.addEventListener('click', (e) => {
        // Unfortunately we have to reach into PopupNotification's insides in order
        // to dismiss the notification without making the brick go away.
        chromeGlobal.PopupNotifications._dismiss();

        showView('tell-us-more');
      }, { once: true });
    }
  });
}

function listenOnContentProcessMessages(chromeGlobal) {
  const mm = chromeGlobal.getGroupMessageManager('browsers');

  // load a frame script to bounce some messages back from
  // the content process to ourselves.
  mm.loadFrameScript(data.url('frameScript.js'), true);

  mm.addMessageListener('EF:BrowserReload', () => {
    if (!testIfSeenHostBefore(chromeGlobal) &&
      !testIfClickedOnBrickBefore() &&
      utils.flashIsBlockedForWindow(chromeGlobal)) {

      showView('having-problems', { height: HAVING_PROBLEMS_HEIGHT });
    }
  });

  mm.addMessageListener('EF:BrowserActivatePlugins', (msg) => {
    if (ignoreActivatePluginOnce) {
      ignoreActivatePluginOnce = false;
      return;
    }

    if (msg.json.newState === 'continue') {
      return;
    }

    const pluginInfo = msg.json.pluginInfo;

    if (pluginInfo.pluginTag.name === 'Shockwave Flash') {
      if (pluginInfo.fallbackType === PLUGIN_ACTIVE) {
        showView('has-activating-solved', { height: HAS_ACTIVATING_SOLVED_HEIGHT });
      } else {
        showView('has-deactivating-solved', { height: HAS_ACTIVATING_SOLVED_HEIGHT });
      }
    }
  });
}

function listenForPluginBrickInteractions(chromeGlobal) {
  const doc = chromeGlobal.document;

  const pluginBrick = doc.getElementById('plugins-notification-icon');
  pluginBrick.addEventListener('click', storeClickedOnBrick);
}

function wireUpWindow(win) {
  const chromeGlobal = viewFor(win);

  replaceLearnMoreWithReportAProblem(chromeGlobal);
  listenOnContentProcessMessages(chromeGlobal);
  listenForPluginBrickInteractions(chromeGlobal);
}

function getHasThisSolvedHandler(negativeAction) {
  return (val) => {
    panel.hide();

    if (val === 'yes') {
      let chromeGlobal = utils.getActiveChromeGlobal();
      const host = utils.getHostFromChromeGlobal(chromeGlobal);
      setTimeout(() => {
        chromeGlobal = utils.getActiveChromeGlobal();
        if (host === utils.getHostFromChromeGlobal(chromeGlobal) &&
          !testIfSeenHostBefore(chromeGlobal)) {
          showView('tell-us-more');
        }
      }, config.tellUsMoreAfterHasThisSolvedTimeout);
    } else if (val === 'no') {
      ignoreActivatePluginOnce = true;
      const chromeGlobal = utils.getActiveChromeGlobal();
      const notification = utils.getPluginNotificationForWindow(chromeGlobal);
      const flash = utils.getFlashPluginFromNotification(notification);

      // Note: we use a private method here to piggy back on the extra work
      // it does, like messaging the content process.
      chromeGlobal.gPluginHandler._updatePluginPermission(notification,
                                                          flash,
                                                          negativeAction);
      notification.reshow();
    }
  };
}

function wireUpUIHandlers() {
  let tellUsMoreState = {};

  panel.port.on('form-submit', (form) => {
    const chromeGlobal = utils.getActiveChromeGlobal();

    switch (form.name) {
    case 'tell-us-more-form':
      tellUsMoreState.radioValue = form['problems-radio'];
      storeSeenHost(utils.getActiveChromeGlobal());
      showView('tell-us-more-detail');
      break;
    case 'tell-us-more-detail-form':
      tellUsMoreState.detail = form['tell-us-more-detail'];
      submitTellUsMoreData(tellUsMoreState);
      panel.hide();

      if (utils.flashHasDefaultSettingForWindow(chromeGlobal)) {
        const notification = utils.getPluginNotificationForWindow(chromeGlobal);
        notification.reshow();
      }
      break;
    }
  });

  panel.port.on('has-activating-solved', getHasThisSolvedHandler('block'));
  panel.port.on('has-deactivating-solved', getHasThisSolvedHandler('allowalways'));

  panel.port.on('having-problems', (val) => {
    if (val === 'yes') {
      showView('tell-us-more');
    } else {
      storeSeenHost(utils.getActiveChromeGlobal());
      panel.hide();
    }
  });
}

exports.init = function () {
  wireUpGlobalHandlers(browserWindows.activeWindow);

  for (let win of browserWindows) {
    wireUpWindow(win);
  }

  browserWindows.on('open', wireUpWindow);

  wireUpUIHandlers();
};

exports.storeSeenHost = storeSeenHost;
exports.storeClickedOnBrick = storeClickedOnBrick;
exports.panel = panel;
exports.showView = showView;
exports.config = config;
