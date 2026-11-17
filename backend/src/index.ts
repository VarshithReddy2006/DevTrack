// Initialize instrumentation before loading Express, Mongoose, Redis or BullMQ.
import './instrumentation.js';

export const { createApp, setupHealthEndpoints } = await import('./server.js');
