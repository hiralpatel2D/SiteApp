import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  // Node-environment tests (e.g. server.test.ts) have no DOM to reset.
  if (typeof document === 'undefined') return;
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.mode;
});
