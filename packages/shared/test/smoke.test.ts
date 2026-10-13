import { describe, it, expect } from 'vitest';
import * as shared from '../src/index';

describe('shared package', () => {
  it('loads', () => {
    expect(shared).toBeTypeOf('object');
  });
});
