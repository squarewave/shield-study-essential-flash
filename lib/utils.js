const { Ci } = require('chrome');

const { viewFor } = require('sdk/view/core');
const { browserWindows } = require('sdk/windows');

const { PLUGIN_ACTIVE } = Ci.nsIObjectLoadingContent;
const { EXPIRE_NEVER } = Ci.nsIPermissionManager;


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

function flashIsBlockedForWindow(chromeGlobal) {
  const notification = getPluginNotificationForWindow(chromeGlobal);

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
  getHostFromChromeGlobal,
  getPluginNotificationForWindow,
  getFlashPluginFromNotification,
  flashIsBlockedForWindow,
  flashHasDefaultSettingForWindow,
  getActiveChromeGlobal,
};
