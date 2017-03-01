const { Ci } = require('chrome');

const { viewFor } = require('sdk/view/core');
const { browserWindows } = require('sdk/windows');
const ss = require('sdk/simple-storage');

const { PLUGIN_ACTIVE } = Ci.nsIObjectLoadingContent;
const { EXPIRE_NEVER } = Ci.nsIPermissionManager;

function getSeenHosts() {
  if (!ss.storage.seenHosts) {
    ss.storage.seenHosts = {};
  }

  return ss.storage.seenHosts;
}

function storeSeenHost(chromeGlobal, val = true) {
  const host = getHostFromChromeGlobal(chromeGlobal);

  getSeenHosts()[host] = val;
}

function testIfSeenHostBefore(chromeGlobal) {
  const host = getHostFromChromeGlobal(chromeGlobal);

  return getSeenHosts()[host];
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

function flashHasDefaultSettingForWindow(chromeGlobal) {
  const principal = chromeGlobal.gBrowser.selectedBrowser.contentPrincipal;
  const perms = chromeGlobal.Services.perms;
  const permObj = perms.getPermissionObject(principal,
                                            'plugin:flash',
                                            false);
  return !permObj || permObj.expireType === EXPIRE_NEVER;
}

function getActiveChromeGlobal() {
  return viewFor(browserWindows.activeWindow);
}

module.exports = {
  getSeenHosts,
  storeSeenHost,
  storeClickedOnBrick,
  testIfClickedOnBrickBefore,
  testIfSeenHostBefore,
  getHostFromChromeGlobal,
  getPluginNotificationForWindow,
  getFlashPluginFromNotification,
  flashContentWasBlockedForWindow,
  flashHasDefaultSettingForWindow,
  getActiveChromeGlobal,
};
