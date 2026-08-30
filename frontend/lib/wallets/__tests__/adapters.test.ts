import 'whatwg-fetch';
import { freighterAdapter } from '../freighterAdapter';
import { albedoAdapter } from '../albedoAdapter';
import { xbullAdapter } from '../xbullAdapter';
import { walletConnectAdapter } from '../walletConnectAdapter';

describe('Wallet Adapters', () => {
  it('should have correct metadata for Freighter', () => {
    expect(freighterAdapter.id).toBe('freighter');
    expect(freighterAdapter.name).toBe('Freighter');
  });

  it('should have correct metadata for Albedo', () => {
    expect(albedoAdapter.id).toBe('albedo');
    expect(albedoAdapter.name).toBe('Albedo');
  });

  it('should have correct metadata for xBull', () => {
    expect(xbullAdapter.id).toBe('xbull');
    expect(xbullAdapter.name).toBe('xBull');
  });

  it('should have correct metadata for WalletConnect', () => {
    expect(walletConnectAdapter.id).toBe('walletConnect');
    expect(walletConnectAdapter.name).toBe('WalletConnect');
  });
});
