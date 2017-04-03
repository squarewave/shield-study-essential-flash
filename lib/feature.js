/** feature.js **/
const { Ci, Cu } = require('chrome');
const prefs = require('sdk/preferences/service');
const ss = require('sdk/simple-storage');

const ui = require('./ui');
const dataCollection = require('./dataCollection');

const { AddonManager } = Cu.import('resource://gre/modules/AddonManager.jsm', {});

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

exports.which = function (val) {
  if (val === 'on') {
    prefs.set('plugins.flashBlock.enabled', true);
    prefs.set('plugins.favorfallback.mode', 'follow-ctp');
    prefs.set('plugins.favorfallback.rules', 'video');
    prefs.set('plugins.flashBlock.experiment.active', true);
  }

  prefs.set('plugin.state.flash', Ci.nsIPluginTag.STATE_CLICKTOPLAY);

  ui.init();
  dataCollection.init();
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
