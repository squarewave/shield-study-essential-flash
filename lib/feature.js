/** feature.js **/
const { Ci, Cu } = require('chrome');
const prefs = require('sdk/preferences/service');
const { data } = require('sdk/self');
const tabs = require('sdk/tabs');
const ss = require('sdk/simple-storage');

const ui = require('./ui');
const dataCollection = require('./dataCollection');
const utils = require('./utils');

Cu.import("resource://gre/modules/AddonManager.jsm");

const OUR_PREFS = [
  'plugins.flashBlock.enabled',
  'plugins.favorfallback.mode',
  'plugins.favorfallback.rules',
  'plugins.flashBlock.experiment.active',
];

let flashIsRightForStudy = false;

exports.init = function () {
  return new Promise((resolve) => {
    AddonManager.getAddonsByTypes(['plugin'], plugins => {
      for (const addon of plugins) {
        if (addon.name === 'Shockwave Flash') {
          if (addon.isActive &&
              addon.userDisabled !== AddonManager.STATE_ASK_TO_ACTIVATE) {
            if (ss.storage.flashGoodVersion !== true) {
              const goodVersion = addon.blocklistState == Ci.nsIBlocklistService.STATE_NOT_BLOCKED;
              ss.storage.flashGoodVersion = goodVersion;
            }

            flashIsRightForStudy = ss.storage.flashGoodVersion;
          }
          break;
        }
      }
      resolve();
    });
  });
};

exports.which = function (val) {
  if (val === 'on') {
    prefs.set('plugins.flashBlock.enabled', true);
    prefs.set('plugins.favorfallback.mode', 'always');
    prefs.set('plugins.favorfallback.rules', 'embed,installinstructions,adobelink,true');
    prefs.set('plugins.flashBlock.experiment.active', true);

    ui.init();
    dataCollection.init();
  }
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