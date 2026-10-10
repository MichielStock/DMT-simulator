// Room layer (BUILD.md 11.3): M3 PLACEHOLDER. A simple full-screen shader tinted for this layer and modulated by
// state.pulse and the visual intensity. Replace the internals, keep the Layer interface.

import { PlaceholderLayer } from './placeholderLayer';

export class RoomLayer extends PlaceholderLayer {
  constructor() {
    super({ name: 'room', key: 'room', mode: 0, tint: '#ffd9a0', tint2: '#3a2a1a' });
  }
}

export function createRoomLayer(): RoomLayer {
  return new RoomLayer();
}
