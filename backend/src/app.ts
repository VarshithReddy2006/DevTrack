// backend/src/app.ts - Express application re-export for issue #504
import { createApp } from './server.js';

export { createApp };
export default createApp;
