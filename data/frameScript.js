/* eslint-disable no-undef */

addMessageListener("Browser:Reload", (msg) => {
  sendAsyncMessage("EF:BrowserReload", "bob");
});

addMessageListener("BrowserPlugins:ActivatePlugins", (msg) => {
  sendAsyncMessage("EF:BrowserActivatePlugins", msg.json);
});

/* eslint-enable no-undef */

