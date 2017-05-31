/** ui.js **/
const { Ci, Cu } = require('chrome');

const { attachTo } = require('sdk/content/mod');
const localized = require('sdk/l10n').get;
const { data } = require('sdk/self');
const { Style } = require('sdk/stylesheet/style');
const { setTimeout } = require('sdk/timers');
const { modelFor } = require('sdk/model/core');
const { viewFor } = require('sdk/view/core');
const { browserWindows } = require('sdk/windows');
const { Panel } = require('sdk/panel');
const system = require('sdk/system');
const tabUtils = require('sdk/tabs/utils');
const prefs = require("sdk/preferences/service");

const utils = require('./utils');
const dataCollection = require('./dataCollection');

const { Services } = Cu.import('resource://gre/modules/Services.jsm', {});
const { NetUtil } = Cu.import('resource://gre/modules/NetUtil.jsm', {});

const { PLUGIN_ACTIVE } = Ci.nsIObjectLoadingContent;

const {
  EXPIRE_SESSION,
  EXPIRE_TIME,
} = Ci.nsIPermissionManager;

const IS_OSX = system.platform === 'darwin';

// The russian translation of "Page's layout was broken" is too long
// and causes the line to wrap, resulting in a scroll bar. This is a
// hack to fix that.
const HEIGHT_ADJUST = prefs.get('general.useragent.locale', 'en-US') === 'ru' ? 30 : 0;
const DEFAULT_HEIGHT = (IS_OSX ? 294 : 334) + HEIGHT_ADJUST;
const HAVING_PROBLEMS_HEIGHT = (IS_OSX ? 144 : 158);
const HAS_ACTIVATING_SOLVED_HEIGHT = (IS_OSX ? 196 : 214);

const INFOBAR_BLOCKLIST = new Set([
  'yandex.ru',
  'chpoking.ru',
  'ok.ru',
  'amazon.com',
  'amazon.co.jp',
  'amazon.fr',
  'twitch.tv',
  'ebay.com',
  'aol.com',
]);

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

function getWindowID() {
  const chromeGlobal = utils.getActiveChromeGlobal();
  return chromeGlobal.gBrowser.selectedBrowser.innerWindowID;
}

function reportTellUsMore(radioValue) {
  dataCollection.ingest({
    type: 'TellUsMore',
    windowID: getWindowID(),
    radioValue
  });
}

function reportTellUsMoreDetail(detail) {
  dataCollection.ingest({
    type: 'TellUsMoreDetail',
    windowID: getWindowID(),
    detail
  });
}

function reportProblemFixed(problemFixed) {
  dataCollection.ingest({
    type: 'ProblemFixed',
    windowID: getWindowID(),
    problemFixed
  });
}

function reportUserAction(kind) {
  dataCollection.ingest({
    type: 'UserAction',
    windowID: getWindowID(),
    kind
  });
}

function reportModifier(kind) {
  dataCollection.ingest({
    type: 'Modifier',
    windowID: getWindowID(),
    kind
  });
}

function reportInfobar(kind, browser) {
  dataCollection.ingest({
    type: 'InfoBar',
    windowID: browser.innerWindowID,
    kind
  });
}

function showView(name, options) {
  if (!options) {
    options = { height: DEFAULT_HEIGHT };
  }

  panel.port.emit('show-view', name);

  if (!panel.isShowing) {
    const chromeGlobal = utils.getActiveChromeGlobal();

    let anchor = chromeGlobal.document.getElementById('plugins-notification-icon');
    if (!anchor || anchor.hidden || anchor.parentElement.hidden) {
      anchor = chromeGlobal.document.getElementById('identity-icon');
    }

    // this produces a warning, but there doesn't really seem to be an alternative
    panel.show(options, config.useAnchor && anchor);
  } else {
    panel.height = options.height;
  }
}

function wireUpGlobalHandlers(win) {
  Services.obs.addObserver((subject, topic) => {
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
      link.classList.add('ps-text-link');

      link.addEventListener('click', (e) => {
        // Unfortunately we have to reach into PopupNotification's insides in order
        // to dismiss the notification without making the brick go away.
        chromeGlobal.PopupNotifications._dismiss();

        showView('tell-us-more');
      }, { once: true });
    }
  });
}

// This should work in all but the weirdest of circumstances. This is used for the
// "Has this solved your problem?" doorhanger when there's no CTP notification after
// a reload. This can occur on some sites that load flash content after a delay and
// also require a refresh. If the user enables flash on that page, then navigates
// to another page with a flash notification, then the "Has this solved your problem?"
// will show up with an option to block Flash, which will block it for that page. It's
// pretty corner-casey and not that severe of a problem.
let mostRecentPluginNotification = null;

function listenOnContentProcessMessages(chromeGlobal) {
  const mm = chromeGlobal.messageManager;

  // load a frame script to bounce some messages back from
  // the content process to ourselves.
  mm.loadFrameScript(data.url('messageBouncer.js'), true);

  mm.addMessageListener('PluginSafety:BrowserEventRelay', (msg) => {
    if (msg.data.type == 'PluginFound' &&
      msg.data.flashObj.classification.startsWith('ctp-')) {

      // undefined means that we're okay to set removeNextPluginBar to either true
      // or false. We want to ensure that if any valid ctp- flash objects come
      // through, we clear removeNextPluginBar.
      if (msg.data.flashObj.path === null && msg.target.removeNextPluginBar === undefined) {
        msg.target.removeNextPluginBar = true;
      } else if (msg.data.flashObj.path !== null) {
        let pathURI = NetUtil.newURI(msg.data.flashObj.path);
        let baseDomain = Services.eTLD.getBaseDomain(pathURI);
        if (INFOBAR_BLOCKLIST.has(baseDomain)) {
          msg.target.removeNextPluginBar = true;
        } else {
          msg.target.removeNextPluginBar = false;
        }
      }
    } else if (msg.data.type == 'pageshow') {
      delete msg.target.removeNextPluginBar;
    }
  });

  mm.addMessageListener('PluginContent:UpdateHiddenPluginUI', (msg) => {
    if (!msg.target.removeNextPluginBar) {
      let baseDomain = Services.eTLD.getBaseDomain(msg.target.documentURI);
      if (!INFOBAR_BLOCKLIST.has(baseDomain) && !utils.testHadInfobarDismissed(baseDomain)) {
        chromeGlobal.gPluginHandler.updateHiddenPluginUI(msg.target,
          msg.data.haveInsecure, msg.data.actions, msg.principal, msg.data.location);
        let notificationBox = chromeGlobal.gBrowser.getNotificationBox(msg.target);
        let notification = notificationBox.getNotificationWithValue("plugin-hidden");
        if (notification && !notification.alreadyHooked) {
          notification.alreadyHooked = true;
          reportInfobar('shown', msg.target);
          let oldCallback = notification.eventCallback;
          notification.eventCallback = (reason) => {
            if (reason == 'dismissed') {
              reportInfobar('dismissed', msg.target);
              utils.storeHadInfobarDismissed(baseDomain);
            }
            if (oldCallback) {
              oldCallback(reason);
            }
          };
        }
      }
    }

    delete msg.target.removeNextPluginBar;
  });

  mm.addMessageListener('PluginContent:ShowClickToPlayNotification', (msg) => {
    if (msg.data.showNow) {
      reportModifier('overlay-clicked');
    }
  });

  mm.addMessageListener('PluginSafety:NotificationShown', () => {
    mostRecentPluginNotification = utils.getPluginNotificationForWindow(chromeGlobal);
  });

  mm.addMessageListener('PluginSafety:BrowserReload', () => {
    const topic = 'PluginSafety:NotificationShown';
    // kind of hacky: listen for plugin CTP notifications for one second after a reload.
    // If we get one, check a few things and maybe ask the user if they're having trouble.
    const notificationTimeout = 1000;
    // event hackier: wait for half a second because the ordering of these events is
    // very unstable. TODO: find a better way.
    const raceAvoidingHackTimeout = 500;

    reportUserAction('page-refreshed');

    const listener = () => {
      setTimeout(() => {
        mm.removeMessageListener(topic, listener);
        if (!utils.testIfSeenHostBefore(chromeGlobal) &&
            !utils.testIfClickedOnBrickBefore() &&
            utils.flashContentWasBlockedForWindow(chromeGlobal)) {
          showView('having-problems', { height: HAVING_PROBLEMS_HEIGHT });
        }
      }, raceAvoidingHackTimeout);
    };

    mm.addMessageListener(topic, listener);

    setTimeout(() => {
      mm.removeMessageListener(topic, listener);
    }, notificationTimeout);
  });

  mm.addMessageListener('PluginSafety:BrowserActivatePlugins', (msg) => {
    // if they aren't changing anything, then we don't care.
    if (msg.json.innerData.newState === 'continue') {
      return;
    }

    function handleActivatePlugins() {
      // this flag is set below when we change this value through our own UIs. In this
      // case, we don't want to trigger a new doorhanger.
      if (ignoreActivatePluginOnce) {
        ignoreActivatePluginOnce = false;
        return;
      }

      const pluginInfo = msg.json.innerData.pluginInfo;

      if (pluginInfo.pluginTag.name === 'Shockwave Flash') {
        if (pluginInfo.fallbackType === PLUGIN_ACTIVE) {
          const permObj = utils.getFlashPermissionObject(chromeGlobal);
          if (permObj && permObj.expireType === EXPIRE_SESSION) {
            reportUserAction('allow');
          } else if (permObj && permObj.expireType === EXPIRE_TIME) {
            reportUserAction('allow-and-remember');
          }

          showView('has-activating-solved', { height: HAS_ACTIVATING_SOLVED_HEIGHT });
        } else {
          reportUserAction('deny');

          showView('has-deactivating-solved', { height: HAS_ACTIVATING_SOLVED_HEIGHT });
        }
      }
    }

    if (msg.json.waitForReload) {
      const tab = modelFor(tabUtils.getTabForBrowser(msg.target));

      tab.once('pageshow', () => {
        handleActivatePlugins();
      });
    } else {
      handleActivatePlugins();
    }
  });
}

function listenForPluginBrickInteractions(chromeGlobal) {
  const doc = chromeGlobal.document;

  const pluginBrick = doc.getElementById('plugins-notification-icon');
  pluginBrick.addEventListener('click', () => {
    reportModifier('brick-clicked');

    utils.storeClickedOnBrick();
  });
}

function wireUpWindow(win) {
  const chromeGlobal = viewFor(win);

  replaceLearnMoreWithReportAProblem(chromeGlobal);
  listenOnContentProcessMessages(chromeGlobal);
  listenForPluginBrickInteractions(chromeGlobal);

  // Clear gPluginHandler from listening to this, because we're going to
  // intercept it and filter.
  chromeGlobal.messageManager.removeMessageListener('PluginContent:UpdateHiddenPluginUI',
    chromeGlobal.gPluginHandler);
}

function resetWindow(win) {
  const chromeGlobal = viewFor(win);

  // Add gPluginHandler back on these messages (see wireUpWindow)
  chromeGlobal.messageManager.addMessageListener('PluginContent:UpdateHiddenPluginUI',
    chromeGlobal.gPluginHandler);
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
          !utils.testIfSeenHostBefore(chromeGlobal)) {
          showView('tell-us-more');
        }
      }, config.tellUsMoreAfterHasThisSolvedTimeout);
      reportProblemFixed(true);
    } else if (val === 'no') {
      ignoreActivatePluginOnce = true;
      const chromeGlobal = utils.getActiveChromeGlobal();
      const notification = utils.getPluginNotificationForWindow(chromeGlobal) ||
                           mostRecentPluginNotification;
      const flash = utils.getFlashPluginFromNotification(notification);

      // NOTE: we use a private method here to piggy back on the extra work
      // it does, like messaging the content process.
      chromeGlobal.gPluginHandler._updatePluginPermission(notification,
                                                          flash,
                                                          negativeAction);
      notification.reshow();
      reportProblemFixed(false);
    } else {
      reportProblemFixed(null);
    }
    reportUserAction('feedback-given');
  };
}

function wireUpUIHandlers() {
  panel.port.on('form-submit', (form) => {
    const chromeGlobal = utils.getActiveChromeGlobal();

    switch (form.name) {
    case 'tell-us-more-form':
      utils.storeSeenHost(utils.getActiveChromeGlobal());
      showView('tell-us-more-detail');
      reportTellUsMore(form['problems-radio']);
      break;
    case 'tell-us-more-detail-form':
      reportUserAction('feedback-given');
      reportTellUsMoreDetail(form['tell-us-more-detail']);

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
      utils.storeSeenHost(utils.getActiveChromeGlobal());
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

exports.uninit = function() {
  for (let win of browserWindows) {
    resetWindow(win);
  }
};

exports.panel = panel;
exports.showView = showView;
exports.config = config;
