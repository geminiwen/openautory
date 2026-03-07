import { useCallback, useEffect, useRef, useState } from 'react';
import { Bubble, Sender } from '@ant-design/x';
import { getServerUrl } from './Settings';

type Role = 'user' | 'ai';

interface Message {
  key: string;
  role: Role;
  content: string;
  loading?: boolean;
}

interface ServerPayload {
  type: string;
  event?: {
    message?: {
      content?: { type: string; text?: string }[];
    };
  };
  message?: string;
}

const STARTER_PROMPTS = [
  'Summarize what this project currently does.',
  'Help me plan the next milestone for OpenAutory.',
  'Find risky areas in this codebase and suggest tests.',
];

let msgCounter = 0;
const nextKey = () => String(++msgCounter);

const SESSION_ID = `desktop:${Date.now()}`;
const USER_ID = 'desktop-user';

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const closeSocket = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  useEffect(() => () => closeSocket(), [closeSocket]);

  const appendAiChunk = useCallback((key: string, chunk: string, done: boolean) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.key === key);
      if (idx === -1) {
        return [...prev, { key, role: 'ai', content: chunk, loading: !done }];
      }

      const updated = [...prev];
      updated[idx] = {
        ...updated[idx]!,
        content: updated[idx]!.content + chunk,
        loading: !done,
      };
      return updated;
    });
  }, []);

  const finishRequest = useCallback(() => {
    setLoading(false);
    closeSocket();
  }, [closeSocket]);

  const handleSubmit = useCallback((rawText: string) => {
    const text = rawText.trim();
    if (!text || loading) {
      return;
    }

    const userKey = nextKey();
    const aiKey = nextKey();

    setMessages((prev) => [
      ...prev,
      { key: userKey, role: 'user', content: text },
      { key: aiKey, role: 'ai', content: '', loading: true },
    ]);
    setLoading(true);

    const ws = new WebSocket(getServerUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'message',
        sessionId: SESSION_ID,
        userId: USER_ID,
        content: text,
      }));
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      let payload: ServerPayload;
      try {
        payload = JSON.parse(event.data) as ServerPayload;
      } catch {
        return;
      }

      if (payload.type === 'assistant' && payload.event?.message?.content) {
        const chunk = payload.event.message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('');

        appendAiChunk(aiKey, chunk, false);
        return;
      }

      if (payload.type === 'result') {
        setMessages((prev) =>
          prev.map((message) => (message.key === aiKey ? { ...message, loading: false } : message)),
        );
        finishRequest();
        return;
      }

      if (payload.type === 'error') {
        const errorMessage = payload.message ?? 'Unknown error';
        setMessages((prev) =>
          prev.map((message) =>
            message.key === aiKey
              ? { ...message, content: `Error: ${errorMessage}`, loading: false }
              : message,
          ),
        );
        finishRequest();
      }
    };

    ws.onerror = () => {
      const url = getServerUrl();
      setMessages((prev) =>
        prev.map((message) =>
          message.key === aiKey
            ? { ...message, content: `Cannot connect to ${url}`, loading: false }
            : message,
        ),
      );
      finishRequest();
    };

    ws.onclose = () => {
      wsRef.current = null;
    };
  }, [appendAiChunk, finishRequest, loading]);

  return (
    <div className="chat-surface">
      <div className="chat-stream">
        {messages.length === 0 ? (
          <section className="chat-empty">
            <p className="chat-empty-kicker">OpenAutory Assistant</p>
            <h2 className="chat-empty-title">Ask for architecture, code, or delivery help.</h2>
            <p className="chat-empty-copy">Choose a prompt or write your own request below.</p>
            <div className="prompt-grid">
              {STARTER_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="prompt-chip"
                  onClick={() => handleSubmit(prompt)}
                  disabled={loading}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <Bubble.List
          className="oa-bubble-list"
          classNames={{
            scroll: 'oa-bubble-scroll',
            content: 'oa-bubble-list-content',
          }}
          items={messages}
          autoScroll
          role={{
            ai: {
              placement: 'start',
              typing: true,
              variant: 'shadow',
              shape: 'corner',
              classNames: {
                root: 'oa-bubble oa-bubble-ai',
                content: 'oa-bubble-content oa-bubble-content-ai',
              },
            },
            user: {
              placement: 'end',
              variant: 'filled',
              shape: 'round',
              classNames: {
                root: 'oa-bubble oa-bubble-user',
                content: 'oa-bubble-content oa-bubble-content-user',
              },
            },
          }}
        />
      </div>

      <div className="chat-input-wrap">
        <Sender
          rootClassName="oa-sender"
          classNames={{
            input: 'oa-sender-input',
          }}
          onSubmit={handleSubmit}
          loading={loading}
          placeholder="Type your request and press Enter"
          autoSize={{ minRows: 1, maxRows: 5 }}
        />
      </div>
    </div>
  );
}
