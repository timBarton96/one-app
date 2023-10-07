/*
 * Copyright 2019 American Express Travel Related Services Company, Inc.
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
import fs from 'node:fs/promises';
import path from 'node:path';

import ivm from 'isolated-vm';
import hash from 'object-hash';


import { getServerStateConfig } from './stateConfig';

import { CONFIGURATION_KEY } from './onModuleLoad';
// import { getServerStateConfig } from './stateConfig';
import { setClientModuleMapCache } from './clientModuleMapCache';
import { updateCSP } from '../plugins/csp';
import addBaseUrlToModuleMap from './addBaseUrlToModuleMap';

let cachedModuleMapHash;
let rejectedModulesCache = {};

const ROOT_PROJECT_PATH = path.resolve(__dirname, '../../../');
const NODE_MODULES_PATH = `${path.resolve(ROOT_PROJECT_PATH, 'node_modules')}${path.sep}`;

function evalReturnPromise(context, codeThatReturnsAPromise, timeout = 1e3) {
  return new Promise(async (resolve, reject) => {
    await context.evalClosure(
      `
        (loadModules()).then(
          (result) => {
            $1.apply(
              undefined,
              [
                null,
                new $0.ExternalCopy(result).copyInto({ release: true, transferIn: true })
              ],
              { reference: true }
            );
          },
          (error) => {
            $1.apply(
              undefined,
              [
                new $0.ExternalCopy(error).copyInto({ release: true, transferIn: true })
              ],
              { reference: true }
            );
          }
        );
      `,
      [
        ivm,
        new ivm.Reference((error, result) => {
          if (error) {
            return reject(error);
          }
          return resolve(result);
        }),
      ],
      { timeout }
    );
  })
}

async function loadNodeModuleSource(request, referrerFilename = null) {
  if (request.startsWith('node:') || ['assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'crypto', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'https', 'http2', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'test', 'tls', 'trace_events', 'tty', 'dgram', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'].includes(request.replace('\/.+', ''))) {
    console.warn(`attempted to load ${request} (from ${referrerFilename})`);
    // return { code: '', filename: request };
    throw new Error(`attempt to load Node.js supplied module: "${request}"`);
  }

  if (request === 'require-from-string') {
    console.warn(`attempt to load ${request} (from ${referrerFilename})`);
    // return { code: '', filename: request };
    throw new Error('unimplemented');
  }

  if (request.startsWith(NODE_MODULES_PATH)) {
    request = request.substr(NODE_MODULES_PATH.length);
  }

  // console.info(`resolving "${request}" to later load from disk`);
  const filename = require.resolve(request);
  console.info(`resolved "${request}" to "${filename}" and loading from disk`);
  const code = await fs.readFile(filename);
  return { code, filename };
}

async function compileNodeModule(isolate, compiledMap, moduleSource) {
  const { code, ...options } = moduleSource;
  const { filename } = options;

  if (!filename) {
    console.error(moduleSource);
    throw new Error('need the filename for resolution stuffs');
  }

  const fullCode = code.toString('utf-8');
  const module = await isolate.compileModule(fullCode, options);
  compiledMap.set(module, filename);
  // can also get a head start on resolving `module.dependencySpecifiers`
  // https://github.com/laverdet/isolated-vm#moduledependencyspecifiers
  return module;
}

const loadModules = async () => {
  const moduleMapResponse = await fetch(process.env.HOLOCRON_MODULE_MAP_URL);
  const moduleMap = addBaseUrlToModuleMap(await moduleMapResponse.json());

  const moduleMapHash = hash(moduleMap);
  if (cachedModuleMapHash && cachedModuleMapHash === moduleMapHash) {
    return { loadedModules: {}, rejectedModules: rejectedModulesCache };
  }
  cachedModuleMapHash = moduleMapHash;
  const serverConfig = getServerStateConfig();

  const isolate = new ivm.Isolate({ memoryLimit: 128 });

  const holocronServerSource = await loadNodeModuleSource(path.join(ROOT_PROJECT_PATH, 'lib/server/vm/holocron-server.js'));

  const compiledMap = new Map();

  const holocronServerModule = await compileNodeModule(isolate, compiledMap, holocronServerSource);

  const context = await isolate.createContext();
  const contextGlobal = context.global;
  await contextGlobal.set('global', contextGlobal.derefInto());
  // FIXME: add safeguards
  await contextGlobal.set('getModuleMap', function getModuleMap() { return moduleMap; });
  await contextGlobal.set('getServerStateConfig', getServerStateConfig);

  await contextGlobal.set('log', function (...args) { console.log(...args); });

  // this is an attempt at cheating to avoid re-implementing fetch, which to do right will probably
  // require Transferrable calls in the implementation
  // spoiler: this doesn't work
  // https://github.com/laverdet/isolated-vm/issues/257#issuecomment-1650695653
  await context.evalClosure(
    `
      function Response() {}
      Response.prototype.text = Promise.resolve('hello');
      globalThis.fetch = function fetch(url, options) {
        return new Promise((resolve, reject) => {
          function resolver(transferrableResponse) {
            const response = transferrableResponse.copy();
            log('got a response', typeof response.copy);
            log('typeof?', typeof response);
            log('ok?', response.ok);
            log('status?', response.status);
            log('statusText?', response.statusText);
            log('deref?', typeof response.deref);
            log('keys?', Object.keys(response));
            log('text?', typeof response.text);
            log('json?', typeof response.json);
            log('name?', response.constructor.name); // Object instead of Response
            // need to preserve the constructor...or have this fetch implementation be a facade of
            // transferring data from the Node.js isolate
            resolve(response);
          }

          $1.apply(
            undefined,
            [
              new $0.ExternalCopy(url).copy(),
              new $0.ExternalCopy(options).copy(),
              new $0.Reference(resolver),
              new $0.Reference(reject),
            ],
            { reference: true }
          );
        });
      }
    `,
    [
      ivm,
      new ivm.Reference(function fetchBridge(url, options, resolve, reject) {
        fetch(url, options).then(
          (response) => {
            // console.log('response', response);
            console.log('response', { ok: response.ok, status: response.status, statusText: response.statusText });
            console.log('response keys', Object.keys(response));
            console.log('response', response.constructor.name);
            resolve.apply(
              undefined,
              // [new ivm.ExternalCopy(response).copyInto({ release: true, transferIn: true })],
              [new ivm.ExternalCopy(response)],
              { timeout: 1000}
            );
          },
          (error) => {
            console.error('error', error);
            reject.apply(
              undefined,
              // [new ivm.ExternalCopy(error).copyInto({ release: true, transferIn: true })],
              [new ivm.ExternalCopy(error).copyInto({ transferIn: true })],
              { timeout: 1000}
            );
          },
        );
      }),
    ],
    { timeout: 1e3}
  );

  await holocronServerModule.instantiate(context, () => undefined);
  await holocronServerModule.evaluate(); // undefined

  // would like to
  // const loadModulesResult = await context.eval('loadModules()', { promise: true });
  // but the data structure is deep so need to use ExternalCopy
  const loadModulesResult = await evalReturnPromise(context, 'loadModules()');
  console.log('loadModulesResult', loadModulesResult);
  const { loadedModules, rejectedModules } = loadModulesResult;

  rejectedModulesCache = rejectedModules;
  const loadedModuleNames = Object.keys(loadedModules);

  if (loadedModuleNames.length > 0) {
    setClientModuleMapCache(moduleMap);
  }

  const rootModuleLoaded = loadedModuleNames.includes(serverConfig.rootModuleName);

  if (rootModuleLoaded) {
    const RootModule = getModule(serverConfig.rootModuleName);
    const { [CONFIGURATION_KEY]: { csp } = {} } = RootModule;
    updateCSP(csp);
  }

  // TODO: only if there is an error loading modules or a new map of modules was successfully loaded and set up
  isolate.dispose();

  return { loadedModules, rejectedModules };
};

export default loadModules;
