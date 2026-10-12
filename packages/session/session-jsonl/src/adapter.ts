import { nodeJsonlIo } from './io.js';
import {
  JsonlSessionRepositoryImplementation,
  type JsonlSessionRepositoryOptions,
} from './repository.js';

/** 使用 Node.js 文件系统实现持久 JSONL 会话存储。 */
export class JsonlSessionRepository extends JsonlSessionRepositoryImplementation {
  constructor(options: JsonlSessionRepositoryOptions) {
    super(options, nodeJsonlIo);
  }
}
