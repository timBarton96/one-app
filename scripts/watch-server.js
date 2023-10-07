#!/usr/bin/env node

/*
 * Copyright 2020 American Express Travel Related Services Company, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
 * or implied. See the License for the specific language governing
 * permissions and limitations under the License.
 */

const { spawn } = require('child_process');
const buildServiceWorkerScripts = require('./build-service-workers');

(async function dev() {
  const { watcher: serviceWorkerWatcher } = await buildServiceWorkerScripts({ dev: true, watch: true, minify: false });
  serviceWorkerWatcher.on('event', (event) => {
    switch (event.code) {
      case 'ERROR':
        console.error(event.error);
        break;
      case 'START':
        console.log('Service Workers have %sed building', event.code.toLowerCase());
        break;
      case 'BUNDLE_END':
        console.log('Service Workers built in %d seconds', event.duration / 1000);
        break;
      default:
        break;
    }
  });

  const babelWatch = spawn('npm', ['run', 'build:server:node', '--', '--watch'], {
    stdio: 'inherit',
    killSignal: 'SIGINT',
  });

  const esbuildWatch = spawn('npm', ['run', 'build:server:vm', '--', '--watch'], {
    stdio: 'inherit',
    killSignal: 'SIGINT',
  });

  const flags = process.argv.filter((arg) => [
    '--log-format',
    '--log-level',
    '--module-map-url',
    '--root-module-name',
    '--use-host',
    '--use-middleware',
  ].find((argName) => arg.startsWith(argName)));

  const nodemon = spawn('nodemon', [
    '--signal', 'SIGTERM', '--watch', 'src', '--ext', 'js,jsx', 'lib/server/index.js',
  ].concat(flags.length > 0 ? ['--', ...flags] : []), {
    stdio: 'inherit',
    killSignal: 'SIGINT',
  });

  process.on('exit', (code) => {
    serviceWorkerWatcher.close();
    babelWatch.kill(code);
    esbuildWatch.kill(code);
    nodemon.kill(code);
  });
}());
