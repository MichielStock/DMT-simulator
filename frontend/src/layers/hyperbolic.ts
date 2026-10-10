// Chrysanthemum / hyperbolic tilings (BUILD.md 11.5): M3 PLACEHOLDER. A simple full-screen shader tinted for this layer and modulated by
// state.pulse and the visual intensity. Replace the internals, keep the Layer interface.

import { PlaceholderLayer } from './placeholderLayer';

export class HyperbolicLayer extends PlaceholderLayer {
  constructor() {
    super({ name: 'chrysanthemum', key: 'chrysanthemum', mode: 2, tint: '#ff4fd8', tint2: '#ffb000' });
  }
}

export function createHyperbolicLayer(): HyperbolicLayer {
  return new HyperbolicLayer();
}
