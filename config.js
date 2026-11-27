/*
 * Settings for the Northlight demo site. Plain values only: no passwords, keys or other secrets belong here.
 * Works in the browser (global NorthlightConfig) and in Node (require) for tests.
 */
(function () {
  'use strict';

  var config = Object.freeze({
    // Shown on the settings page and written into exported files.
    appName: 'Northlight Studio',
    // Every localStorage key this site owns starts with this. The export marks records that do.
    storagePrefix: 'northlight-',
    // Where the settings page reads the name, version and build date from.
    healthUrl: 'health.json',
    // The "Export all data" file: its name starts with filePrefix, and formatVersion changes
    // whenever the layout of the file changes.
    export: Object.freeze({
      filePrefix: 'northlight-export',
      formatVersion: 1
    })
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = config;
  else globalThis.NorthlightConfig = config;
})();
