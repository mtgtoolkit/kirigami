'use strict';
const path = require('node:path');
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.js$/,
  workers: 1,
  timeout: 10 * 60 * 1000,
  reporter: 'list',
  outputDir: path.join(__dirname, '..', '..', 'test-results', 'artifacts'),
});
