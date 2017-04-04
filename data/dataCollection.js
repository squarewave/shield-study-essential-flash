/* eslint-disable no-undef */

const { interfaces: Ci, classes: Cc, utils: Cu } = Components;

Cu.import('resource://gre/modules/NetUtil.jsm');
Cu.import('resource://gre/modules/Services.jsm');
Cu.import('resource://gre/modules/PrivateBrowsingUtils.jsm');

const uuidGenerator = Cc['@mozilla.org/uuid-generator;1'].getService(Ci.nsIUUIDGenerator);

const {
  EXPIRE_SESSION,
  ALLOW_ACTION,
  DENY_ACTION,
} = Ci.nsIPermissionManager;

const {
  PLUGIN_ACTIVE,
  PLUGIN_ALTERNATE,
  PLUGIN_SUPPRESSED,
  PLUGIN_CLICK_TO_PLAY,
} = Ci.nsIObjectLoadingContent;

const FLASH_MIME_TYPE = 'application/x-shockwave-flash';

function dumpError(e) {
  sendAsyncMessage('PluginSafety:BrowserEventRelay', { error: e.toString() + '\n' + e.stack });
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
          return 'allow';
        } else {
          return 'allow-and-remember';
        }
      case DENY_ACTION:
        return 'never-allow';
    }
  }

  return 'default';
}

function getDocumentHost(doc) {
  return NetUtil.newURI(doc.documentURI).prePath;
}

function getPluginInfo(pluginElement) {
  if (pluginElement instanceof Ci.nsIDOMHTMLAnchorElement) {
    return {
      mimetype: FLASH_MIME_TYPE,
    };
  }

  let mimetype;
  let fallbackType = null;

  mimetype = pluginElement.actualType;
  if (!mimetype) {
    mimetype = pluginElement.type;
  }

  if (isKnownPlugin(pluginElement)) {
    fallbackType = pluginElement.defaultFallbackType;
  }

  return {
    mimetype,
    fallbackType,
  };
}

function getPluginUI(plugin, anonid) {
  return plugin.ownerDocument
    .getAnonymousElementByAttribute(plugin, 'anonid', anonid);
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

function isKnownPlugin(objLoadingContent) {
  return (objLoadingContent.getContentTypeForMIMEType(objLoadingContent.actualType) ==
          Ci.nsIObjectLoadingContent.TYPE_PLUGIN);
}

function shouldShowOverlay(plugin) {
  let overlay = getPluginUI(plugin, 'main');

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
  util = win.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindowUtils);
  return util.outerWindowID;
}

function handlePageShow(event) {
  try {
    let doc = event.target;
    let win = doc.defaultView.self;

    const docObj = {
      host: getDocumentHost(doc),
      ctaSetting: getCtaSetting(doc.documentURI),
      flashClassification: doc.documentFlashClassification,
      is3rdParty: false,
      userAction: [],
      ctpVia: null,
      docshellId: doc.docShell.historyID.toString(),
      'user-feedback': null,
      flashObjs: null,
      subDocs: []
    };

    const payload = {
      type: event.type,
      docURI: doc.documentURI,
      isTopLevel: win.top === win,
      parentWindowID: null,
      windowID: getWindowID(win),
      docObj
    };

    if (!payload.isTopLevel) {
      payload.parentWindowID = getWindowID(win.parent);
      payload.docObj.is3rdParty = getDocumentHost(doc) != getDocumentHost(win.top.document);
    }

    if (doc.documentFlashClassification != 'allow') {
      if (doc.readyState == 'complete') {
        handleUnallowedPageLoading(event);
      } else {
        doc.addEventListener('DOMContentLoaded', listener);
      }
    }

    sendAsyncMessage('PluginSafety:BrowserEventRelay', payload);
  } catch (e) {
    dumpError(e);
  }
}

function getPluginClassificationStr(plugin, pluginInfo) {
  switch (pluginInfo.fallbackType) {
  case PLUGIN_ACTIVE: return 'allowed';
  case PLUGIN_SUPPRESSED: return 'denied';
  case PLUGIN_ALTERNATE: return 'fallback-used';
  case PLUGIN_CLICK_TO_PLAY:
    if (shouldShowOverlay(plugin)) {
      return 'ctp-overlay';
    } else {
      // NOTE: this isn't _quite_ correct, since if there are any other overlay
      // elements on the page, a bar still will not be shown. However, it's more
      // correct than returning 'ctp-overlay', and we should be able to deduce
      // whether a bar was actually shown by checking if there were any
      // ctp-overlay's in the doc.
      return 'ctp-bar';
    }
  }

  return null;
}

function handleUnallowedPageLoading(event) {
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
        if (classification == 'denied' || classification == 'fallback-used') {
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
            type: 'PluginFound',
            windowID: getWindowID(win),
            docURI: doc.documentURI,
            flashObj
          };

          sendAsyncMessage('PluginSafety:BrowserEventRelay', payload);
        }
      }
    }
  } catch (e) {
    dumpError(e);
  }
}

function handlePluginEvent(event) {
  try {
    const eventType = event.type;
    const plugin = event.target;

    const doc = event.target.ownerDocument;
    const win = doc.defaultView;

    let overlayId = null;
    if (eventType == 'PluginBindingAttached') {
      const overlay = getPluginUI(plugin, 'main');

      if (!overlay || overlay._pluginSafetyBindingHandled) {
        return;
      }
      overlay._pluginSafetyBindingHandled = true;

      overlayId = uuidGenerator.generateUUID().toString();
      overlay._pluginSafetyOverlayId = overlayId;

      const overlayClickedEvent = {
        type: 'OverlayClicked',
        overlayId
      };
      overlay.addEventListener('click', (e) => {
        sendAsyncMessage('PluginSafety:BrowserEventRelay', overlayClickedEvent);
      }, true);
    }

    const pluginInfo = getPluginInfo(plugin);

    const srcURI = getProperty('srcURI', plugin);
    const width = getProperty('width', plugin);
    const height = getProperty('height', plugin);

    const flashObj = {
      path: srcURI ? srcURI.spec : null,
      classification: getPluginClassificationStr(plugin, pluginInfo),
      is3rdParty: srcURI ? srcURI.prePath != getDocumentHost(win.top.document) : false,
      width: width ? parseInt(width) : null,
      height: height ? parseInt(height) : null,
      clickedOnOverlay: false,
    };

    const payload = {
      type: 'PluginFound',
      windowID: getWindowID(win),
      docURI: doc.documentURI,
      overlayId,
      flashObj
    };

    sendAsyncMessage('PluginSafety:BrowserEventRelay', payload);
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

    switch (event.type) {
    case 'pageshow':
      handlePageShow(event);
      break;
    case 'PluginBindingAttached':
    case 'PluginInstantiated':
      handlePluginEvent(event);
      break;
    case 'DOMContentLoaded':
      handleUnallowedPageLoading(event);
      break;
    }
  }
};

addEventListener('PluginBindingAttached', listener, true, true);
addEventListener('PluginInstantiated', listener, true, true);
addEventListener('pageshow', listener, true, true);

/* eslint-enable no-undef */
