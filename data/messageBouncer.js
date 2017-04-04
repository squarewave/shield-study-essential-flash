/* eslint-disable no-undef */

const { interfaces: Ci, classes: Cc, utils: Cu } = Components;

addMessageListener('Browser:Reload', (msg) => {
  sendAsyncMessage('PluginSafety:BrowserReload');
});

addMessageListener('BrowserPlugins:NotificationShown', (msg) => {
  sendAsyncMessage('PluginSafety:NotificationShown');
});

function isKnownPlugin(objLoadingContent) {
  return (objLoadingContent.getContentTypeForMIMEType(objLoadingContent.actualType) ==
          Ci.nsIObjectLoadingContent.TYPE_PLUGIN);
}

addMessageListener('BrowserPlugins:ActivatePlugins', (msg) => {
  const contentWindow = msg.target.content;
  const cwu = contentWindow.QueryInterface(Ci.nsIInterfaceRequestor)
                         .getInterface(Ci.nsIDOMWindowUtils);
  const plugins = cwu.plugins;
  const pluginHost = Cc["@mozilla.org/plugin/host;1"].getService(Ci.nsIPluginHost);

  let pluginFound = false;
  let placeHolderFound = false;
  for (const plugin of plugins) {
    plugin.QueryInterface(Ci.nsIObjectLoadingContent);
    if (!isKnownPlugin(plugin)) {
      continue;
    }
    if (msg.data.pluginInfo.permissionString == pluginHost.getPermissionStringForType(plugin.actualType)) {
      if (plugin instanceof Ci.nsIDOMHTMLAnchorElement) {
        placeHolderFound = true;
      } else {
        pluginFound = true;
      }
    }
  }

  const waitForReload = (msg.data.newState != "block" &&
     (!pluginFound || placeHolderFound || contentWindow.pluginRequiresReload));

  sendAsyncMessage('PluginSafety:BrowserActivatePlugins', { innerData: msg.json, waitForReload });
});

/* eslint-enable no-undef */
