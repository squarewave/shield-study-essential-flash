/** index.js **/
const self = require('sdk/self');

require('./feature').init().then(() => {
  require('./study').study.startup(self.loadReason);
});
