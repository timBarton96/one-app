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

const FORCIBLE_SHUTDOWN_TIMEOUT = 10e3;
const servers = [];
let shouldHaveShutDown = false;

function addServer(s) { servers.unshift(s); }

function shutdown() {
  shouldHaveShutDown = true;
  console.log('shutting down, closing servers');
  servers.forEach((s) => s.close());
}

function shutdownForcibly() {
  console.error('shutting down, forcibly stopping node');
  // this is a forcible shutdown due to a babel-node bug of not forwarding the signal
  // eslint-disable-next-line unicorn/no-process-exit
  setImmediate(() => process.exit(1));
}

[
  'SIGINT',
  'SIGTERM',
]
  .forEach((signalName) => process.on(signalName, () => {
    if (shouldHaveShutDown) {
      // second signal, something is keeping node up
      console.log('received %s, forcibly shutting down', signalName);
      shutdownForcibly();
      return;
    }

    console.log('received %s, shutting down', signalName);
    shutdown();
    // `shouldHaveShutDown` is now `true`, BUT
    // we never get additional signals when running in babel-node
    // https://github.com/babel/babel/issues/1062
    // at least, until https://github.com/babel/babel/pull/7902 is published
    const forcibleRef = setTimeout(() => {
      console.error('still running after %ds, forcibly shutting down', FORCIBLE_SHUTDOWN_TIMEOUT / 1e3);
      shutdownForcibly();
    }, FORCIBLE_SHUTDOWN_TIMEOUT);
    // don't have the timeout the thing keeping node running
    if (forcibleRef && forcibleRef.unref) {
      forcibleRef.unref();
    }
  }));

export {
  addServer,
  shutdown,
};
