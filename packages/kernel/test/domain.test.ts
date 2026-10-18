import { describe, expect, it } from 'vitest';
import {
  assertJsonValue,
  brandId,
  freezeJsonValue,
  isAbortError,
  serializeError,
} from '../src/index.ts';

describe('domain', () => {
  describe('brandId', () => {
    it('为空字符串抛出错误', () => {
      expect(() => brandId('')).toThrow('identifier must not be empty');
    });

    it('为非空字符串赋予品牌类型', () => {
      const id = brandId<'SessionId'>('session-1');
      expect(id).toBe('session-1');
    });
  });

  describe('assertJsonValue', () => {
    it('接受合法 JSON 值', () => {
      expect(() => assertJsonValue(null)).not.toThrow();
      expect(() => assertJsonValue('text')).not.toThrow();
      expect(() => assertJsonValue(1)).not.toThrow();
      expect(() => assertJsonValue(true)).not.toThrow();
      expect(() => assertJsonValue({ a: [1, { b: null }] })).not.toThrow();
    });

    it('拒绝非有限数字、稀疏数组、循环引用与非普通对象', () => {
      expect(() => assertJsonValue(Number.NaN)).toThrow(TypeError);
      expect(() => assertJsonValue(Number.POSITIVE_INFINITY)).toThrow(TypeError);

      const sparse: unknown[] = [];
      sparse[1] = 1;
      expect(() => assertJsonValue(sparse)).toThrow(TypeError);

      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(() => assertJsonValue(cyclic)).toThrow(TypeError);

      expect(() => assertJsonValue(new Date())).toThrow(TypeError);
      expect(() => assertJsonValue(() => undefined)).toThrow(TypeError);
    });
  });

  describe('freezeJsonValue', () => {
    it('递归复制并冻结 JSON 值', () => {
      const source = { nested: { values: [1, 2] } };
      const snapshot = freezeJsonValue(source);

      source.nested.values.push(3);

      expect(snapshot).toEqual({ nested: { values: [1, 2] } });
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen((snapshot as { readonly nested: object }).nested)).toBe(true);
    });
  });

  describe('serializeError / isAbortError', () => {
    it('序列化 Error 与非 Error 值', () => {
      expect(serializeError(new TypeError('bad'))).toEqual({
        name: 'TypeError',
        message: 'bad',
      });
      expect(serializeError('plain')).toEqual({
        name: 'Error',
        message: 'plain',
      });
    });

    it('识别 AbortError', () => {
      const abort = new Error('cancelled');
      abort.name = 'AbortError';
      expect(isAbortError(abort)).toBe(true);
      expect(isAbortError(new Error('other'))).toBe(false);
      expect(isAbortError('AbortError')).toBe(false);
    });
  });
});
