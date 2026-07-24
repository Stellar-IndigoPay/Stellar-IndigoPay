// Placeholder tests for SEP-0007 parser
import {parseSEP0007Params} from '../utils/sep0007';

test('parse minimal web+stellar URI', () => {
  const url = 'web+stellar:pay?destination=GABC123&amount=10';
  const p = parseSEP0007Params(url);
  expect(p.destination).toBe('GABC123');
  expect(p.amount).toBe('10');
});
