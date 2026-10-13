import { describe, expect, it } from 'vitest';
import {
  MemoryGatewayDocumentImporter,
  type MemoryGatewayDocumentImportRequest,
} from '../src/index.ts';

const encoder = new TextEncoder();

describe('MemoryGatewayDocumentImporter', () => {
  it('复制文件字节并发送带摘要的已绑定导入请求', async () => {
    const bytes = encoder.encode('hello');
    let observed: MemoryGatewayDocumentImportRequest | undefined;
    const importer = new MemoryGatewayDocumentImporter({
      memorySpaceId: 'space-1',
      client: {
        async importDocument(request) {
          observed = request;
          expect(Object.isFrozen(request)).toBe(true);
          return { documentId: 'document-1', status: 'queued' };
        },
      },
    });
    const result = await importer.import(
      {
        fileName: 'Guide.TXT',
        mediaType: 'Text/Plain',
        bytes,
      },
      new AbortController().signal,
    );
    bytes[0] = 0;

    expect(observed).toMatchObject({
      memorySpaceId: 'space-1',
      fileName: 'Guide.TXT',
      mediaType: 'text/plain',
      sizeBytes: 5,
      contentSha256: 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    });
    expect(observed?.bytes).not.toBe(bytes);
    expect(new TextDecoder().decode(observed?.bytes)).toBe('hello');
    expect(result).toEqual({ documentId: 'document-1', status: 'queued' });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ['非对象输入', null, '必须是对象'],
    [
      '未知字段',
      { fileName: 'file.txt', mediaType: 'text/plain', bytes: encoder.encode('x'), extra: true },
      '只能包含',
    ],
    [
      '路径文件名',
      { fileName: '../secret.txt', mediaType: 'text/plain', bytes: encoder.encode('x') },
      '不含路径',
    ],
    [
      '控制字符文件名',
      { fileName: 'bad\n.txt', mediaType: 'text/plain', bytes: encoder.encode('x') },
      '不含路径',
    ],
    [
      '无效 MIME',
      { fileName: 'file.txt', mediaType: 'text/plain; charset=utf-8', bytes: encoder.encode('x') },
      '规范 MIME',
    ],
    [
      '空文件',
      { fileName: 'file.txt', mediaType: 'text/plain', bytes: new Uint8Array() },
      '不能为空',
    ],
    ['错误字节类型', { fileName: 'file.txt', mediaType: 'text/plain', bytes: [1] }, 'Uint8Array'],
  ])('在调用 Gateway 前拒绝%s', async (_name, source, message) => {
    let calls = 0;
    const importer = new MemoryGatewayDocumentImporter({
      memorySpaceId: 'space-1',
      client: {
        async importDocument() {
          calls += 1;
          return { documentId: 'id', status: 'queued' };
        },
      },
    });
    await expect(importer.import(source as never, new AbortController().signal)).rejects.toThrow(
      message,
    );
    expect(calls).toBe(0);
  });

  it('限制文件大小与构造配置', async () => {
    const client = { importDocument: async () => ({ documentId: 'id', status: 'queued' }) };
    expect(
      () =>
        new MemoryGatewayDocumentImporter({
          memorySpaceId: '',
          client,
        }),
    ).toThrow('memorySpaceId 必须是非空字符串');
    expect(
      () =>
        new MemoryGatewayDocumentImporter({
          memorySpaceId: 'space',
          client,
          maxDocumentBytes: 0,
        }),
    ).toThrow('maxDocumentBytes 必须是正安全整数');
    const importer = new MemoryGatewayDocumentImporter({
      memorySpaceId: 'space',
      client,
      maxDocumentBytes: 2,
    });
    await expect(
      importer.import(
        {
          fileName: 'file.txt',
          mediaType: 'text/plain',
          bytes: encoder.encode('abc'),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('不能超过 2 字节');
  });

  it.each([
    ['非对象', [], '必须是对象'],
    ['未知字段', { documentId: 'id', status: 'queued', extra: true }, '只能包含'],
    ['空 ID', { documentId: '', status: 'queued' }, '必须是非空字符串'],
    ['未知状态', { documentId: 'id', status: 'processing' }, 'queued 或 ready'],
  ])('拒绝%s响应', async (_name, response, message) => {
    const importer = new MemoryGatewayDocumentImporter({
      memorySpaceId: 'space',
      client: { importDocument: async () => response },
    });
    await expect(
      importer.import(
        {
          fileName: 'file.txt',
          mediaType: 'text/plain',
          bytes: encoder.encode('x'),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(message);
  });

  it('在调用前和 Gateway 返回后传播取消', async () => {
    let calls = 0;
    const before = new AbortController();
    before.abort(new Error('before'));
    const importer = new MemoryGatewayDocumentImporter({
      memorySpaceId: 'space',
      client: {
        async importDocument() {
          calls += 1;
          return { documentId: 'id', status: 'queued' };
        },
      },
    });
    await expect(
      importer.import(
        {
          fileName: 'file.txt',
          mediaType: 'text/plain',
          bytes: encoder.encode('x'),
        },
        before.signal,
      ),
    ).rejects.toThrow('before');
    expect(calls).toBe(0);

    const during = new AbortController();
    const cancelled = new MemoryGatewayDocumentImporter({
      memorySpaceId: 'space',
      client: {
        async importDocument(_request, signal) {
          expect(signal).toBe(during.signal);
          during.abort(new Error('during'));
          return { documentId: 'id', status: 'queued' };
        },
      },
    });
    await expect(
      cancelled.import(
        {
          fileName: 'file.txt',
          mediaType: 'text/plain',
          bytes: encoder.encode('x'),
        },
        during.signal,
      ),
    ).rejects.toThrow('during');
  });
});
