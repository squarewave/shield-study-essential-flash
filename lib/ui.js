/** ui.js **/
const { Ci, Cu } = require('chrome');

const { attachTo } = require('sdk/content/mod');
const localized = require('sdk/l10n').get;
const { data } = require('sdk/self');
const { Style } = require('sdk/stylesheet/style');
const { setTimeout } = require('sdk/timers');
const { viewFor } = require('sdk/view/core');
const { browserWindows } = require('sdk/windows');
const { Panel } = require('sdk/panel');
const system = require('sdk/system');

const utils = require('./utils');
const dataCollection = require('./dataCollection');

const { Services } = Cu.import('resource://gre/modules/Services.jsm', {});

const { PLUGIN_ACTIVE } = Ci.nsIObjectLoadingContent;

const {
  EXPIRE_SESSION,
  EXPIRE_TIME,
} = Ci.nsIPermissionManager;

const IS_OSX = system.platform === 'darwin';
const DEFAULT_HEIGHT = IS_OSX ? 294 : 334;
const HAVING_PROBLEMS_HEIGHT = IS_OSX ? 144 : 158;
const HAS_ACTIVATING_SOLVED_HEIGHT = IS_OSX ? 196 : 214;

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

function getDocURI() {
  const chromeGlobal = utils.getActiveChromeGlobal();
  return chromeGlobal.gBrowser.selectedBrowser.documentURI.spec;
}

function reportTellUsMore(radioValue) {
  dataCollection.ingest({
    type: 'TellUsMore',
    docURI: getDocURI(),
    radioValue
  });
}

function reportTellUsMoreDetail(detail) {
  dataCollection.ingest({
    type: 'TellUsMoreDetail',
    docURI: getDocURI(),
    detail
  });
}

function reportProblemFixed(problemFixed) {
  dataCollection.ingest({
    type: 'ProblemFixed',
    docURI: getDocURI(),
    problemFixed
  });
}

function reportUserAction(kind) {
  dataCollection.ingest({
    type: 'UserAction',
    docURI: getDocURI(),
    kind
  });
}

function reportModifier(kind) {
  dataCollection.ingest({
    type: 'Modifier',
    docURI: getDocURI(),
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

function listenOnContentProcessMessages(chromeGlobal) {
  const mm = chromeGlobal.getGroupMessageManager('browsers');

  // load a frame script to bounce some messages back from
  // the content process to ourselves.
  mm.loadFrameScript(data.url('messageBouncer.js'), true);

  mm.addMessageListener('PluginSafety:BrowserEventRelay', (msg) => {
    if (msg.data.error) {
      console.log(msg.data);
    } else {
      dataCollection.ingest(msg.data);
    }
  });

  mm.addMessageListener('PluginContent:ShowClickToPlayNotification', (msg) => {
    if (msg.data.showNow) {
      reportModifier('overlay-clicked');
    }
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
    // this flag is set below when we change this value through our own UIs. In this
    // case, we don't want to trigger a new doorhanger.
    if (ignoreActivatePluginOnce) {
      ignoreActivatePluginOnce = false;
      return;
    }

    // if they aren't changing anything, then we don't care.
    if (msg.json.newState === 'continue') {
      return;
    }

    const pluginInfo = msg.json.pluginInfo;

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
      const notification = utils.getPluginNotificationForWindow(chromeGlobal);
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
};

exports.panel = panel;
exports.showView = showView;
exports.config = config;
