#!/usr/bin/env node
const path = require('path');

const invokedAs = path.basename(process.argv[1] || '');
if (invokedAs === 'badclaude' || invokedAs === 'badclaude.cmd') {
  console.warn('[DEPRECATED] "badclaude" has been renamed to "openwhip".');
}

require('./start.js');
