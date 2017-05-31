const { Ci, Cu } = require('chrome');

const { viewFor } = require('sdk/view/core');
const { browserWindows } = require('sdk/windows');
const ss = require('sdk/simple-storage');

const { Services } = Cu.import('resource://gre/modules/Services.jsm', {});

const { PLUGIN_ACTIVE } = Ci.nsIObjectLoadingContent;

function getSeenHosts() {
  if (!ss.storage.seenHosts) {
    ss.storage.seenHosts = {};
  }

  return ss.storage.seenHosts;
}

function getDismissedInfobars() {
  if (!ss.storage.dismissedInfobars) {
    ss.storage.dismissedInfobars = {};
  }

  return ss.storage.dismissedInfobars;
}

function storeSeenHost(chromeGlobal, val = true) {
  const host = getHostFromChromeGlobal(chromeGlobal);

  getSeenHosts()[host] = val;
}

function testIfSeenHostBefore(chromeGlobal) {
  const host = getHostFromChromeGlobal(chromeGlobal);

  return getSeenHosts()[host];
}

function storeHadInfobarDismissed(baseDomain) {
  getDismissedInfobars()[baseDomain] = true;
}

function testHadInfobarDismissed(baseDomain) {
  return getDismissedInfobars()[baseDomain];
}

function storeClickedOnBrick(val = true) {
  return ss.storage.clickedOnBrick = val;
}

function testIfClickedOnBrickBefore() {
  return ss.storage.clickedOnBrick;
}

function getHostFromChromeGlobal(chromeGlobal) {
  return chromeGlobal.gBrowser.selectedBrowser.contentPrincipal.baseDomain;
}

function getPluginNotificationForWindow(chromeGlobal) {
  const browser = chromeGlobal.gBrowser.selectedBrowser;
  return chromeGlobal.PopupNotifications.getNotification('click-to-play-plugins',
                                                         browser);
}

function getFlashPluginFromNotification(notification) {
  for (const plugin of notification.options.pluginData.values()) {
    if (plugin.pluginTag.name === 'Shockwave Flash') {
      return plugin;
    }
  }
  return null;
}

// NOTE: as far as I can tell this is the cleanest way we can do this. We
// could wait on a content task to tell us whether Flash is blocklisted
// for the domain in question, but that wouldn't tell us if we actually
// blocked Flash content on that page.
function flashContentWasBlockedForWindow(chromeGlobal) {
  const notification = getPluginNotificationForWindow(chromeGlobal);

  if (!notification) {
    return false;
  }

  const flash = getFlashPluginFromNotification(notification);

  if (flash) {
    return flash.fallbackType !== PLUGIN_ACTIVE;
  } else {
    return false;
  }
}

function getFlashPermissionObject(chromeGlobal) {
  const principal = chromeGlobal.gBrowser.selectedBrowser.contentPrincipal;
  const permObj = Services.perms.getPermissionObject(principal,
                                                     'plugin:flash',
                                                     false);
  return permObj;
}

function flashHasDefaultSettingForWindow(chromeGlobal) {
  const permObj = getFlashPermissionObject(chromeGlobal);
  return !permObj;
}

function getActiveChromeGlobal() {
  return viewFor(browserWindows.activeWindow);
}

module.exports = {
  getSeenHosts,
  storeSeenHost,
  storeClickedOnBrick,
  storeHadInfobarDismissed,
  testIfClickedOnBrickBefore,
  testIfSeenHostBefore,
  testHadInfobarDismissed,
  getHostFromChromeGlobal,
  getPluginNotificationForWindow,
  getFlashPluginFromNotification,
  flashContentWasBlockedForWindow,
  getFlashPermissionObject,
  flashHasDefaultSettingForWindow,
  getActiveChromeGlobal,
};
