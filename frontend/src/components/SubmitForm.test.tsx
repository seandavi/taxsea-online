// Rank-column picker for multi-column input (issue #63). The parser-level behavior is
// covered in lib/parseInput.test.ts; these cover the parts only the form can enforce --
// that nothing is pre-selected, and that submit stays blocked until the user chooses.
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SubmitForm from './SubmitForm';

const DESEQ2 = [
  'taxon,baseMean,log2FoldChange,lfcSE,stat,pvalue,padj',
  'Bifidobacterium_longum,142.5,2.45,0.31,7.90,2.8e-15,1.1e-13',
  'Ruminococcus_bromii,88.1,-3.05,0.44,-6.93,4.2e-12,9.7e-11',
].join('\n');

function pasteDESeq2() {
  render(<SubmitForm />);
  fireEvent.change(screen.getByLabelText(/Taxon name and rank/), { target: { value: DESEQ2 } });
}

describe('SubmitForm rank-column picker', () => {
  it('appears for multi-column input with no column pre-selected', () => {
    pasteDESeq2();
    const picker = screen.getByLabelText(/which one holds the rank value/) as HTMLSelectElement;
    expect(picker.value).toBe('');
  });

  it('keeps submit disabled until a column is chosen', () => {
    pasteDESeq2();
    const submit = screen.getByRole('button', { name: /^submit$/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/which one holds the rank value/), { target: { value: '2' } });
    expect(submit.disabled).toBe(false);
    expect(screen.getByText(/2 taxa parsed/)).toBeTruthy();
  });

  it('does not offer column 1, which is the taxon name', () => {
    pasteDESeq2();
    const picker = screen.getByLabelText(/which one holds the rank value/);
    const values = Array.from(picker.querySelectorAll('option')).map((o) => o.value);
    expect(values).not.toContain('0');
  });

  it('shows no picker for ordinary two-column input', () => {
    render(<SubmitForm />);
    fireEvent.change(screen.getByLabelText(/Taxon name and rank/), {
      target: { value: 'Bifidobacterium_longum\t2.45\nRuminococcus_bromii\t-3.05' },
    });
    expect(screen.queryByLabelText(/which one holds the rank value/)).toBeNull();
  });

  it('clears the chosen column when the input is replaced', () => {
    pasteDESeq2();
    fireEvent.change(screen.getByLabelText(/which one holds the rank value/), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/Taxon name and rank/), {
      target: { value: DESEQ2.replace('log2FoldChange', 'lfc') },
    });
    const picker = screen.getByLabelText(/which one holds the rank value/) as HTMLSelectElement;
    expect(picker.value).toBe('');
  });
});
