import './polyfills';

import { updateModuleRegistry } from 'holocron/src/server';
import loadModule from 'holocron/src/loadModule.vanilla';

import onModuleLoad from '../utils/onModuleLoad';
// import { CONFIGURATION_KEY } from '../utils/onModuleLoad';
import batchModulesToUpdate from './batchModulesToUpdate';
import getModulesToUpdate from './getModulesToUpdate';

const loadModules = async () => {
  const moduleMap = getModuleMap();

  // NOTE:: this function mutates the moduleMap
  const { loadedModules = {}, rejectedModules = {} } = await updateModuleRegistry({
    moduleMap,
    batchModulesToUpdate,
    onModuleLoad,
    getModulesToUpdate,
    listRejectedModules: true,
    loadModule,
  });

  // rejectedModulesCache = rejectedModules;
  const loadedModuleNames = Object.keys(loadedModules);

  if (loadedModuleNames.length > 0) {
    setClientModuleMapCache(moduleMap);
  }

  const serverConfig = getServerStateConfig();
  const rootModuleLoaded = loadedModuleNames.includes(serverConfig.rootModuleName);

  if (rootModuleLoaded) {
    const RootModule = getModule(serverConfig.rootModuleName);
    const { [CONFIGURATION_KEY]: { csp } = {} } = RootModule;
    updateCSP(csp);
  }

  return { loadedModules, rejectedModules };
};

global.loadModules = loadModules;
