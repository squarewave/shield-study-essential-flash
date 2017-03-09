const { Ci, Cu, Cc } = require('chrome');
const ss = require('sdk/simple-storage');

Cu.import("resource://gre/modules/TelemetryController.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/TelemetrySession.jsm");
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/ClientID.jsm");

const {
  ALLOW_ACTION,
  DENY_ACTION,
  PROMPT_ACTION,
  UNKNOWN_ACTION,
  EXPIRE_NEVER,
  EXPIRE_SESSION,
  EXPIRE_TIME,
} = Ci.nsIPermissionManager;

const ONE_DAY_MILLIS = 24 * 60 * 60 * 1000;

function ingest(data) {
  if (!ss.storage.pingEvents) {
    ss.storage.pingEvents = [];
  }
  ss.storage.pingEvents.push(data);
}

// const docObj = {
//   host: doc.location.origin,
//   flashClassification: doc.documentFlashClassification,
//   is3rdParty: false,
//   userAction: [],
//   ctpVia: null,
//   docshellId: doc.docShell.historyID,
//   'user-feedback': null,
//   flashObjs: null,
//   subDocs: []
// };

// const payload = {
//   type: event.type,
//   docURI: doc.location.docURI,
//   isTopLevel: win.top === win,
//   parentWindowID: null,
//   windowID: win.__pluginSafetyWindowID,
//   docObj
// };

// const flashObj = {
//   path: plugin.src,
//   classification: null, // TODO
//   is3rdParty: srcUri.prePath != win.top.document.location.origin,
//   width: parseInt(plugin.width),
//   height: parseInt(plugin.height),
//   clickedOnOverlay: false, // TODO
// };

// const payload = {
//   type: eventType,
//   windowID: yield getWindowID(win),
//   docURI: doc.location.docURI,
//   pluginInfo: getPluginInfo(plugin),
//   flashObj
// };

//  {
//     "host": "https://host.example.com",
//     "ctaSetting": "allow | allow-and-remember | never-allow | default",
//     "flashClassification": "unclassified | unknown | allowed | denied",
//     "is3rdParty": false,
//     "userAction": ["allow", "allow-and-remember", "deny", "page-refreshed", "feedback-given"],
//     "ctpVia": "notificationbar | overlay | urlbar-icon | null",
//     "docshellId": 1234,

//     "user-feedback": {
//         choice: "broken-video | broken-audio | etc..",
//         problemFixed: "false | true | null",
//         details: "free-form string field",
//     },

//     "flashObjs": [
//     ],

//     "subDocs": [" {...} "],

// },

// {
//     "path": "https://www.example.org/flash.swf",
//     "classification": "allowed | denied | fallback-used | ctp-overlay | ctp-bar",
//     "is3rdParty": true,
//     "width": 200,
//     "height": 200,
//     "clickedOnOverlay": false,
// },
const calculateProfileAgeInDays = Task.async(function* () {
  let ProfileAge = Cu.import("resource://gre/modules/ProfileAge.jsm", {}).ProfileAge;
  let profileAge = new ProfileAge(null, null);

  let creationDate = yield profileAge.created;
  let resetDate = yield profileAge.reset;

  // if the profile was reset, consider the
  // reset date for its age.
  let profileDate = resetDate || creationDate;

  return (Date.now() - profileDate) / ONE_DAY_MILLIS;
});

const rollUpEvents = Task.async(function* () {
  try {
    const allEvents = ss.storage.pingEvents;

    const docDict = {};
    const docsByURI = {};

    for (const event of allEvents) {
      if (event.type == "pageshow") {
        const doc = {
          host: event.docObj.host,
          ctaSetting: event.docObj.ctaSetting,
          flashClassification: event.docObj.flashClassification,
          is3rdParty: event.docObj.is3rdParty,
          userAction: event.docObj.userAction,
          ctpVia: event.docObj.ctpVia,
          docshellId: event.docObj.docshellId,
          'user-feedback': {},
          flashObjs: [],
          subDocs: [],
        };

        docDict[event.windowID] = {
          doc,
          parent: event.parentWindowID
        };

        if (event.isTopLevel) {
          docsByURI[event.docURI] = doc;
        }
      } else if (docsByURI[event.docURI]) {
        const doc = docsByURI[event.docURI];
        switch (event.type) {
          case "TellUsMore":
            doc['user-feedback'].choice = event.radioValue;
            break;
          case "TellUsMoreDetail":
            doc['user-feedback'].detail = event.detail;
            break;
          case "ProblemFixed":
            doc['user-feedback'].problemFixed = event.problemFixed;
            break;
          case "UserAction":
            doc.userAction.push(event.kind);
            break;
        }
      }
    }

    for (const event of allEvents) {
      if (event.type == "PluginInstantiated" || event.type == "PluginClickToPlay") {
        if (!docDict[event.windowID]) {
          // TODO (log?)
          console.error("no parent for " + event.docURI);
        }

        const flashObj = {
          path: event.flashObj.path,
          classification: event.flashObj.classification,
          is3rdParty: event.flashObj.is3rdParty,
          width: event.flashObj.width,
          height: event.flashObj.height,
          clickedOnOverlay: false, // TODO
        };

        docDict[event.windowID].doc.flashObjs.push(flashObj);
      }
    }

    const docsRaw = [];
    for (const [_, {doc, parent}] of Object.entries(docDict)) {
      if (parent) {
        // NOTE: since we clear our events, if events from subdocs come in later,
        // we don't have a parent doc to associate them with. Unfortunately the
        // best thing we can do is discard them. If we treat them as top-level
        // docs that will skew the data.
        if (!docDict[parent]) {
          continue;
        }
        docDict[parent].doc.subDocs.push(doc);
      } else {
        docsRaw.push(doc);
      }
    }

    function hasAnyFlashObjs(doc) {
      return doc.flashObjs.length || doc.subDocs.some(hasAnyFlashObjs);
    }

    const docs = docsRaw.filter(hasAnyFlashObjs);

    const telemetryMetadata = TelemetrySession.getMetadata();

    const profileService = Cc["@mozilla.org/toolkit/profile-service;1"]
                           .getService(Ci.nsIToolkitProfileService);

    const payload = {
      clientID: ClientID.getCachedClientID(),
      // mainPing: 123,
      locale: Services.prefs.getCharPref('general.useragent.locale'),
      geo: null, // TODO
      flashVersion: telemetryMetadata.flashVersion,
      datetime: Date.now(),
      profileAge: yield calculateProfileAgeInDays(),
      daysInExperiment: (Date.now() - ss.storage.experimentStart) / ONE_DAY_MILLIS,
      experimentGroup: null, // TODO
      docs
    };

    const options = {
      addClientId: true,
      addEnvironment: true,
    };

    TelemetryController.submitExternalPing("flash-shield-study", payload, options);

    ss.storage.pingEvents = [];
  }
  catch (e) {
    console.error(e.toString());
  }
});

function init() {
  ss.storage.experimentStart = Date.now();
}

module.exports = {
  ingest,
  rollUpEvents
};