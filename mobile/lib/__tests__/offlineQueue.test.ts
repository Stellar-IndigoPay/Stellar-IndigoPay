import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  enqueueItem,
  getQueue,
  markInFlight,
  recoverInFlightItems,
  preSubmitCheck,
  setOnQueueCorruption,
  clearQueue
} from '../offlineQueue';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn()
}));

describe('offlineQueue crash-safe and idempotent', () => {
  let mockStore: Record<string, string> = {};

  beforeEach(() => {
    jest.clearAllMocks();
    mockStore = {};
    (AsyncStorage.getItem as jest.Mock).mockImplementation((key) => Promise.resolve(mockStore[key] || null));
    (AsyncStorage.setItem as jest.Mock).mockImplementation((key, val) => {
      mockStore[key] = val;
      return Promise.resolve();
    });
    (AsyncStorage.removeItem as jest.Mock).mockImplementation((key) => {
      delete mockStore[key];
      return Promise.resolve();
    });
  });

  afterEach(async () => {
    await clearQueue();
  });

  it('enqueues item and generates idempotencyKey', async () => {
    const item = await enqueueItem({ type: 'test', payload: { a: 1 } });
    expect(item.id).toBeDefined();
    expect(item.idempotencyKey).toBeDefined();
    expect(item.status).toBe('pending');
  });

  it('recovers in_flight items to pending on startup', async () => {
    const item = await enqueueItem({ type: 'test', payload: {} });
    await markInFlight(item.id);
    
    const q1 = await getQueue();
    expect(q1[0].status).toBe('in_flight');

    await recoverInFlightItems();
    
    const q2 = await getQueue();
    expect(q2[0].status).toBe('pending');
  });

  it('preSubmitCheck marks completed if already processed', async () => {
    const item = await enqueueItem({ type: 'test', payload: {} });
    const isProcessed = await preSubmitCheck(item.id, async (key) => {
      expect(key).toBe(item.idempotencyKey);
      return true; // Simulate server found it
    });
    
    expect(isProcessed).toBe(true);
    
    const q = await getQueue();
    expect(q[0].status).toBe('completed');
  });

  it('quarantines corrupted queue on JSON parse failure', async () => {
    mockStore['offline_queue_v2'] = '{ bad json }';
    const onCorruption = jest.fn();
    setOnQueueCorruption(onCorruption);
    
    const q = await getQueue();
    expect(q).toEqual([]); // Returns empty queue instead of throwing
    expect(mockStore['offline_queue_v2_quarantined']).toBe('{ bad json }');
    expect(mockStore['offline_queue_v2']).toBeUndefined();
    expect(onCorruption).toHaveBeenCalled();
  });
  
  it('migrates from legacy offline_queue', async () => {
    mockStore['offline_queue'] = JSON.stringify([
      { id: '1', type: 'test', payload: {}, status: 'retrying', attempts: 1, maxAttempts: 3, nextRetryAt: 0, queuedAt: 0, updatedAt: 0 }
    ]);
    
    const q = await getQueue();
    expect(q[0].status).toBe('in_flight'); // migrated retrying to in_flight
    expect(q[0].idempotencyKey).toBe('1'); // sets to id if not present
    expect(mockStore['offline_queue_v2']).toBeDefined();
    expect(mockStore['offline_queue']).toBeUndefined();
  });
  
  it('serializes writes properly (crash-simulation test)', async () => {
    await enqueueItem({ type: 'test', payload: { id: 1 } });
    const q = await getQueue();
    
    const promise1 = markInFlight(q[0].id);
    const promise2 = enqueueItem({ type: 'test', payload: { id: 2 } });
    
    await Promise.all([promise1, promise2]);
    
    const qFinal = await getQueue();
    expect(qFinal.length).toBe(2);
    expect(qFinal.find((i: any) => i.payload.id === 1)?.status).toBe('in_flight');
    expect(qFinal.find((i: any) => i.payload.id === 2)?.status).toBe('pending');
  });
});
