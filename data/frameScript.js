/* eslint-disable no-undef */

const { interfaces: Ci, classes: Cc, utils: Cu } = Components;

Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/Timer.jsm");

const uuidGenerator = Cc["@mozilla.org/uuid-generator;1"].getService(Ci.nsIUUIDGenerator);

const FLASH_MIME_TYPE = "application/x-shockwave-flash";

const PROMISE_MAP_TIMEOUT = 2000;
const promiseMap = new Map();

addMessageListener("Browser:Reload", (msg) => {
  sendAsyncMessage("PluginSafety:BrowserReload");
});

addMessageListener("BrowserPlugins:NotificationShown", (msg) => {
  sendAsyncMessage("PluginSafety:NotificationShown");
});

addMessageListener("BrowserPlugins:ActivatePlugins", (msg) => {
  sendAsyncMessage("PluginSafety:BrowserActivatePlugins", msg.json);
});

function getCtaSetting(href) {
  const uri = NetUtil.newURI(href);
  const permObj = Services.perms.getPermissionObjectForURI(uri,
                                                           'plugin:flash',
                                                           false);
  if (permObj) {
    switch (permObj.capability){
      case ALLOW_ACTION:
        if (permObj.expireType == EXPIRE_SESSION) {
          return "allow";
        } else {
          return "allow-and-remember";
        }
        break;
      case DENY_ACTION:
        return "never-allow";
    }
  }

  return "default";
}

function getDocumentHost(doc) {
  return NetUtil.newURI(doc.documentURI).prePath;
}

function getPluginUI(plugin, anonid) {
  return plugin.ownerDocument
    .getAnonymousElementByAttribute(plugin, "anonid", anonid);
}

function getBindingType(plugin) {
  if (!(plugin instanceof Ci.nsIObjectLoadingContent))
    return null;

  switch (plugin.pluginFallbackType) {
    case Ci.nsIObjectLoadingContent.PLUGIN_UNSUPPORTED:
      return "PluginNotFound";
    case Ci.nsIObjectLoadingContent.PLUGIN_DISABLED:
      return "PluginDisabled";
    case Ci.nsIObjectLoadingContent.PLUGIN_BLOCKLISTED:
      return "PluginBlocklisted";
    case Ci.nsIObjectLoadingContent.PLUGIN_OUTDATED:
      return "PluginOutdated";
    case Ci.nsIObjectLoadingContent.PLUGIN_CLICK_TO_PLAY:
      return "PluginClickToPlay";
    case Ci.nsIObjectLoadingContent.PLUGIN_VULNERABLE_UPDATABLE:
      return "PluginVulnerableUpdatable";
    case Ci.nsIObjectLoadingContent.PLUGIN_VULNERABLE_NO_UPDATE:
      return "PluginVulnerableNoUpdate";
    default:
      // Not all states map to a handler
      return null;
  }
}

function isKnownPlugin(objLoadingContent) {
  return (objLoadingContent.getContentTypeForMIMEType(objLoadingContent.actualType) ==
          Ci.nsIObjectLoadingContent.TYPE_PLUGIN);
}

function getPluginInfo(pluginElement) {
  if (pluginElement instanceof Ci.nsIDOMHTMLAnchorElement) {
    // Anchor elements are our place holders, and we only have them for Flash
    let pluginHost = Cc["@mozilla.org/plugin/host;1"].getService(Ci.nsIPluginHost);
    return {
      pluginName: "Shockwave Flash",
      mimetype: FLASH_MIME_TYPE,
      permissionString: pluginHost.getPermissionStringForType(FLASH_MIME_TYPE)
    };
  }
  let pluginHost = Cc["@mozilla.org/plugin/host;1"].getService(Ci.nsIPluginHost);
  pluginElement.QueryInterface(Ci.nsIObjectLoadingContent);

  let tagMimetype;
  let pluginName = "unknown";
  let pluginTag = null;
  let permissionString = null;
  let fallbackType = null;
  let blocklistState = null;

  tagMimetype = pluginElement.actualType;
  if (tagMimetype == "") {
    tagMimetype = pluginElement.type;
  }

  if (isKnownPlugin(pluginElement)) {
    pluginTag = pluginHost.getPluginTagForType(pluginElement.actualType);
    pluginName = pluginTag.name;

    // Convert this from nsIPluginTag so it can be serialized.
    let properties = ["name", "description", "filename", "version", "enabledState", "niceName"];
    let pluginTagCopy = {};
    for (let prop of properties) {
      pluginTagCopy[prop] = pluginTag[prop];
    }
    pluginTag = pluginTagCopy;

    permissionString = pluginHost.getPermissionStringForType(pluginElement.actualType);
    fallbackType = pluginElement.defaultFallbackType;
    blocklistState = pluginHost.getBlocklistStateForType(pluginElement.actualType);
    // Make state-softblocked == state-notblocked for our purposes,
    // they have the same UI. STATE_OUTDATED should not exist for plugin
    // items, but let's alias it anyway, just in case.
    if (blocklistState == Ci.nsIBlocklistService.STATE_SOFTBLOCKED ||
        blocklistState == Ci.nsIBlocklistService.STATE_OUTDATED) {
      blocklistState = Ci.nsIBlocklistService.STATE_NOT_BLOCKED;
    }
  }

  return {
    mimetype: tagMimetype,
    pluginName,
    pluginTag,
    permissionString,
    fallbackType,
    blocklistState,
  };
}

function getWindowID(win) {
  if (win.__pluginSafetyWindowID) {
    return win.__pluginSafetyWindowID;
  }

  return new Promise((resolve, reject) => {
    const docURI = win.document.documentURI;
    const promises = promiseMap.get(docURI) || [];
    promises.push(resolve);
    promiseMap.set(docURI, promises);
    setTimeout(() => {
      if (promiseMap.delete(docURI)) {
        reject("No window ID created for document " + docURI);
      }
    }, PROMISE_MAP_TIMEOUT);
  });
  return win.__pluginSafetyWindowID = uuidGenerator.generateUUID().toString();
}

function* handlePageShow(event) {
  try {
    let doc = event.target;
    let win = doc.defaultView.self;

    win.__pluginSafetyWindowID = uuidGenerator.generateUUID().toString();

    const docObj = {
      host: NetUtil.newURI(doc.documentURI).prePath,
      ctaSetting: getCtaSetting(doc.documentURI),
      flashClassification: doc.documentFlashClassification,
      is3rdParty: false,
      userAction: [],
      ctpVia: null,
      docshellId: doc.docShell.historyID,
      'user-feedback': null,
      flashObjs: null,
      subDocs: []
    };

    const payload = {
      type: event.type,
      docURI: doc.documentURI,
      isTopLevel: win.top === win,
      parentWindowID: null,
      windowID: win.__pluginSafetyWindowID,
      docObj
    };

    let resolves = promiseMap.get(win.document.documentURI);
    if (resolves) {
      resolves.forEach(resolve => resolve(win.__pluginSafetyWindowID));
    }
    promiseMap.delete(win.document.documentURI);

    if (!payload.isTopLevel) {
      payload.parentWindowID = yield getWindowID(win.parent);
      payload.docObj.is3rdParty = getDocumentHost(doc) != getDocumentHost(win.top.document);
    }

    sendAsyncMessage("PluginSafety:BrowserEventRelay", payload);
  } catch (e) {
    sendAsyncMessage("PluginSafety:BrowserEventRelay", { error: e.toString() });
  }
}

function* handlePluginEvent(event) {
  try {
    let plugin = event.target;
    let eventType = event.type;

    // The plugin binding fires this event when it is created.
    // As an untrusted event, ensure that this object actually has a binding
    // and make sure we don't handle it twice
    let overlay = getPluginUI(plugin, "main");


    if (eventType == "PluginBindingAttached") {
      if (!overlay || overlay._pluginSafetyBindingHandled) {
        return;
      }
      overlay._pluginSafetyBindingHandled = true;

      overlay.__pluginSafetyPluginID = uuidGenerator.generateUUID().toString();
      overlay.addEventListener("click", listener, true);

      // Lookup the handler for this binding
      eventType = getBindingType(plugin);
      if (!eventType) {
        // Not all bindings have handlers
        return;
      }
    }

    let doc = event.target.ownerDocument;
    let win = doc.defaultView;

    const flashObj = {
      path: plugin.srcURI.spec,
      classification: null, // TODO
      is3rdParty: plugin.srcURI.prePath != getDocumentHost(win.top.document),
      width: parseInt(plugin.width),
      height: parseInt(plugin.height),
      clickedOnOverlay: false, // TODO
    };

    const payload = {
      type: eventType,
      windowID: yield getWindowID(win),
      docURI: doc.documentURI,
      pluginInfo: getPluginInfo(plugin),
      flashObj
    };

    sendAsyncMessage("PluginSafety:BrowserEventRelay", payload);
  } catch (e) {
    sendAsyncMessage("PluginSafety:BrowserEventRelay", { error: e.toString() });
  }
}

const listener = {
  handleEvent(event) {
    Task.spawn(function*() {
      switch (event.type) {
        case "pageshow":
          yield* handlePageShow(event);
          break;
        case "PluginInstantiated":
        case "PluginBindingAttached":
          yield* handlePluginEvent(event);
          break;
        case "click":
          handlePluginClickEvent(event);
          break;
      }
    });
  }
};


addEventListener("PluginBindingAttached", listener, true, true);
addEventListener("PluginInstantiated", listener, true, true);
addEventListener("pageshow", listener, true);

/* eslint-enable no-undef */

