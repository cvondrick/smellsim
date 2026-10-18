import { App } from './app';

const app = new App();
// exposed for debugging from the browser console
(window as unknown as { app: App }).app = app;
