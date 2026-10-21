import { createInterface } from 'node:readline';

import type { NativeWorkerCommand, NativeWorkerEvent } from './docker-native-agent.js';
import { NativeAgentService } from './native-agent.js';

const write = (event: NativeWorkerEvent) => process.stdout.write(`${JSON.stringify(event)}\n`);
const lines = createInterface({ input: process.stdin });
const controller = new AbortController();
let service: NativeAgentService | undefined;
let started = false;
let requirementId = '';
let steering = Promise.resolve();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());
lines.on('close', () => controller.abort());
lines.on('line', (line) => {
  const command = JSON.parse(line) as NativeWorkerCommand;
  if (command.type === 'start' && !started) {
    started = true;
    requirementId = command.input.requirementId;
    service = new NativeAgentService(command.databasePath);
    void service.run({ ...command.input, signal: controller.signal,
      onEvent: (event) => write({ type: 'event', event }), onNativeSession: (id) => write({ type: 'session', id }),
    }).then(async (outcome) => {
      await steering;
      await service!.close();
      write({ type: 'outcome', outcome });
      lines.close();
      process.stdin.destroy();
    }).catch(() => { process.exitCode = 1; lines.close(); process.stdin.destroy(); });
  } else if (command.type === 'steer') {
    steering = steering.then(async () => {
      const accepted = await service?.steer(requirementId, command.message);
      write({ type: 'steer', id: command.id, accepted: accepted ?? false });
    });
  }
});
