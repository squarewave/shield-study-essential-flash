/* eslint-disable no-undef */

addMessageListener("Browser:Reload", (msg) => {
  sendAsyncMessage("PluginSafety:BrowserReload");
});

addMessageListener("BrowserPlugins:NotificationShown", (msg) => {
  sendAsyncMessage("PluginSafety:NotificationShown");
});



addMessageListener("BrowserPlugins:ActivatePlugins", (msg) => {
  sendAsyncMessage("PluginSafety:BrowserActivatePlugins", msg.json);
});

/* eslint-enable no-undef */

