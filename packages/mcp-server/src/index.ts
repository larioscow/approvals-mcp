import { createApp } from './factory';
import { startHttp } from './http';
import { startStdio } from './stdio';

const deps = await createApp();
if (deps.config.transport === 'stdio') {
  await startStdio(deps);
} else {
  await startHttp(deps);
}
