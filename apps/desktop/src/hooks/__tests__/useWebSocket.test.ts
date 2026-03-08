import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWebSocket } from '../useWebSocket';

// ── Mock WebSocket ──────────────────────────────────────────────

type WsHandler = ((event: { data: string }) => void) | null;

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: WsHandler = null;

  sent: string[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  // ── test helpers ──

  /** Simulate the server accepting the connection */
  simulateOpen() {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }

  /** Simulate receiving a message from the server */
  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  /** Simulate the connection being closed (e.g. server-side close / network drop) */
  simulateClose() {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }

  /** Simulate a connection error */
  simulateError() {
    this.onerror?.();
  }

  static reset() {
    MockWebSocket.instances = [];
  }

  static latest(): MockWebSocket {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
  }
}

// Expose constants that the hook reads
(MockWebSocket as unknown as Record<string, number>).OPEN = 1;
(MockWebSocket as unknown as Record<string, number>).CONNECTING = 0;
(MockWebSocket as unknown as Record<string, number>).CLOSING = 2;
(MockWebSocket as unknown as Record<string, number>).CLOSED = 3;

// ── Setup / Teardown ────────────────────────────────────────────

beforeEach(() => {
  MockWebSocket.reset();
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────

describe('useWebSocket', () => {
  it('connects on mount and sets connected=true after open', () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:3000/ws'));

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.latest().url).toBe('ws://localhost:3000/ws');
    expect(result.current.connected).toBe(false);

    act(() => MockWebSocket.latest().simulateOpen());

    expect(result.current.connected).toBe(true);
  });

  it('closes the connection on unmount', () => {
    const { unmount } = renderHook(() => useWebSocket('ws://localhost:3000/ws'));

    const ws = MockWebSocket.latest();
    act(() => ws.simulateOpen());

    unmount();

    expect(ws.closed).toBe(true);
  });

  it('does not reconnect after intentional unmount', () => {
    const { unmount } = renderHook(() => useWebSocket('ws://localhost:3000/ws'));

    act(() => MockWebSocket.latest().simulateOpen());
    unmount();

    // Advance past any potential reconnect delay
    act(() => vi.advanceTimersByTime(60_000));

    // Should still only have the initial connection
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  // ── send ──

  it('sends JSON-stringified data when connected', () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:3000/ws'));

    act(() => MockWebSocket.latest().simulateOpen());

    act(() => result.current.send({ type: 'message', content: 'hello' }));

    expect(MockWebSocket.latest().sent).toEqual([
      JSON.stringify({ type: 'message', content: 'hello' }),
    ]);
  });

  it('silently drops send when not connected', () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:3000/ws'));

    // Don't open the connection
    act(() => result.current.send({ type: 'message' }));

    expect(MockWebSocket.latest().sent).toEqual([]);
  });

  // ── subscribe ──

  it('dispatches parsed messages to all subscribers', () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:3000/ws'));

    const listener1 = vi.fn();
    const listener2 = vi.fn();
    act(() => {
      result.current.subscribe(listener1);
      result.current.subscribe(listener2);
    });

    act(() => MockWebSocket.latest().simulateOpen());

    const payload = { type: 'assistant', sessionId: 'abc' };
    act(() => MockWebSocket.latest().simulateMessage(payload));

    expect(listener1).toHaveBeenCalledWith(payload);
    expect(listener2).toHaveBeenCalledWith(payload);
  });

  it('unsubscribe stops dispatching to that listener', () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:3000/ws'));

    const listener = vi.fn();
    let unsub!: () => void;
    act(() => {
      unsub = result.current.subscribe(listener);
    });

    act(() => MockWebSocket.latest().simulateOpen());
    act(() => MockWebSocket.latest().simulateMessage({ type: 'a' }));
    expect(listener).toHaveBeenCalledTimes(1);

    act(() => unsub());
    act(() => MockWebSocket.latest().simulateMessage({ type: 'b' }));
    expect(listener).toHaveBeenCalledTimes(1); // no new calls
  });

  it('ignores non-JSON messages', () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:3000/ws'));

    const listener = vi.fn();
    act(() => result.current.subscribe(listener));
    act(() => MockWebSocket.latest().simulateOpen());

    // Send raw invalid JSON directly
    act(() => MockWebSocket.latest().onmessage?.({ data: 'not json' }));

    expect(listener).not.toHaveBeenCalled();
  });

  // ── reconnect ──

  it('reconnects with exponential backoff on unexpected close', () => {
    renderHook(() => useWebSocket('ws://localhost:3000/ws'));

    act(() => MockWebSocket.latest().simulateOpen());
    expect(MockWebSocket.instances).toHaveLength(1);

    // Unexpected close
    act(() => MockWebSocket.latest().simulateClose());
    expect(MockWebSocket.instances).toHaveLength(1); // not yet reconnected

    // After 1s (initial delay)
    act(() => vi.advanceTimersByTime(1000));
    expect(MockWebSocket.instances).toHaveLength(2);

    // Second close → 2s delay
    act(() => MockWebSocket.latest().simulateClose());
    act(() => vi.advanceTimersByTime(1999));
    expect(MockWebSocket.instances).toHaveLength(2); // not yet
    act(() => vi.advanceTimersByTime(1));
    expect(MockWebSocket.instances).toHaveLength(3);

    // Third close → 4s delay
    act(() => MockWebSocket.latest().simulateClose());
    act(() => vi.advanceTimersByTime(3999));
    expect(MockWebSocket.instances).toHaveLength(3);
    act(() => vi.advanceTimersByTime(1));
    expect(MockWebSocket.instances).toHaveLength(4);
  });

  it('resets backoff delay after successful reconnect', () => {
    renderHook(() => useWebSocket('ws://localhost:3000/ws'));

    // Connect → close → reconnect at 1s
    act(() => MockWebSocket.latest().simulateOpen());
    act(() => MockWebSocket.latest().simulateClose());
    act(() => vi.advanceTimersByTime(1000));
    expect(MockWebSocket.instances).toHaveLength(2);

    // Successfully reconnect → delay resets to 1s
    act(() => MockWebSocket.latest().simulateOpen());
    act(() => MockWebSocket.latest().simulateClose());
    act(() => vi.advanceTimersByTime(1000));
    expect(MockWebSocket.instances).toHaveLength(3); // reconnected at 1s, not 2s
  });

  it('caps backoff at 30 seconds', () => {
    renderHook(() => useWebSocket('ws://localhost:3000/ws'));

    // Simulate many consecutive failures: 1s → 2s → 4s → 8s → 16s → 32s(capped to 30s)
    act(() => MockWebSocket.latest().simulateOpen());

    for (let i = 0; i < 5; i++) {
      act(() => MockWebSocket.latest().simulateClose());
      act(() => vi.advanceTimersByTime(30_000));
    }

    // After 5 failures, the next delay should be capped at 30s
    const countBefore = MockWebSocket.instances.length;
    act(() => MockWebSocket.latest().simulateClose());
    act(() => vi.advanceTimersByTime(29_999));
    expect(MockWebSocket.instances).toHaveLength(countBefore);
    act(() => vi.advanceTimersByTime(1));
    expect(MockWebSocket.instances).toHaveLength(countBefore + 1);
  });

  // ── connected state ──

  it('sets connected=false on close', () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:3000/ws'));

    act(() => MockWebSocket.latest().simulateOpen());
    expect(result.current.connected).toBe(true);

    act(() => MockWebSocket.latest().simulateClose());
    expect(result.current.connected).toBe(false);
  });

  // ── url change ──

  it('reconnects to new URL when url prop changes', () => {
    const { rerender } = renderHook(
      ({ url }) => useWebSocket(url),
      { initialProps: { url: 'ws://localhost:3000/ws' } },
    );

    act(() => MockWebSocket.latest().simulateOpen());
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.latest().url).toBe('ws://localhost:3000/ws');

    // Change URL
    rerender({ url: 'ws://localhost:4000/ws' });

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.latest().url).toBe('ws://localhost:4000/ws');

    // Old connection should be closed
    expect(MockWebSocket.instances[0]!.closed).toBe(true);
  });
});
