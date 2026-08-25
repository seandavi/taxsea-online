// Vitest doesn't run with `globals: true` here (tests import describe/it/expect explicitly),
// so @testing-library/react's auto-cleanup -- which detects a global `afterEach` -- never
// fires on its own. Do it explicitly instead.
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
