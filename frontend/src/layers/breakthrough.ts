// Breakthrough world and entities (BUILD.md 11.7): M3 PLACEHOLDER. A simple full-screen shader tinted for this layer and modulated by
// state.pulse and the visual intensity. Replace the internals, keep the Layer interface.

import { PlaceholderLayer } from './placeholderLayer';

export class BreakthroughLayer extends PlaceholderLayer {
  constructor() {
    super({ name: 'breakthrough', key: 'breakthrough', mode: 4, tint: '#ffe08a', tint2: '#ff4fd8' });
  }
}

export function createBreakthroughLayer(): BreakthroughLayer {
  return new BreakthroughLayer();
}
