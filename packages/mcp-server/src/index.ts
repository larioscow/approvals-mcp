import { createApp } from './factory';
import { startHttp } from './http';
import { startStdio } from './stdio';

const deps = createApp();
if (deps.config.transport === 'stdio') {
  await startStdio(deps);
} else {
  await startHttp(deps);
}
