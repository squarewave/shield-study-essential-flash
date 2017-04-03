/** study.js **/
const self = require('sdk/self');
const shield = require('shield-studies-addon-utils');
const { when: unload } = require('sdk/system/unload');

const feature = require('./feature');

const PROBABILITY_OF_CONTROL_GROUP = 0.5;

const studyConfig = {
  name: self.addonId,
  duration: 14,
  surveyUrls:  {
    'end-of-study': 'https://qsurvey.mozilla.com/s3/shield-plugin-sec-eos',
    'user-ended-study': 'https://qsurvey.mozilla.com/s3/shield-plugin-sec-eos',
    'ineligible':  null
  },
  variations: {
    'on': () => feature.which('on'),
    'control': () => feature.which('control'),
  }
};

class OurStudy extends shield.Study {
  constructor (config) {
    super(config);
  }
  isEligible () {
    // bool Already Has the feature.  Stops install if true
    return super.isEligible() && feature.isEligible();
  }
  whenIneligible () {
    super.whenIneligible();
  }
  whenInstalled () {
    super.whenInstalled();

    // TODO: actually have this as a variation
    if (this.variation === 'none') {
      // noop
    }
    feature.orientation(this.variation);
  }
  cleanup (reason) {
    super.cleanup();  // cleanup simple-prefs, simple-storage
    feature.cleanup();
    // do things, maybe depending on reason, branch
  }
  whenComplete () {
    // when the study is naturally complete after this.days
    super.whenComplete();  // calls survey, uninstalls
  }
  whenUninstalled () {
    // user uninstall
    super.whenUninstalled();
  }
  decideVariation () {
    const rng = Math.random();
    if (rng < PROBABILITY_OF_CONTROL_GROUP) {
      return 'control';
    } else {
      return 'on';
    }
  }
}

const thisStudy = new OurStudy(studyConfig);

// for testing / linting
exports.OurStudy = OurStudy;
exports.studyConfig = studyConfig;

// for use by index.js
exports.study = thisStudy;

unload((reason) => thisStudy.shutdown(reason));
