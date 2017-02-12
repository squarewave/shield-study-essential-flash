require("../lib/index");
const { Cc, Ci } = require("chrome");

const tabs = require("sdk/tabs");
const { setTimeout } = require('sdk/timers');
const { resolve } = require('sdk/fs/path');
const { data } = require('sdk/self');
const { viewFor } = require('sdk/view/core');
const { browserWindows } = require('sdk/windows');

const { startServerAsync } = require('./httpd');

var srv = startServerAsync(2000);
require("sdk/system/unload").when(function cleanup() {
  srv.stop(function() { // you should continue execution from this point.
  })
});

srv.registerPathHandler("/testFlashDoc", (req, res) => {
  res.write(`
<!DOCTYPE HTML>
<html>
<head>
  <title>Test Essential Flash</title>
</head>
<h1>Testing...</h1>
<body><object type="application/x-shockwave-flash"><embed src="not_here.swf"></object></body>
</html>
`);
});

exports['test main async'] = function(assert, done) {
  assert.pass('async Unit test running!');
  tabs.open("http://localhost:2000/testFlashDoc");
  setTimeout(done, 500000);
};

require('sdk/test').run(exports);
