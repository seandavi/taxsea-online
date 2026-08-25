// Guards the one thing about the gtag snippet that is easy to "clean up" and breaks GA
// silently: dataLayer entries must be Arguments objects, not plain Arrays. gtag.js ignores
// Arrays, so 'js'/'config' never register, nothing is reported, and no error is logged.
import { beforeEach, describe, expect, it } from 'vitest';
import { GA_MEASUREMENT_ID, initAnalytics } from './analytics';

describe('initAnalytics', () => {
  beforeEach(() => {
    window.dataLayer = [];
  });

  it('pushes Arguments objects, not Arrays', () => {
    initAnalytics();
    expect(window.dataLayer.length).toBe(2);
    for (const entry of window.dataLayer) {
      expect(Array.isArray(entry)).toBe(false);
      expect(Object.prototype.toString.call(entry)).toBe('[object Arguments]');
    }
  });

  it('sends the js and config commands for the measurement id', () => {
    initAnalytics();
    const commands = window.dataLayer.map((entry) => Array.from(entry as IArguments));
    expect(commands[0]?.[0]).toBe('js');
    expect(commands[0]?.[1]).toBeInstanceOf(Date);
    expect(commands[1]).toEqual(['config', GA_MEASUREMENT_ID]);
  });

  it('keeps anything already queued on dataLayer', () => {
    window.dataLayer = ['pre-existing'];
    initAnalytics();
    expect(window.dataLayer[0]).toBe('pre-existing');
    expect(window.dataLayer.length).toBe(3);
  });
});
