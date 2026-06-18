import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WalletSetup } from '../../src/renderer/src/screens/WalletSetup';
import { useApp } from '../../src/renderer/src/store/app';

/**
 * Smoke-test the first-launch flow: "Create new wallet" reaches the
 * mnemonic-reveal step and blocks on the "I backed it up" checkbox before
 * proceeding to funding status.
 */

const FAKE_ADDRESS = 'sent1yftwk6a4h5fk4xzp3znk6puqj92uxw7jhxwd76';
const FAKE_MNEMONIC = 'tribe solution puppy eager nasty lonely advice gym worth above oblige rocket salmon merit cloth exchange ranch bulk flock quote orient vehicle flush vessel';

beforeEach(() => {
  const api = {
    wallet: {
      create: vi.fn().mockResolvedValue({
        wallet: { address: FAKE_ADDRESS, balanceDVPN: 0, createdAt: new Date().toISOString(), hasMnemonic: true },
        mnemonic: FAKE_MNEMONIC,
      }),
      restore: vi.fn(),
      get: vi.fn(),
      refreshBalance: vi.fn().mockResolvedValue({
        address: FAKE_ADDRESS,
        balanceDVPN: 5,
        createdAt: new Date().toISOString(),
        hasMnemonic: true,
      }),
      send: vi.fn(),
      qrSvg: vi.fn().mockResolvedValue('<svg></svg>'),
    },
  };
  (globalThis as unknown as { window: { api: unknown } }).window.api = api;
  // clipboard is a getter-only prop on the navigator from happy-dom; stub
  // via defineProperty.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn() },
    writable: true,
    configurable: true,
  });

  // reset the store to baseline for each test
  useApp.setState({
    route: { name: 'wallet-setup' },
    wallet: null,
    walletBootstrapped: true,
    toasts: [],
    confirmPrompt: null,
    events: [],
    nodes: [],
    settings: null,
    chainHealth: [],
    liveStatuses: {},
    nodeHistory: {},
    progress: null,
    history: [],
    canGoBack: false,
    online: true,
  });
});

describe('WalletSetup', () => {
  it('shows the two choice cards on first render', () => {
    render(<WalletSetup />);
    expect(screen.getByText(/Create new wallet/i)).toBeDefined();
    expect(screen.getByText(/Restore existing wallet/i)).toBeDefined();
  });

  it('creates a wallet and requires backup confirmation before continue', async () => {
    const user = userEvent.setup();
    render(<WalletSetup />);

    // The "Create wallet" CTA is one of multiple buttons on screen — find
    // the one whose accessible label matches the current copy.
    const buttons = screen.getAllByRole('button');
    const initBtn = buttons.find((b) =>
      /Create wallet/i.test(b.textContent ?? '') && !/Restore/i.test(b.textContent ?? ''),
    );
    expect(initBtn).toBeDefined();
    await user.click(initBtn!);

    // L-12: the mnemonic words are NOT rendered into the DOM until the user
    // explicitly reveals them — pre-reveal each tile shows "••••••" so the
    // secret never sits in the accessibility tree / DevTools. Click the
    // "Click to reveal phrase" overlay first, then assert the first word.
    const firstWord = FAKE_MNEMONIC.split(/\s+/)[0];
    expect(screen.queryByText(firstWord)).toBeNull();

    const revealBtn = await screen.findByText(/Click to reveal phrase/i);
    await user.click(revealBtn);

    // 24 individual word tiles now render; assert the first word is present.
    // Continue stays disabled until the backup checkbox ticks.
    const wordEl = await screen.findByText(firstWord);
    expect(wordEl).toBeDefined();

    const continueBtn = screen.getByRole('button', { name: /Continue/i });
    expect(continueBtn.getAttribute('disabled')).not.toBeNull();

    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);

    expect(continueBtn.getAttribute('disabled')).toBeNull();
  });
});
