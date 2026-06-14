/**
 * dynamic/ -- Runtime trace layer (G7).
 * T33: loop skeleton extractor
 * T34: C++ scope marker codegen
 * T35: C# scope marker codegen
 * T36: wire protocol + ring buffer decoder
 * T37: trace transport (async receiver with retry)
 * T38: zone<->card join (stitch)
 * T39: build strategy configuration
 * T40-T42: dynamic viz (TraceSource, timeline, active overlay, where)
 */
export * from './skeleton.js';
export * from './inject-cpp.js';
export * from './inject-csharp.js';
export * from './protocol.js';
export * from './ringbuffer.js';
export * from './transport.js';
export * from './stitch.js';
export * from './build-strategy.js';
export * from './viz/index.js';