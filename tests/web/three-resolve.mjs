// Lets node import the page's modules as the browser does through index.html's import
// map: `three` and `three/addons/...` resolve to the vendored copies.
import { registerHooks } from 'node:module';

const vendor = new URL('../../src/decision_pitch/web/vendor/three/', import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'three') return { url: new URL('three.module.js', vendor).href, shortCircuit: true };
    if (specifier.startsWith('three/addons/')) {
      return { url: new URL(specifier.slice('three/'.length), vendor).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
