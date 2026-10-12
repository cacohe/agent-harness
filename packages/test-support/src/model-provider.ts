import type {
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  PreparedModelCall,
} from '@agent-harness/kernel';

export interface ModelScript {
  readonly events: readonly ModelStreamEvent[];
  readonly error?: Error;
  readonly prepare?: (signal: AbortSignal) => Promise<void>;
}

/** 按预设脚本产生确定性模型流，并保留每次请求供断言使用。 */
export class ScriptedModelProvider implements ModelProvider {
  readonly id = 'scripted';
  readonly requests: ModelRequest[] = [];
  readonly #scripts: ModelScript[];

  constructor(scripts: readonly ModelScript[]) {
    this.#scripts = [...scripts];
  }

  async prepare(signal: AbortSignal): Promise<PreparedModelCall> {
    signal.throwIfAborted();
    const script = this.#scripts.shift();
    if (script === undefined) throw new Error('scripted model has no remaining response');
    await script.prepare?.(signal);
    signal.throwIfAborted();
    return {
      stream: (request, streamSignal) => {
        this.requests.push(request);
        return scriptedStream(script, streamSignal);
      },
    };
  }
}

async function* scriptedStream(
  script: ModelScript,
  signal: AbortSignal,
): AsyncIterable<ModelStreamEvent> {
  for (const event of script.events) {
    signal.throwIfAborted();
    yield event;
  }
  if (script.error !== undefined) throw script.error;
}
