// Guards the one thing about the gtag snippet that is easy to "clean up" and breaks GA
// silently: dataLayer entries must be Arguments objects, not plain Arrays. gtag.js ignores
// Arrays, so 'js'/'config' never register, nothing is reported, and no error is logged.
import { beforeEach, describe, expect, it } from 'vitest';
import { GA_CONTENT_GROUP, GA_MEASUREMENT_ID, initAnalytics } from './analytics';

const PROD = 'taxsea-online.seandavi.workers.dev';

describe('initAnalytics', () => {
  beforeEach(() => {
    window.dataLayer = [];
  });

  it('pushes Arguments objects, not Arrays', () => {
    initAnalytics(PROD);
    expect(window.dataLayer.length).toBe(2);
    for (const entry of window.dataLayer) {
      expect(Array.isArray(entry)).toBe(false);
      expect(Object.prototype.toString.call(entry)).toBe('[object Arguments]');
    }
  });

  it('sends the js and config commands for the measurement id', () => {
    initAnalytics(PROD);
    const commands = window.dataLayer.map((entry) => Array.from(entry as IArguments));
    expect(commands[0]?.[0]).toBe('js');
    expect(commands[0]?.[1]).toBeInstanceOf(Date);
    expect(commands[1]).toEqual(['config', GA_MEASUREMENT_ID, { content_group: GA_CONTENT_GROUP }]);
  });

  it('keeps anything already queued on dataLayer', () => {
    window.dataLayer = ['pre-existing'];
    initAnalytics(PROD);
    expect(window.dataLayer[0]).toBe('pre-existing');
    expect(window.dataLayer.length).toBe(3);
  });

  it('does nothing on non-production hosts', () => {
    for (const host of ['localhost', '127.0.0.1', 'abc123-taxsea-online.seandavi.workers.dev']) {
      initAnalytics(host);
    }
    expect(window.dataLayer.length).toBe(0);
  });
});
