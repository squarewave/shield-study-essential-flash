/** feature.js **/
const prefs = require('sdk/preferences/service');

const ui = require('./ui');
const utils = require('./utils');

const OUR_PREFS = [
  'plugins.flashBlock.enabled',
  'plugins.favorfallback.mode',
  'plugins.favorfallback.rules',
  'plugins.flashBlock.experiment.active',
];

let flashIsAlwaysActive = false;

exports.init = function () {
  return new Promise((resolve) => {
    const AddonManager = utils.getActiveChromeGlobal().AddonManager;
    AddonManager.getAllAddons(addons => {
      for (const addon of addons) {
        if (addon.name === 'Shockwave Flash') {
          if (addon.isActive &&
              addon.userDisabled !== AddonManager.STATE_ASK_TO_ACTIVATE) {
            flashIsAlwaysActive = true;
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
    prefs.set('plugins.favorfallback.mode', 'follow-ctp');
    prefs.set('plugins.favorfallback.rules', 'embed,adobelink,installinstructions,true');
    prefs.set('plugins.flashBlock.experiment.active', true);

    ui.init();
  }
};

exports.isEligible = function () {
  if (OUR_PREFS.some(p => prefs.isSet(p))) {
    return false;
  }

  if (!flashIsAlwaysActive) {
    return false;
  }

  return true;
};

exports.reset = function () {
  OUR_PREFS.forEach(p => prefs.reset(p));
};
