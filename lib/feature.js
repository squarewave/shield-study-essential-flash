/** feature.js **/
const { Ci, Cu, Cc } = require('chrome');
const prefs = require('sdk/preferences/service');
const ss = require('sdk/simple-storage');

const ui = require('./ui');
const dataCollection = require('./dataCollection');

Cu.import('resource://gre/modules/Preferences.jsm');
const { AddonManager } = Cu.import('resource://gre/modules/AddonManager.jsm', {});

const prefObj = new Preferences();

const OUR_PREFS = [
  'plugins.flashBlock.enabled',
  'plugins.favorfallback.mode',
  'plugins.favorfallback.rules',
  'plugins.flashBlock.experiment.active',
  'plugin.state.flash',
];

let flashIsRightForStudy = ss.storage.flashRightForStudy;

exports.init = function () {
  return new Promise((resolve) => {
    if (prefs.get('plugin.state.flash') !== Ci.nsIPluginTag.STATE_ENABLED || flashIsRightForStudy) {
      resolve();
    } else {
      AddonManager.getAddonsByTypes(['plugin'], plugins => {
        for (const addon of plugins) {
          if (addon.name === 'Shockwave Flash') {
            if (addon.isActive) {
              if (ss.storage.flashRightForStudy !== true) {
                const goodVersion = addon.blocklistState === Ci.nsIBlocklistService.STATE_NOT_BLOCKED;
                ss.storage.flashRightForStudy = goodVersion;
              }

              flashIsRightForStudy = ss.storage.flashRightForStudy;
            }
            break;
          }
        }
        resolve();
      });
    }
  });
};

exports.which = async function (variation) {
  if (shavarListsHaveBeenUpdated()) {
    startStudy(variation);
  } else {
    const shavarUpdatePref = 'browser.safebrowsing.provider.mozilla.lastupdatetime';

    prefObj.observe(shavarUpdatePref, async function prefObserver() {
      prefObj.ignore(shavarUpdatePref, prefObserver);
      if (prefs.get('plugins.flashBlock.enabled', false) && shavarListsHaveBeenUpdated()) {
        startStudy(variation);
      }
    });

    prefs.set('browser.safebrowsing.provider.mozilla.nextupdatetime', '1');
    prefs.set('plugins.flashBlock.enabled', true);
  }

  // NOTE: we init the UI regardless of our group to ensure that the control group
  // incurs the same overhead, however small, of our UI. The UI shouldn't actually end
  // up doing anything for a control user though, other than reporting page refreshes.
  ui.init(variation);
  dataCollection.init(variation);
};

exports.isEligible = function () {
  if (!flashIsRightForStudy) {
    return false;
  }

  return true;
};

exports.cleanup = function () {
  OUR_PREFS.forEach(p => prefs.reset(p));

  ui.uninit();
  dataCollection.uninit();
};

exports.orientation = function() {
  // noop
};

function startStudy(variation) {
  if (variation == 'on') {
    if (!prefs.get('plugins.flashBlock.enabled', false)) {
      prefs.set('plugins.flashBlock.enabled', true);
    }
    prefs.set('plugins.favorfallback.mode', 'follow-ctp');
    prefs.set('plugins.favorfallback.rules', 'video');
    prefs.set('plugins.flashBlock.experiment.active', true);
    prefs.set('plugin.state.flash', Ci.nsIPluginTag.STATE_CLICKTOPLAY);
  } else {
    if (prefs.get('plugins.flashBlock.enabled', false)) {
      prefs.set('plugins.flashBlock.enabled', false);
    }
  }
}

function shavarListsHaveBeenUpdated() {
  if (ss.storage.shavarListsHaveBeenUpdated) {
    return true;
  }

  let classifier = Cc['@mozilla.org/url-classifier/dbservice;1']
                     .getService(Ci.nsIURIClassifier);
  let { NetUtil } = Cu.import('resource://gre/modules/NetUtil.jsm', {});
  let table = prefs.get('urlclassifier.flashSubDocTable');
  let uri = NetUtil.newURI('https://nightly.flashstudy.example.com');

  let result = false;
  try {
    result = classifier.classifyLocal(uri, table) != "";
  } catch (e) {
    // Ignore errors just in case and return false
  }

  ss.storage.shavarListsHaveBeenUpdated = result;
  return result;
}
