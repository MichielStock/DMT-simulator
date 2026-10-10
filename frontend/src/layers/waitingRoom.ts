// Waiting room (BUILD.md 11.6): M3 PLACEHOLDER. A simple full-screen shader tinted for this layer and modulated by
// state.pulse and the visual intensity. Replace the internals, keep the Layer interface.

import { PlaceholderLayer } from './placeholderLayer';

export class WaitingRoomLayer extends PlaceholderLayer {
  constructor() {
    super({ name: 'waiting_room', key: 'waitingRoom', mode: 3, tint: '#4fe3ff', tint2: '#7dff6a' });
  }
}

export function createWaitingRoomLayer(): WaitingRoomLayer {
  return new WaitingRoomLayer();
}
