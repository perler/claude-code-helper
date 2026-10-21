#!/usr/bin/env node
// Tests hostingTarget in lib/newtask.js: an entry naming one of our ds<number> servers
// goes to the Hosting project, never to the client DS (Pat, 2026-10-21).
//
// Run: node test/hosting-target.test.js
const assert = require('assert'), Module = require('module');
const load = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? {} : load(req, ...rest));
const { hostingTarget } = require('../lib/newtask.js');

const hosting = { id: 'asana:1202292541537965', name: '🗄️ Hosting' };
const targets = [{ id: 'client:DS', name: 'DS' }, hosting, { id: 'repo:infra', name: 'infra' }];

assert.strictEqual(hostingTarget('why is ds042 image tag frozen?', targets), hosting);
assert.strictEqual(hostingTarget('DS047 mail queue stuck', targets), hosting);
assert.strictEqual(hostingTarget('email Splashtop am Server zu Hause blockiert (Atera)', targets), null);
assert.strictEqual(hostingTarget('DS notebook backup', targets), null);
assert.strictEqual(hostingTarget('ds042 down', [{ id: 'client:DS', name: 'DS' }]), null);
console.log('hosting-target: ok');
