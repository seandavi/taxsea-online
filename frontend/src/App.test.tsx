// Covers routing added for the About page (issue #51): the header nav link navigates to
// /about, and the About page itself renders its key sections.
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import App from './App';

describe('App routing', () => {
  it('renders the submission form on the home route', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'TaxSEA-online' })).toBeTruthy();
  });

  it('navigates to the About page via the header nav link', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'About' }));
    expect(screen.getByRole('heading', { name: 'About TaxSEA-online' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Taxon-set databases TaxSEA bundles' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Back to the app/ })).toBeTruthy();
  });

  it('renders the About page directly at /about', () => {
    render(
      <MemoryRouter initialEntries={['/about']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'About TaxSEA-online' })).toBeTruthy();
    expect(screen.getAllByText('BugSigDB').length).toBeGreaterThan(0);
  });
});
