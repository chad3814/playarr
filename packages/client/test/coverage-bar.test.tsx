import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CoverageBar } from '../src/components/CoverageBar.tsx';

describe('CoverageBar', () => {
  it('places a covered run at its proportional position', () => {
    render(<CoverageBar covered={[[0, 25]]} dead={[]} segmentCount={100} />);
    const run = screen.getByTestId('covered-0');
    expect(run.style.left).toBe('0%');
    expect(run.style.width).toBe('25%');
  });

  it('renders a trailing run at the right offset', () => {
    render(<CoverageBar covered={[[90, 100]]} dead={[]} segmentCount={100} />);
    const run = screen.getByTestId('covered-0');
    expect(run.style.left).toBe('90%');
    expect(run.style.width).toBe('10%');
  });

  it('marks dead segments distinctly from unfetched ones', () => {
    render(<CoverageBar covered={[[0, 10]]} dead={[20]} segmentCount={100} />);
    expect(screen.getByTestId('covered-0')).toBeDefined();
    const dead = screen.getByTestId('dead-20');
    expect(dead.style.left).toBe('20%');
    expect(dead.style.width).toBe('1%');
  });

  it('reports the covered percentage for a screen reader', () => {
    render(<CoverageBar covered={[[0, 50]]} dead={[]} segmentCount={100} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
  });

  it('renders nothing measurable for an empty file rather than dividing by zero', () => {
    render(<CoverageBar covered={[]} dead={[]} segmentCount={0} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
  });
});
