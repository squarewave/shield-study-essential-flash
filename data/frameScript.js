/* eslint-disable no-undef */

const { interfaces: Ci, classes: Cc, utils: Cu } = Components;

Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/Timer.jsm");
Cu.import("resource://gre/modules/PrivateBrowsingUtils.jsm");

const uuidGenerator = Cc["@mozilla.org/uuid-generator;1"].getService(Ci.nsIUUIDGenerator);

const {
  ALLOW_ACTION,
  DENY_ACTION,
} = Ci.nsIPermissionManager;

const {
  PLUGIN_ACTIVE,
  PLUGIN_ALTERNATE,
  PLUGIN_SUPPRESSED,
  PLUGIN_CLICK_TO_PLAY,
} = Ci.nsIObjectLoadingContent;

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

function dumpError(e) {
  sendAsyncMessage("PluginSafety:BrowserEventRelay", { error: e.toString() + "\n" + e.stack });
}

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

function getPluginUI(plugin, anonid) {
  return plugin.ownerDocument
    .getAnonymousElementByAttribute(plugin, "anonid", anonid);
}

function getProperty(name, plugin) {
  if (plugin[name]) {
    return plugin[name];
  }
  const embeds = plugin.getElementsByTagName('embed');
  if (embeds.length >= 1) {
    return embeds[0][name];
  }
  const objs = plugin.getElementsByTagName('object');
  if (objs.length >= 1) {
    return objs[0][name];
  }

  return null;
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

function shouldShowOverlay(plugin) {
  let overlay = getPluginUI(plugin, "main");

  if (!overlay) {
    return false;
  }

  // If the overlay size is 0, we haven't done layout yet. Presume that
  // plugins are visible until we know otherwise.
  if (overlay.scrollWidth == 0) {
    return true;
  }

  // Is the <object>'s size too small to hold what we want to show?
  let pluginRect = plugin.getBoundingClientRect();
  // XXX bug 446693. The text-shadow on the submitted-report text at
  //     the bottom causes scrollHeight to be larger than it should be.
  let overflows = (overlay.scrollWidth > Math.ceil(pluginRect.width)) ||
                  (overlay.scrollHeight - 5 > Math.ceil(pluginRect.height));
  if (overflows) {
    return false;
  }

  // Is the plugin covered up by other content so that it is not clickable?
  // Floating point can confuse .elementFromPoint, so inset just a bit
  let left = pluginRect.left + 2;
  let right = pluginRect.right - 2;
  let top = pluginRect.top + 2;
  let bottom = pluginRect.bottom - 2;
  let centerX = left + (right - left) / 2;
  let centerY = top + (bottom - top) / 2;
  let points = [[left, top],
                 [left, bottom],
                 [right, top],
                 [right, bottom],
                 [centerX, centerY]];

  if (right <= 0 || top <= 0) {
    return false;
  }

  let contentWindow = plugin.ownerGlobal;
  let cwu = contentWindow.QueryInterface(Ci.nsIInterfaceRequestor)
                         .getInterface(Ci.nsIDOMWindowUtils);

  for (let [x, y] of points) {
    let el = cwu.elementFromPoint(x, y, true, true);
    if (el !== plugin) {
      return false;
    }
  }

  return true;
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

    if (doc.documentFlashClassification != "allow") {
      if (doc.readyState == "complete") {
        Task.spawn(handleUnallowedPageLoading(event));
      } else {
        doc.addEventListener("DOMContentLoaded", listener);
      }
    }

    sendAsyncMessage("PluginSafety:BrowserEventRelay", payload);
  } catch (e) {
    dumpError(e);
  }
}

function getPluginClassificationStr(plugin, pluginInfo) {
  switch (pluginInfo.fallbackType) {
    case PLUGIN_ACTIVE: return "allowed";
    case PLUGIN_SUPPRESSED: return "denied";
    case PLUGIN_ALTERNATE: return "fallback-used";
    case PLUGIN_CLICK_TO_PLAY:
      if (shouldShowOverlay(plugin)) {
        return "ctp-overlay";
      } else {
        // NOTE: this isn't _quite_ correct, since if there are any other overlay
        // elements on the page, a bar still will not be shown. However, it's more
        // correct than returning 'ctp-overlay', and we should be able to deduce
        // whether a bar was actually shown by checking if there were any
        // ctp-overlay's in the doc.
        return "ctp-bar";
      }
  }

  return null;
}

function* handleUnallowedPageLoading(event) {
  try {
    let doc = event.target;
    let win = doc.defaultView.self;

    let cwu = win.QueryInterface(Ci.nsIInterfaceRequestor)
              .getInterface(Ci.nsIDOMWindowUtils);

    for (const plugin of cwu.plugins) {
      const pluginInfo = getPluginInfo(plugin);

      if (pluginInfo && pluginInfo.mimetype == 'application/x-shockwave-flash') {
        const classification = getPluginClassificationStr(plugin, pluginInfo);

        // allow the other cases to be handled by handlePluginEvent, which has the
        // advantage of being able to handle plugins loaded after page load.
        if (classification == "denied" || classification == "fallback-used") {
          const srcURI = getProperty('srcURI', plugin);
          const width = getProperty('width', plugin);
          const height = getProperty('height', plugin);

          const flashObj = {
            path: srcURI ? srcURI.spec : null,
            classification: classification,
            is3rdParty: srcURI && srcURI.prePath != getDocumentHost(win.top.document),
            width: width ? parseInt(width) : null,
            height: height ? parseInt(height) : null,
            clickedOnOverlay: false,
          };

          const payload = {
            type: "PluginFound",
            windowID: yield getWindowID(win),
            docURI: doc.documentURI,
            flashObj
          };

          sendAsyncMessage("PluginSafety:BrowserEventRelay", payload);
        }
      }
    }
  } catch (e) {
    dumpError(e);
  }
}

function* handlePluginEvent(event) {
  try {
    let eventType = event.type;
    let plugin = event.target;

    let doc = event.target.ownerDocument;
    let win = doc.defaultView;

    if (eventType == "PluginBindingAttached") {
      let overlay = getPluginUI(plugin, "main");

      if (!overlay || overlay._pluginSafetyBindingHandled) {
        return;
      }
      overlay._pluginSafetyBindingHandled = true;
    }

    const pluginInfo = getPluginInfo(plugin);

    const srcURI = getProperty('srcURI', plugin);
    const width = getProperty('width', plugin);
    const height = getProperty('height', plugin);

    const flashObj = {
      path: srcURI ? srcURI.spec : null,
      classification: getPluginClassificationStr(plugin, pluginInfo),
      is3rdParty: srcURI && srcURI.prePath != getDocumentHost(win.top.document),
      width: width ? parseInt(width) : null,
      height: height ? parseInt(height) : null,
      clickedOnOverlay: false,
    };

    const payload = {
      type: "PluginFound",
      windowID: yield getWindowID(win),
      docURI: doc.documentURI,
      flashObj
    };

    sendAsyncMessage("PluginSafety:BrowserEventRelay", payload);
  } catch (e) {
    dumpError(e);
  }
}

const listener = {
  handleEvent(event) {
    if (PrivateBrowsingUtils.isContentWindowPrivate(event.target.ownerGlobal)) {
      // don't log anything for private sessions. Hooray respecting people!
      return;
    }

    Task.spawn(function*() {
      switch (event.type) {
        case "pageshow":
          yield* handlePageShow(event);
          break;
        case "PluginBindingAttached":
        case "PluginInstantiated":
          yield* handlePluginEvent(event);
          break;
        case "DOMContentLoaded":
          yield* handleUnallowedPageLoading(event);
          break;
      }
    });
  }
};


addEventListener("PluginBindingAttached", listener, true, true);
addEventListener("PluginInstantiated", listener, true, true);
addEventListener("pageshow", listener, true);

/* eslint-enable no-undef */

