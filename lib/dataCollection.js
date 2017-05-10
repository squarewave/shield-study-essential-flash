const { Ci, Cu, Cc } = require('chrome');
const ss = require('sdk/simple-storage');
const { setInterval } = require('sdk/timers');
const { browserWindows } = require('sdk/windows');
const { data } = require('sdk/self');
const { viewFor } = require('sdk/view/core');

const { TelemetryController } = Cu.import('resource://gre/modules/TelemetryController.jsm', {});
const { NetUtil } = Cu.import('resource://gre/modules/NetUtil.jsm', {});
const { Services } = Cu.import('resource://gre/modules/Services.jsm', {});
const { TelemetrySession } = Cu.import('resource://gre/modules/TelemetrySession.jsm', {});
const { Task } = Cu.import('resource://gre/modules/Task.jsm', {});
const { ClientID } = Cu.import('resource://gre/modules/ClientID.jsm', {});

const ONE_DAY_MILLIS = 24 * 60 * 60 * 1000;

let variation = null;

function ingest(data) {
  if (!ss.storage.pingEvents) {
    ss.storage.pingEvents = [];
  }
  ss.storage.pingEvents.push(data);
}

function tryGetCharPref(name, def) {
  try {
    return Services.prefs.getCharPref(name);
  } catch (e) {
    return def;
  }
}

function getExperimentGroup() {
  const classifier = Cc['@mozilla.org/url-classifier/dbservice;1']
                     .getService(Ci.nsIURIClassifier);
  const weeks = [8,7,6,5,4,3,2,1];
  const uris = weeks.map(w => NetUtil.newURI(`http://week${w}.flashstudy.example.com`));
  const table = Services.prefs.getCharPref('urlclassifier.flashTable');

  let result = 'test-waiting';
  for (let i = 0; i < uris.length; i++) {
    const match = classifier.classifyLocal(uris[i], table);

    if (match.length) {
      result = `week${weeks[i]}`;
      break;
    }
  }

  if (variation === 'control' && result === 'test-waiting') {
    result = 'control-waiting';
  }

  return result;
}

function pruneDocsForFlash(docs) {
  return docs.filter(d => {
    // a destructive filter is a bit gross, but it's the best
    // way I can think of to express this
    d.subDocs = pruneDocsForFlash(d.subDocs);
    return d.subDocs.length || d.flashObjs.length;
  });
}

const calculateProfileAgeInDays = Task.async(function* () {
  let ProfileAge = Cu.import('resource://gre/modules/ProfileAge.jsm', {}).ProfileAge;
  let profileAge = new ProfileAge(null, null);

  let creationDate = yield profileAge.created;
  let resetDate = yield profileAge.reset;

  // if the profile was reset, consider the
  // reset date for its age.
  let profileDate = resetDate || creationDate;

  return (Date.now() - profileDate) / ONE_DAY_MILLIS;
});

function rollUpEvents() {
  try {
    const allEvents = ss.storage.pingEvents || [];
    ss.storage.pingEvents = [];

    const docDict = {};
    const modifiersByWindowID = {};

    const counts = {
      totalDocs: 0,
      flashDocs: 0,

      flashObjs: {
        total: 0,
        fallbacked: 0,
        allowed: 0,
        denied: 0,
        ctp: 0
      },

      'user-action': {
        allow: 0,
        'allow-and-remember': 0,
        'deny': 0,
        'feedback-given': 0,
      }
    };

    for (const event of allEvents) {
      if (event.type === 'pageshow') {
        const doc = {
          host: event.docObj.host,
          ctaSetting: event.docObj.ctaSetting,
          flashClassification: event.docObj.flashClassification,
          is3rdParty: event.docObj.is3rdParty,
          userAction: event.docObj.userAction,
          ctpVia: event.docObj.ctpVia, // TODO
          docshellId: event.docObj.docshellId,
          'user-feedback': {},
          flashObjs: [],
          subDocs: [],
        };

        docDict[event.windowID] = {
          doc,
          parent: event.parentWindowID
        };
      } else if (docDict[event.windowID]) {
        const { doc } = docDict[event.windowID];
        switch (event.type) {
        case 'Modifier':
          modifiersByWindowID[event.windowID] = event.kind;
          break;
        case 'TellUsMore':
          doc['user-feedback'].choice = event.radioValue;
          break;
        case 'TellUsMoreDetail':
          doc['user-feedback'].detail = event.detail;
          break;
        case 'ProblemFixed':
          doc['user-feedback'].problemFixed = event.problemFixed;
          break;
        case 'UserAction':
          let countKey = null;
          switch (event.kind) {
          case 'allow-and-remember':
          case 'allow':
            countKey = event.kind;
            if (modifiersByWindowID[event.windowID] == 'brick-clicked') {
              doc.ctpVia = 'urlbar-icon';
            } else if (modifiersByWindowID[event.windowID] == 'overlay-clicked') {
              doc.ctpVia = 'overlay';
            } else {
              doc.ctpVia = 'notificationbar';
            }
            break;
          case 'deny':
            countKey = 'never-allow';
            doc.ctpVia = null;
            break;
          case 'feedback-given':
            countKey = event.kind;
            break;
          }

          if (countKey) {
            counts['user-action'][countKey]++;
          }
          doc.userAction.push(event.kind);
          break;
        }
      }
    }

    const overlays = {};
    const seenPlugins = {};

    for (const event of allEvents) {
      if (event.type === 'PluginFound') {
        if (!docDict[event.windowID]) {
          // NOTE: see note below on subdocs.
          continue;
        }

        if (seenPlugins[event.windowID + ':' + event.flashObj.path]) {
          // try to dedupe these
          continue;
        }
        seenPlugins[event.windowID + ':' + event.flashObj.path] = true;

        counts.flashObjs.total++;
        switch (event.flashObj.classification) {
        case 'allowed':
          counts.flashObjs.allowed++;
          break;
        case 'fallback-used':
          counts.flashObjs.fallbacked++;
          break;
        case 'denied':
          counts.flashObjs.denied++;
          break;
        case 'ctp-overlay':
        case 'ctp-bar':
          counts.flashObjs.ctp++;
          break;
        }

        const flashObj = {
          path: event.flashObj.path,
          classification: event.flashObj.classification,
          is3rdParty: event.flashObj.is3rdParty,
          width: event.flashObj.width,
          height: event.flashObj.height,
          clickedOnOverlay: false, // TODO
        };

        if (event.overlayId) {
          overlays[event.overlayId] = flashObj;
        }

        docDict[event.windowID].doc.flashObjs.push(flashObj);
      } else if (event.type === 'OverlayClicked') {
        if (overlays[event.overlayId]) {
          overlays[event.overlayId].clickedOnOverlay = true;
        }
      }
    }

    const docsRaw = [];
    for (const entry of Object.entries(docDict)) {
      const {doc, parent} = entry[1];

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

    const docs = pruneDocsForFlash(docsRaw);

    const telemetryMetadata = TelemetrySession.getMetadata();

    counts.totalDocs = docsRaw.length;
    counts.flashDocs = docs.length;

    const daysInExperiment = (Date.now() - ss.storage.experimentStart) / ONE_DAY_MILLIS;

    const payload = {
      clientID: ClientID.getCachedClientID(),
      locale: tryGetCharPref('general.useragent.locale', 'zz-ZZ'),
      geo: tryGetCharPref('browser.search.countryCode', 'ZZ'),
      flashVersion: telemetryMetadata.flashVersion,
      datetime: Date.now(),
      profileAge: Math.floor(daysInExperiment + ss.storage.profileAgeInDays),
      daysInExperiment: Math.floor(daysInExperiment),
      experimentGroup: getExperimentGroup(),
      docs,
      counts
    };

    const options = {};

    TelemetryController.submitExternalPing('flash-shield-study', payload, options);
  } catch (e) {
    console.error(e.toString() + '\n' + e.stack);
  }
}

let rollUpInterval;

function wireUpWindow(win) {
  const chromeGlobal = viewFor(win);
  const mm = chromeGlobal.getGroupMessageManager('browsers');
  mm.loadFrameScript(data.url('dataCollection.js'), true);

  mm.addMessageListener('PluginSafety:BrowserEventRelay', (msg) => {
    if (msg.data.error) {
      console.log(msg.data);
    } else {
      ingest(msg.data);
    }
  });
}

const init = Task.async(function* (which) {
  // Ensure that we have no events on init. It's possible that during
  // a shutdown ping, this list was cleared but the new value was not
  // flushed to disk.
  ss.storage.pingEvents = [];

  variation = which;

  if (!ss.storage.experimentStart) {
    ss.storage.experimentStart = Date.now();
    ss.storage.profileAgeInDays = yield calculateProfileAgeInDays();
  }

  for (let win of browserWindows) {
    wireUpWindow(win);
  }

  browserWindows.on('open', wireUpWindow);

  // roll up events every four hours
  rollUpInterval = setInterval(rollUpEvents, 1000 * 60 * 60 * 4);
  Services.obs.addObserver(rollUpEvents, 'profile-before-change', false);
});


function uninit() {
  rollUpEvents();
  Services.obs.removeObserver(rollUpEvents, 'profile-before-change');
  clearInterval(rollUpInterval);
}

module.exports = {
  ingest,
  rollUpEvents,
  init,
  uninit,
};
