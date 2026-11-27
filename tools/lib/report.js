'use strict';

function format(r) {
  return r.status.padEnd(4) + '  ' + r.label + ': ' + r.detail;
}

module.exports = { format };
