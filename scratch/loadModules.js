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
import { promisify } from 'node:util';

// import { getModule } from 'holocron';
// import { updateModuleRegistry } from 'holocron/server';
import ivm from 'isolated-vm';
import hash from 'object-hash';

// import { transform as transformCallback } from '@babel/core';
// import asdf from '@babel/preset-react';

import { getServerStateConfig } from './stateConfig';

import onModuleLoad, { CONFIGURATION_KEY } from './onModuleLoad';
import batchModulesToUpdate from './batchModulesToUpdate';
import getModulesToUpdate from './getModulesToUpdate';
// import { getServerStateConfig } from './stateConfig';
import { setClientModuleMapCache } from './clientModuleMapCache';
import { updateCSP } from '../plugins/csp';
import addBaseUrlToModuleMap from './addBaseUrlToModuleMap';

// const transform = promisify(transformCallback);

let cachedModuleMapHash;
let rejectedModulesCache = {};

const ROOT_PROJECT_PATH = path.resolve(__dirname, '../../../');
const NODE_MODULES_PATH = `${path.resolve(ROOT_PROJECT_PATH, 'node_modules')}${path.sep}`;

function evalReturnPromise(context, codeThatReturnsAPromise, timeout = 1e3) {
  return new Promise(async (resolve, reject) => {
    await context.evalClosure(
      `
        (${codeThatReturnsAPromise}).then(
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

// const cannotImportDirectly = new Map([
//   [path.join(NODE_MODULES_PATH, 'holocron/src/holocronModule'), {
//     usable: path.join(ROOT_PROJECT_PATH, 'lib/server/vm', 'holocronModule.js'),
//     wouldResolveAs: path.join(NODE_MODULES_PATH, 'holocron/src/holocronModule'),
//   }],
//   // [path.join(NODE_MODULES_PATH, 'prop-types'), {
//   ['prop-types', {
//     usable: path.join(ROOT_PROJECT_PATH, 'lib/server/vm', 'prop-types.js'),
//     wouldResolveAs: path.join(NODE_MODULES_PATH, 'prop-types/index.js'),
//   }],
//   // [path.join(NODE_MODULES_PATH, 'holocron/src/holocronModule.jsx'), path.join(ROOT_PROJECT_PATH, 'lib/server/vm', 'holocronModule.js')],
//   // [path.join(NODE_MODULES_PATH, 'prop-types/index.js'), path.join(ROOT_PROJECT_PATH, 'lib/server/vm', 'prop-types.js')],
// ]);

async function loadNodeModuleSource(request, referrerFilename = null) {
  if (request.startsWith('node:') || ['assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'crypto', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'https', 'http2', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'test', 'tls', 'trace_events', 'tty', 'dgram', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'].includes(request.replace('\/.+', ''))) {
    console.warn(`attempted to load ${request} (from ${referrerFilename})`);
    return { code: '', filename: request };
    throw new Error(`attempt to load Node.js supplied module: "${request}"`);
  }

  if (request === 'require-from-string') {
    console.warn(`attempt to load ${request} (from ${referrerFilename})`);
    // return { code: '', filename: request };
    throw new Error('unimplemented');
  }

  // console.log(request);
  // if (cannotImportDirectly.has(request)) {
  //   const { usable, wouldResolveAs } = cannotImportDirectly.get(request);
  //   const code = await fs.readFile(usable);
  //   return { code, filename: wouldResolveAs };
  // }

  if (request.startsWith(NODE_MODULES_PATH)) {
    request = request.substr(NODE_MODULES_PATH.length);
  }

  console.info(`resolving "${request}" to later load from disk`);
  let filename;
  // try {
    filename = require.resolve(request);
  // } catch (error) {
  //   if (!request.startsWith('holocron/')) {
  //     throw error;
  //   }
  //   let recovered = false;
  //   try {
  //     filename = require.resolve(`${request}.jsx`);
  //     recovered = true;
  //   } catch(secondTry) { /* ignore, report the first error */ }
  //   if (!recovered) {
  //     throw error;
  //   }
  //   console.error(`${filename} found, resolve to the compiled version?`);
  //   const codeRaw = await fs.readFile(filename);
  //   const { code } = await transform(codeRaw, { presets: ['@babel/preset-react'] });
  //   console.log('de-JSX\'d code', code);
  //   return { code, filename };
  // }
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
  // const fullCode = `(function (exports, require, module, __filename, __dirname) {
  //   ${code.toString('utf-8')}
  // })({}, function(id){return global.requireFrom('${filename}', id);}, {}, '${filename}', '${path.dirname(filename)}');`;
  const fullCode = code.toString('utf-8');
  const module = await isolate.compileModule(fullCode, options);
  compiledMap.set(module, filename);
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
  // isolate.compileScript(code, { filename })
  // const holocronScript = await isolate.compileScript((await holocronServerSource.codePromise).toString('utf8'), { filename: holocronServerSource.filename });
  // const holocronModule = await isolate.compileModule((await holocronServerSource.codePromise).toString('utf8'), { filename: holocronServerSource.filename });

  // const holocronServerSource = await loadNodeModuleSource('holocron/server');
  // const holocronServerSource = await loadNodeModuleSource('holocron/src/server');
  const holocronServerSource = await loadNodeModuleSource(path.join(ROOT_PROJECT_PATH, 'lib/server/vm/holocron-server.js'));
  // const corejsSource = await loadNodeModuleSource('core-js/stable');
  // const regeneratorRuntimeSource = await loadNodeModuleSource('regenerator-runtime/runtime');

  const compiledMap = new Map();

  const holocronServerModule = await compileNodeModule(isolate, compiledMap, holocronServerSource);
  // const corejsModule = await compileNodeModule(isolate, corejsSource);
  // const regeneratorRuntimeModule = await compileNodeModule(isolate, regeneratorRuntimeSource);

  // import 'core-js/stable';
  // import 'regenerator-runtime/runtime';

  const context = await isolate.createContext();
  const contextGlobal = context.global;
  await contextGlobal.set('global', contextGlobal.derefInto());
  // FIXME: add safeguards
  await contextGlobal.set('getModuleMap', function getModuleMap() { return moduleMap; });
  await contextGlobal.set('getServerStateConfig', getServerStateConfig);

  // // https://github.com/laverdet/isolated-vm/issues/257#issuecomment-1650695653
  // await context.evalClosure(
  //   `
  //     globalThis.fetch = function fetch(url, options) {
  //       // return new Promise((resolve, reject))
  //       // return Promise.resolve('hello');
  //       return Promise.resolve({
  //         json: () => Promise.resolve({
  //           clientCacheRevision: 'a',
  //           modules: {}
  //           }
  //         }),
  //       });
  //     }
  //   `,
  //   [],
  //   { timeout: 1e3}
  // );


  await context.evalClosure(
    "globalThis.sayHello = function sayHello() { return 'hello'; };",
    [],
    { timeout: 1e3}
  );
  console.log('hi?', await context.eval('sayHello()'));

  await context.evalClosure(
    "globalThis.sayHello = function sayHelloObject() { return { a: 'hello' }; };",
    [],
    { timeout: 1e3 }
  );
  // let obj = new ivm.Reference({});
  // let obj = new ivm.ExternalCopy({});
  await context.evalClosure(
    `
      globalThis.sayHello = function sayHelloObjectTransferrable() {
        // $1.apply(undefined, [new $0.Reference({ b: 'hello' })], { reference: true });
        // $1.set('b', 'hello');
        // $1.set('b', { c: 'hello' });
        // $1.derefInto();
        // return { c: 'hello' };
        return new $0.ExternalCopy({ c: 'hello' }).copyInto({ release: true, transferIn: true });
      };
    `,
    [
      ivm,
      // new ivm.Reference((...args) => console.log('args', args)),
      // new ivm.Reference((obj) => console.log('obj', obj.deref())),
      // obj,
    ],
    { timeout: 1e3 }
  );
  console.log('hi?', await context.eval('sayHello()'));
  // console.log('obj?', obj);
  // console.log('obj.b?', await obj.get('b'));

  await contextGlobal.set('log', function (...args) { console.log(...args); });
  // const globalExports = {};
  // await contextGlobal.set('exports', new ivm.ExternalCopy(globalExports).copyInto());
  // await contextGlobal.set('require', function require(id) { throw new Error('eh?'); });
  // await contextGlobal.set('requireFrom', function requireFrom(referrerPath, id) { throw new Error(`eh? ${id} ${referrerPath}`); });
  // await context.eval('log(typeof global.module)');
  // await context.eval('log(typeof global.exports)');
  // console.log('instantiate!');
  async function defaultNodeResolver(specifier, referrer) {
    // console.log({ specifier, referrer });
    // console.log('referrer', referrer.info, referrer.filename, referrer === holocronServerModule);
    const referrerFilename = compiledMap.get(referrer);
    if (!referrerFilename) {
      throw new Error(`unable to get the source of the referrer to resolve ${specifier}`);
    }
    // console.log('referrerFilename', referrerFilename);
    let request = specifier;
    if (specifier.startsWith('.')) {
      request = path.resolve(path.dirname(referrerFilename), specifier);
      // console.log('path.resolve(path.dirname(', referrerFilename ,'), ', specifier, ' = ', request);
    }
    const source = await loadNodeModuleSource(request, referrerFilename);
    return compileNodeModule(isolate, compiledMap, source);
  }
  await holocronServerModule.instantiate(context, defaultNodeResolver);
  await holocronServerModule.evaluate(); // undefined

  // await holocronModule.instantiate(context, (specifier, referrer) => {
  //   console.log({ specifier, referrer });
  //   return Promise.reject(new Error('IDK'));
  // });
  // console.log('instantiate finished');
  // console.log('holocronServerModule', holocronServerModule);
  // [
  //   'filename',
  //   '__ivm_module',
  //   'cachedData',
  //   'dependencySpecifiers',
  //   'namespace',
  // ].forEach(k => console.log(`holocronServerModule.${k}`, holocronServerModule[k]));
  // console.log('holocronServerModule.namespace', holocronServerModule.namespace);


  const loadModulesResult = await evalReturnPromise(context, 'loadModules()');
  console.log('loadModulesResult', loadModulesResult);
  const { loadedModules, rejectedModules } = loadModulesResult;
  // await context.eval('log(typeof global.exports)');


  // await holocronScript.run(context);
  // await holocronModule.run(context);

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
