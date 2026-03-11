import { useCallback, useEffect, useState } from 'react';
import { DeleteOutlined, EditOutlined, ImportOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Drawer, Form, Input, Modal, Radio, Tabs, Tag, message } from 'antd';
import { invoke } from '@tauri-apps/api/core';
import styles from './ProjectSettings.module.css';

// ── MCP types ─────────────────────────────────────────────────────────────────

interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

interface StdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface HttpServer {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

type McpServerEntry = StdioServer | HttpServer;

function isHttpServer(entry: McpServerEntry): entry is HttpServer {
  return 'type' in entry && entry.type === 'http';
}

// ── Skill types ───────────────────────────────────────────────────────────────

interface SkillInfo {
  name: string;
  description: string;
  content: string;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface ProjectSettingsProps {
  cwd: string;
  projectName: string;
  open: boolean;
  onClose: () => void;
  wsSend: (data: object) => void;
}

// ── MCP form values ───────────────────────────────────────────────────────────

interface McpFormValues {
  name: string;
  serverType: 'stdio' | 'http';
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
}

// ── Skill form values ─────────────────────────────────────────────────────────

interface SkillFormValues {
  name: string;
  description: string;
  content: string;
}

interface ImportFormValues {
  source: 'file' | 'url';
  path: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSkillContent(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

function parseSkillContent(raw: string): { description: string; body: string } {
  if (!raw.startsWith('---')) {
    return { description: '', body: raw };
  }
  const endIdx = raw.indexOf('\n---', 3);
  if (endIdx < 0) {
    return { description: '', body: raw };
  }
  const fm = raw.slice(3, endIdx);
  let description = '';
  for (const line of fm.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('description:')) {
      description = trimmed.slice('description:'.length).trim().replace(/^["']|["']$/g, '');
    }
  }
  const body = raw.slice(endIdx + 4).replace(/^\n+/, '');
  return { description, body };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ProjectSettings({ cwd, projectName, open, onClose, wsSend }: ProjectSettingsProps) {
  // MCP state
  const [servers, setServers] = useState<Record<string, McpServerEntry>>({});
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [mcpForm] = Form.useForm<McpFormValues>();
  const serverType = Form.useWatch('serverType', mcpForm);

  // Skills state
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillModalOpen, setSkillModalOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<string | null>(null);
  const [skillForm] = Form.useForm<SkillFormValues>();
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importForm] = Form.useForm<ImportFormValues>();
  const [importLoading, setImportLoading] = useState(false);

  // ── MCP logic ─────────────────────────────────────────────────────────────

  const loadMcpConfig = useCallback(async () => {
    try {
      const config = await invoke<McpConfig>('read_mcp_config', { cwd });
      setServers(config.mcpServers ?? {});
    } catch (err) {
      console.error('Failed to load MCP config:', err);
    }
  }, [cwd]);

  const saveMcpConfig = useCallback(async (newServers: Record<string, McpServerEntry>) => {
    try {
      await invoke('write_mcp_config', { cwd, config: { mcpServers: newServers } });
      wsSend({ type: 'reload_agent', cwd });
      setServers(newServers);
    } catch (err) {
      console.error('Failed to save MCP config:', err);
    }
  }, [cwd, wsSend]);

  const handleMcpDelete = useCallback((key: string) => {
    const next = { ...servers };
    delete next[key];
    void saveMcpConfig(next);
  }, [servers, saveMcpConfig]);

  const handleMcpEdit = useCallback((key: string) => {
    const entry = servers[key];
    if (!entry) return;

    if (isHttpServer(entry)) {
      mcpForm.setFieldsValue({
        name: key,
        serverType: 'http',
        url: entry.url,
        headers: entry.headers ? Object.entries(entry.headers).map(([k, v]) => `${k}=${v}`).join('\n') : '',
        command: '',
        args: '',
        env: '',
      });
    } else {
      mcpForm.setFieldsValue({
        name: key,
        serverType: 'stdio',
        command: entry.command,
        args: entry.args?.join(' ') ?? '',
        env: entry.env ? Object.entries(entry.env).map(([k, v]) => `${k}=${v}`).join('\n') : '',
        url: '',
        headers: '',
      });
    }
    setEditingKey(key);
    setMcpModalOpen(true);
  }, [servers, mcpForm]);

  const handleMcpAdd = useCallback(() => {
    mcpForm.resetFields();
    mcpForm.setFieldsValue({ serverType: 'stdio' });
    setEditingKey(null);
    setMcpModalOpen(true);
  }, [mcpForm]);

  const handleMcpModalOk = useCallback(async () => {
    try {
      const values = await mcpForm.validateFields();
      const next = { ...servers };

      if (editingKey && editingKey !== values.name) {
        delete next[editingKey];
      }

      if (values.serverType === 'http') {
        const entry: HttpServer = { type: 'http', url: values.url };
        if (values.headers?.trim()) {
          entry.headers = Object.fromEntries(
            values.headers.split('\n').filter(Boolean).map((line) => {
              const idx = line.indexOf('=');
              return idx > 0 ? [line.slice(0, idx).trim(), line.slice(idx + 1).trim()] : [line.trim(), ''];
            }),
          );
        }
        next[values.name] = entry;
      } else {
        const entry: StdioServer = { command: values.command };
        if (values.args?.trim()) {
          entry.args = values.args.split(/\s+/).filter(Boolean);
        }
        if (values.env?.trim()) {
          entry.env = Object.fromEntries(
            values.env.split('\n').filter(Boolean).map((line) => {
              const idx = line.indexOf('=');
              return idx > 0 ? [line.slice(0, idx).trim(), line.slice(idx + 1).trim()] : [line.trim(), ''];
            }),
          );
        }
        next[values.name] = entry;
      }

      await saveMcpConfig(next);
      setMcpModalOpen(false);
    } catch {
      // validation failed
    }
  }, [mcpForm, servers, editingKey, saveMcpConfig]);

  // ── Skills logic ──────────────────────────────────────────────────────────

  const loadSkills = useCallback(async () => {
    try {
      const list = await invoke<SkillInfo[]>('list_skills', { cwd });
      setSkills(list);
    } catch (err) {
      console.error('Failed to load skills:', err);
    }
  }, [cwd]);

  const handleSkillDelete = useCallback(async (name: string) => {
    try {
      await invoke('delete_skill', { cwd, name });
      wsSend({ type: 'reload_agent', cwd });
      await loadSkills();
    } catch (err) {
      console.error('Failed to delete skill:', err);
    }
  }, [cwd, wsSend, loadSkills]);

  const handleSkillEdit = useCallback((skill: SkillInfo) => {
    const { description, body } = parseSkillContent(skill.content);
    skillForm.setFieldsValue({
      name: skill.name,
      description,
      content: body,
    });
    setEditingSkill(skill.name);
    setSkillModalOpen(true);
  }, [skillForm]);

  const handleSkillAdd = useCallback(() => {
    skillForm.resetFields();
    setEditingSkill(null);
    setSkillModalOpen(true);
  }, [skillForm]);

  const handleSkillModalOk = useCallback(async () => {
    try {
      const values = await skillForm.validateFields();
      const fullContent = buildSkillContent(values.name, values.description, values.content);

      // If editing and name changed, delete old
      if (editingSkill && editingSkill !== values.name) {
        await invoke('delete_skill', { cwd, name: editingSkill });
      }

      await invoke('write_skill', { cwd, name: values.name, content: fullContent });
      wsSend({ type: 'reload_agent', cwd });
      await loadSkills();
      setSkillModalOpen(false);
    } catch {
      // validation failed
    }
  }, [skillForm, editingSkill, cwd, wsSend, loadSkills]);

  const handleImportOk = useCallback(async () => {
    try {
      const values = await importForm.validateFields();
      setImportLoading(true);
      const imported = await invoke<string[]>('import_skills_zip', {
        cwd,
        source: values.source,
        path: values.path,
      });
      wsSend({ type: 'reload_agent', cwd });
      await loadSkills();
      setImportModalOpen(false);
      message.success(`${imported.length} 个 skill 已导入：${imported.join(', ')}`);
    } catch (err) {
      message.error(`导入失败：${err}`);
    } finally {
      setImportLoading(false);
    }
  }, [importForm, cwd, wsSend, loadSkills]);

  // ── Load on open ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (open) {
      void loadMcpConfig();
      void loadSkills();
    }
  }, [open, loadMcpConfig, loadSkills]);

  // ── Render ────────────────────────────────────────────────────────────────

  const serverEntries = Object.entries(servers);

  const mcpTab = (
    <>
      <div className={styles.serverList}>
        {serverEntries.length === 0 && (
          <div className={styles.emptyHint}>暂无 MCP 服务器配置</div>
        )}
        {serverEntries.map(([key, entry]) => (
          <div key={key} className={styles.serverCard}>
            <div className={styles.serverInfo}>
              <div className={styles.serverName}>
                {key}{' '}
                <Tag color={isHttpServer(entry) ? 'blue' : 'green'}>
                  {isHttpServer(entry) ? 'HTTP' : 'stdio'}
                </Tag>
              </div>
              <div className={styles.serverMeta}>
                {isHttpServer(entry) ? entry.url : `${entry.command} ${entry.args?.join(' ') ?? ''}`}
              </div>
            </div>
            <div className={styles.serverActions}>
              <Button type="text" size="small" icon={<EditOutlined />} onClick={() => handleMcpEdit(key)} />
              <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => handleMcpDelete(key)} />
            </div>
          </div>
        ))}
      </div>

      <Button
        type="dashed"
        icon={<PlusOutlined />}
        onClick={handleMcpAdd}
        block
        className={styles.addBtn}
      >
        添加 MCP 服务器
      </Button>

      <Modal
        title={editingKey ? '编辑 MCP 服务器' : '添加 MCP 服务器'}
        open={mcpModalOpen}
        onOk={() => void handleMcpModalOk()}
        onCancel={() => setMcpModalOpen(false)}
        destroyOnClose
      >
        <Form form={mcpForm} layout="vertical" initialValues={{ serverType: 'stdio' }}>
          <Form.Item name="name" label="服务器名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="my-server" />
          </Form.Item>

          <Form.Item name="serverType" label="类型">
            <Radio.Group>
              <Radio.Button value="stdio">stdio</Radio.Button>
              <Radio.Button value="http">HTTP</Radio.Button>
            </Radio.Group>
          </Form.Item>

          {serverType === 'http' ? (
            <>
              <Form.Item name="url" label="URL" rules={[{ required: true, message: '请输入 URL' }]}>
                <Input placeholder="http://localhost:3001" />
              </Form.Item>
              <Form.Item name="headers" label="Headers (key=value, 每行一个)">
                <Input.TextArea rows={3} placeholder={'Authorization=Bearer xxx'} />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item name="command" label="Command" rules={[{ required: true, message: '请输入命令' }]}>
                <Input placeholder="npx" />
              </Form.Item>
              <Form.Item name="args" label="Args (空格分隔)">
                <Input placeholder="-y @modelcontextprotocol/server-filesystem /" />
              </Form.Item>
              <Form.Item name="env" label="环境变量 (key=value, 每行一个)">
                <Input.TextArea rows={3} placeholder={'NODE_ENV=production'} />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </>
  );

  const skillsTab = (
    <>
      <div className={styles.skillList}>
        {skills.length === 0 && (
          <div className={styles.emptyHint}>暂无 Skills 配置</div>
        )}
        {skills.map((skill) => (
          <div key={skill.name} className={styles.skillCard}>
            <div className={styles.serverInfo}>
              <div className={styles.serverName}>{skill.name}</div>
              <div className={styles.serverMeta}>{skill.description || '无描述'}</div>
            </div>
            <div className={styles.skillActions}>
              <Button type="text" size="small" icon={<EditOutlined />} onClick={() => handleSkillEdit(skill)} />
              <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => handleSkillDelete(skill.name)} />
            </div>
          </div>
        ))}
      </div>

      <div className={styles.skillButtons}>
        <Button type="dashed" icon={<PlusOutlined />} onClick={handleSkillAdd}>
          添加 Skill
        </Button>
        <Button type="dashed" icon={<ImportOutlined />} onClick={() => { importForm.resetFields(); importForm.setFieldsValue({ source: 'file' }); setImportModalOpen(true); }}>
          导入 Skills
        </Button>
      </div>

      {/* Skill add/edit modal */}
      <Modal
        title={editingSkill ? '编辑 Skill' : '添加 Skill'}
        open={skillModalOpen}
        onOk={() => void handleSkillModalOk()}
        onCancel={() => setSkillModalOpen(false)}
        destroyOnClose
      >
        <Form form={skillForm} layout="vertical">
          <Form.Item
            name="name"
            label="Skill 名称"
            rules={[
              { required: true, message: '请输入名称' },
              { pattern: /^[a-z0-9][a-z0-9-]*$/, message: '仅限小写字母、数字和连字符' },
              { max: 64, message: '不超过 64 个字符' },
            ]}
          >
            <Input placeholder="my-skill" disabled={editingSkill !== null} />
          </Form.Item>
          <Form.Item
            name="description"
            label="描述 (何时使用此 skill)"
            rules={[
              { required: true, message: '请输入描述' },
              { max: 1024, message: '不超过 1024 个字符' },
            ]}
          >
            <Input.TextArea rows={2} placeholder="When Claude should use this skill" />
          </Form.Item>
          <Form.Item
            name="content"
            label="Prompt 正文"
            rules={[{ required: true, message: '请输入 prompt 内容' }]}
          >
            <Input.TextArea rows={8} placeholder="Skill 的 prompt 内容..." />
          </Form.Item>
        </Form>
      </Modal>

      {/* Import modal */}
      <Modal
        title="导入 Skills (ZIP)"
        open={importModalOpen}
        onOk={() => void handleImportOk()}
        onCancel={() => setImportModalOpen(false)}
        confirmLoading={importLoading}
        destroyOnClose
      >
        <Form form={importForm} layout="vertical" initialValues={{ source: 'file' }}>
          <Form.Item name="source" label="来源">
            <Radio.Group>
              <Radio.Button value="file">本地 ZIP 文件</Radio.Button>
              <Radio.Button value="url">URL 下载</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Form.Item
            name="path"
            label="路径 / URL"
            rules={[{ required: true, message: '请输入路径或 URL' }]}
          >
            <Input placeholder="/path/to/skills.zip 或 https://example.com/skills.zip" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );

  return (
    <Drawer
      title={`${projectName} - 项目设置`}
      open={open}
      onClose={onClose}
      width={420}
      destroyOnClose
      className={styles.drawer}
    >
      <Tabs
        className={styles.tabs}
        defaultActiveKey="mcp"
        items={[
          { key: 'mcp', label: 'MCP 服务器', children: mcpTab },
          { key: 'skills', label: 'Skills', children: skillsTab },
        ]}
      />
    </Drawer>
  );
}
