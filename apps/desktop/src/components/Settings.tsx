import { useState } from 'react';
import { Button, Form, Input, message } from 'antd';

const STORAGE_KEY = 'openautory:serverUrl';
const DEFAULT_URL = 'ws://localhost:3000/ws';

export function getServerUrl(): string {
  return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_URL;
}

export default function Settings() {
  const [saved, setSaved] = useState(false);
  const [form] = Form.useForm();

  function handleSave(values: { serverUrl: string }) {
    localStorage.setItem(STORAGE_KEY, values.serverUrl || DEFAULT_URL);
    setSaved(true);
    void message.success('Settings saved. Reload the app for changes to take effect.');
  }

  return (
    <div className="settings-panel">
      <p className="settings-hint">
        Configure the WebSocket endpoint used by this desktop client.
      </p>

      <Form
        form={form}
        layout="vertical"
        className="settings-form"
        initialValues={{ serverUrl: localStorage.getItem(STORAGE_KEY) ?? DEFAULT_URL }}
        onValuesChange={() => setSaved(false)}
        onFinish={handleSave}
      >
        <Form.Item
          label="Server WebSocket URL"
          name="serverUrl"
          rules={[
            { required: true, message: 'Please enter the server URL' },
            {
              validator: (_, value: string) => {
                if (!value || value.startsWith('ws://') || value.startsWith('wss://')) {
                  return Promise.resolve();
                }
                return Promise.reject(new Error('URL must start with ws:// or wss://'));
              },
            },
          ]}
          extra="Default: ws://localhost:3000/ws"
        >
          <Input placeholder="ws://localhost:3000/ws" size="large" />
        </Form.Item>

        <Form.Item className="settings-actions">
          <Button type="primary" htmlType="submit" size="large" block>
            {saved ? 'Saved' : 'Save Changes'}
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
}
