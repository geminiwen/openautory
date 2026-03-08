#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, RunEvent};
use tauri_plugin_log::{Target, TargetKind};

// ── helpers ──────────────────────────────────────────────────────────────────

fn expand_home(cwd: &str) -> Result<PathBuf, String> {
    if cwd.starts_with("~/") || cwd == "~" {
        let home = std::env::var("HOME")
            .map(PathBuf::from)
            .map_err(|_| "Cannot determine home directory".to_string())?;
        if cwd == "~" { Ok(home) } else { Ok(home.join(&cwd[2..])) }
    } else {
        Ok(PathBuf::from(cwd))
    }
}

fn session_dir(cwd: &str) -> Result<PathBuf, String> {
    let expanded = expand_home(cwd)?;
    let encoded = expanded
        .to_str()
        .ok_or("Invalid cwd path")?
        .replace(['/', '.'], "-");
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "Cannot determine home directory".to_string())?;
    Ok(home.join(".claude").join("projects").join(encoded))
}

fn contract_home(path: &std::path::Path) -> String {
    if let Ok(home_str) = std::env::var("HOME") {
        let home = PathBuf::from(&home_str);
        if let Ok(rel) = path.strip_prefix(&home) {
            return format!("~/{}", rel.display());
        }
    }
    path.to_string_lossy().to_string()
}

// ── project config ────────────────────────────────────────────────────────────

fn projects_config_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "Cannot determine home directory".to_string())?;
    Ok(home.join(".autory").join("projects.json"))
}

fn read_projects_config() -> Result<Vec<String>, String> {
    let path = projects_config_path()?;
    let default_cwd = "~/.autory".to_string();

    let mut cwds: Vec<String> = if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Cannot read projects config: {e}"))?;
        let v: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Invalid projects config: {e}"))?;
        v.get("projects")
            .and_then(|p| p.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| item.get("cwd")?.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        vec![]
    };

    // Ensure ~/.autory is always first
    cwds.retain(|c| c != &default_cwd);
    cwds.insert(0, default_cwd);
    Ok(cwds)
}

fn write_projects_config(cwds: &[String]) -> Result<(), String> {
    let path = projects_config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create config directory: {e}"))?;
    }
    let projects: Vec<serde_json::Value> = cwds.iter()
        .map(|cwd| serde_json::json!({ "cwd": cwd }))
        .collect();
    let config = serde_json::json!({ "projects": projects });
    std::fs::write(&path, serde_json::to_string_pretty(&config).unwrap())
        .map_err(|e| format!("Cannot write projects config: {e}"))?;
    Ok(())
}

fn project_display_name(cwd: &str) -> String {
    if cwd == "~/.autory" || cwd == "~/.autory/" {
        "默认项目".to_string()
    } else {
        cwd.trim_end_matches('/')
            .split('/')
            .next_back()
            .unwrap_or(cwd)
            .to_string()
    }
}

const SESSION_PREVIEW_MAX_CHARS: usize = 80;

fn sanitize_inline_text(raw: &str) -> Option<String> {
    let normalized = raw.replace('\n', " ").trim().to_string();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn sanitize_prompt_text(raw: &str) -> Option<String> {
    let text = sanitize_inline_text(raw)?;
    if text.starts_with('/') || text == "[session initialized]" {
        return None;
    }
    // 与 Claude Code 过滤规则对齐：跳过中断占位与本地系统块。
    if text.starts_with("[Request interrupted by user") {
        return None;
    }
    if text.starts_with("<local-command-stdout>")
        || text.starts_with("<session-start-hook>")
        || text.starts_with("<tick>")
        || text.starts_with("<goal>")
    {
        return None;
    }
    if text.contains("<ide_opened_file>") || text.contains("<ide_selection>") {
        return None;
    }
    Some(text)
}

fn truncate_chars(raw: &str, max_chars: usize) -> String {
    raw.chars().take(max_chars).collect::<String>()
}

fn extract_user_prompt(msg_content: &serde_json::Value) -> Option<String> {
    if let Some(s) = msg_content.as_str() {
        return sanitize_prompt_text(s);
    }

    let arr = msg_content.as_array()?;

    // tool_result 不是用户自然输入，不纳入 prompt。
    if arr.iter().any(|b| b.get("type").and_then(|v| v.as_str()) == Some("tool_result")) {
        return None;
    }

    arr.iter().find_map(|b| {
        if b.get("type")?.as_str()? != "text" {
            return None;
        }
        let text = b.get("text")?.as_str()?;
        sanitize_prompt_text(text)
    })
}

fn derive_session_preview(content: &[u8]) -> String {
    let mut custom_title: Option<String> = None;
    let mut last_prompt: Option<String> = None;
    let mut auto_summary: Option<String> = None;
    let mut first_prompt: Option<String> = None;

    for line in content.split(|&b| b == b'\n').filter(|line| !line.is_empty()) {
        let Ok(d) = serde_json::from_slice::<serde_json::Value>(line) else { continue };

        if let Some(title) = d.get("customTitle").and_then(|v| v.as_str()).and_then(sanitize_inline_text) {
            custom_title = Some(title);
        }
        if let Some(prompt) = d.get("lastPrompt").and_then(|v| v.as_str()).and_then(sanitize_prompt_text) {
            last_prompt = Some(prompt);
        }
        if let Some(summary) = d.get("summary").and_then(|v| v.as_str()).and_then(sanitize_inline_text) {
            auto_summary = Some(summary);
        }

        let t = d.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if t != "user" {
            continue;
        }
        if d.get("isSidechain").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        if d.get("isMeta").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        if d.get("isCompactSummary").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        let Some(msg_content) = d.get("message").and_then(|m| m.get("content")) else { continue };
        let Some(prompt) = extract_user_prompt(msg_content) else { continue };
        if first_prompt.is_none() {
            first_prompt = Some(prompt);
        }
    }

    let preview = custom_title
        .or(last_prompt)
        .or(auto_summary)
        .or(first_prompt)
        .unwrap_or_default();

    truncate_chars(&preview, SESSION_PREVIEW_MAX_CHARS)
}

// ── commands ──────────────────────────────────────────────────────────────────

/// 恢复或新建 session：
/// - 若 ~/.claude/projects/<encoded-cwd>/ 下存在 .jsonl 文件，返回最近修改的那个的 UUID；
/// - 否则返回空字符串——由服务端首条消息触发 SDK 建立新 session。
/// cwd 由前端传入（支持 ~ 展开，如 "~/.autory"）。
#[tauri::command]
fn get_or_create_session(cwd: String) -> Result<String, String> {
    let dir = session_dir(&cwd)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create session directory: {e}"))?;

    let latest = std::fs::read_dir(&dir)
        .map_err(|e| format!("Cannot read session directory: {e}"))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.extension()?.to_str()? != "jsonl" { return None; }
            let metadata = entry.metadata().ok()?;
            if metadata.len() <= 300 { return None; }
            let modified = metadata.modified().ok()?;
            Some((modified, path))
        })
        .max_by_key(|(modified, _)| *modified);

    if let Some((_, path)) = latest {
        let session_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or("Invalid session filename")?
            .to_string();
        log::info!("Session resumed: {session_id} (cwd={cwd})");
        return Ok(session_id);
    }

    log::info!("No existing session found, starting fresh (cwd={cwd})");
    Ok(String::new())
}

/// Session 摘要，用于侧边栏列表。
#[derive(serde::Serialize)]
struct SessionInfo {
    id: String,
    modified: i64,   // Unix ms
    preview: String, // 标题预览（customTitle > lastPrompt > summary > firstPrompt），截取 80 字符
}

fn list_sessions_inner(cwd: &str) -> Result<Vec<SessionInfo>, String> {
    let dir = session_dir(cwd)?;
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut sessions: Vec<SessionInfo> = std::fs::read_dir(&dir)
        .map_err(|e| format!("Cannot read session directory: {e}"))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.extension()?.to_str()? != "jsonl" { return None; }
            let metadata = entry.metadata().ok()?;
            if metadata.len() <= 300 { return None; }

            let id = path.file_stem()?.to_str()?.to_string();
            let modified = metadata.modified().ok()?;
            let modified_ms = modified
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_millis() as i64;

            // 按 Claude 风格优先级生成 preview。
            let content = std::fs::read(&path).ok()?;
            let preview = derive_session_preview(&content);

            Some(SessionInfo { id, modified: modified_ms, preview })
        })
        .collect();

    sessions.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(sessions)
}

/// 列出指定 cwd 下所有有效 session，按修改时间降序排列。
#[tauri::command]
fn list_sessions(cwd: String) -> Result<Vec<SessionInfo>, String> {
    list_sessions_inner(&cwd)
}

/// 项目信息，用于侧边栏多项目列表。
#[derive(serde::Serialize)]
struct ProjectInfo {
    cwd: String,
    name: String,
    sessions: Vec<SessionInfo>,
}

/// 列出所有项目及其 sessions。
#[tauri::command]
fn list_projects() -> Result<Vec<ProjectInfo>, String> {
    let cwds = read_projects_config()?;
    let mut projects = Vec::new();
    for cwd in &cwds {
        let sessions = list_sessions_inner(cwd)?;
        projects.push(ProjectInfo {
            cwd: cwd.clone(),
            name: project_display_name(cwd),
            sessions,
        });
    }
    Ok(projects)
}

/// 添加新项目（去重），返回更新后的项目列表。
#[tauri::command]
fn add_project(cwd: String) -> Result<Vec<ProjectInfo>, String> {
    let mut cwds = read_projects_config()?;
    if !cwds.contains(&cwd) {
        cwds.push(cwd);
        write_projects_config(&cwds)?;
    }
    list_projects()
}

/// 删除项目（禁止删除默认项目），返回更新后的项目列表。
#[tauri::command]
fn remove_project(cwd: String) -> Result<Vec<ProjectInfo>, String> {
    if cwd == "~/.autory" {
        return Err("Cannot remove the default project".to_string());
    }
    let mut cwds = read_projects_config()?;
    cwds.retain(|c| c != &cwd);
    write_projects_config(&cwds)?;
    list_projects()
}

/// 为新 session 创建合法的 .jsonl 文件（写入 queue-operation 初始记录）。
/// SDK 通过这两条记录识别有效 session，从而直接使用 desktop 提供的 UUID。
#[tauri::command]
fn create_session(session_id: String, cwd: String) -> Result<(), String> {
    let dir = session_dir(&cwd)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create session directory: {e}"))?;
    let file = dir.join(format!("{session_id}.jsonl"));
    if file.exists() {
        return Ok(());
    }
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let expanded_cwd = expand_home(&cwd)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| cwd.clone());
    let entry_uuid = uuid::Uuid::new_v4().to_string();
    let init_record = serde_json::json!({
        "parentUuid": null,
        "isSidechain": false,
        "isMeta": true,
        "userType": "external",
        "cwd": expanded_cwd,
        "sessionId": session_id,
        "version": "2.1.71",
        "gitBranch": "HEAD",
        "type": "user",
        "message": { "role": "user", "content": "[session initialized]" },
        "uuid": entry_uuid,
        "timestamp": now,
        "permissionMode": "bypassPermissions"
    });
    std::fs::write(&file, format!("{}\n", init_record))
        .map_err(|e| format!("Cannot write session file: {e}"))?;
    log::info!("Session file initialized: {session_id} (cwd={cwd})");
    Ok(())
}

/// 删除指定 session：.jsonl 文件 + 同名目录（含所有子 task/agent）。
#[tauri::command]
fn delete_session(session_id: String, cwd: String) -> Result<(), String> {
    let dir = session_dir(&cwd)?;

    let file = dir.join(format!("{session_id}.jsonl"));
    if file.exists() {
        std::fs::remove_file(&file)
            .map_err(|e| format!("Cannot delete session: {e}"))?;
    }

    let sub_dir = dir.join(&session_id);
    if sub_dir.is_dir() {
        std::fs::remove_dir_all(&sub_dir)
            .map_err(|e| format!("Cannot delete session directory: {e}"))?;
    }

    log::info!("Session deleted: {session_id} (cwd={cwd})");
    Ok(())
}

/// 弹出原生文件夹选择器，返回选中路径（~/... 格式）。
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::{DialogExt, FilePath};
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<FilePath>>();
    app.dialog()
        .file()
        .pick_folder(move |folder| {
            let _ = tx.send(folder);
        });
    let result = rx.await.map_err(|_| "Dialog error".to_string())?;
    Ok(result.and_then(|fp| match fp {
        FilePath::Path(path) => Some(contract_home(&path)),
        _ => None,
    }))
}

/// 从 session .jsonl 文件中解析对话历史，返回 [{role, text}] 列表。
/// user:      { role: "user", text: "..." }
/// assistant: { role: "assistant", blocks: [ { type: "thinking"|"text"|"tool_use", ... } ] }
#[tauri::command]
fn read_session_messages(session_id: String, cwd: String) -> Result<Vec<serde_json::Value>, String> {
    let dir = session_dir(&cwd)?;
    let file = dir.join(format!("{session_id}.jsonl"));

    if !file.exists() {
        return Ok(vec![]);
    }

    let content = std::fs::read(&file)
        .map_err(|e| format!("Cannot read session file: {e}"))?;

    let mut messages = Vec::new();

    for line in content.split(|&b| b == b'\n') {
        if line.is_empty() { continue; }
        let Ok(d) = serde_json::from_slice::<serde_json::Value>(line) else { continue };

        let t = d.get("type").and_then(|v| v.as_str()).unwrap_or("");

        // compact 产生的摘要：插入一条 role=summary 消息
        if t == "summary" {
            if let Some(text) = d.get("summary").and_then(|v| v.as_str()) {
                messages.push(serde_json::json!({ "role": "summary", "text": text }));
            }
            continue;
        }

        if t != "user" && t != "assistant" { continue; }
        if d.get("isSidechain").and_then(|v| v.as_bool()).unwrap_or(false) { continue; }
        if d.get("isMeta").and_then(|v| v.as_bool()).unwrap_or(false) { continue; }
        // tool_result 消息（工具返回值）和 plan prompt 不是用户手动输入，跳过
        if d.get("sourceToolAssistantUUID").is_some() { continue; }
        if d.get("planContent").is_some() { continue; }

        if t == "user" {
            let msg_content = match d.get("message").and_then(|m| m.get("content")) {
                Some(c) => c,
                None => continue,
            };
            let text = if let Some(s) = msg_content.as_str() {
                if s.is_empty() || s.starts_with('/') { continue; }
                s.to_string()
            } else if let Some(arr) = msg_content.as_array() {
                match arr.iter().find_map(|b| {
                    if b.get("type")?.as_str()? == "text" {
                        b.get("text")?.as_str().map(|s| s.to_string())
                    } else { None }
                }) {
                    Some(s) if !s.is_empty() && !s.starts_with('/') => s,
                    _ => continue,
                }
            } else {
                continue
            };
            messages.push(serde_json::json!({ "role": "user", "text": text }));
        } else {
            let content_arr = match d.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
                Some(arr) => arr,
                None => continue,
            };
            let mut blocks = Vec::new();
            for b in content_arr {
                match b.get("type").and_then(|v| v.as_str()) {
                    Some("thinking") => {
                        let text = b.get("thinking").and_then(|v| v.as_str()).unwrap_or("");
                        if !text.is_empty() {
                            blocks.push(serde_json::json!({ "type": "thinking", "text": text }));
                        }
                    }
                    Some("text") => {
                        let text = b.get("text").and_then(|v| v.as_str()).unwrap_or("");
                        if !text.is_empty() && text != "No response requested." {
                            blocks.push(serde_json::json!({ "type": "text", "text": text }));
                        }
                    }
                    Some("tool_use") => {
                        let id = b.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let name = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        let input = b.get("input").cloned().unwrap_or(serde_json::json!({}));
                        blocks.push(serde_json::json!({
                            "type": "tool_use",
                            "id": id,
                            "name": name,
                            "input": input
                        }));
                    }
                    _ => {}
                }
            }
            if !blocks.is_empty() {
                // 合并连续的 assistant 消息（跳过 tool_result 后相邻的 assistant 应合并）
                let should_merge = matches!(
                    messages.last(),
                    Some(last) if last.get("role").and_then(|v| v.as_str()) == Some("assistant")
                );
                if should_merge {
                    if let Some(arr) = messages.last_mut()
                        .and_then(|l| l.get_mut("blocks"))
                        .and_then(|v| v.as_array_mut())
                    {
                        for b in blocks { arr.push(b); }
                    }
                } else {
                    messages.push(serde_json::json!({ "role": "assistant", "blocks": blocks }));
                }
            }
        }
    }

    Ok(messages)
}

// ── server process management ─────────────────────────────────────────────────

#[cfg(not(debug_assertions))]
use tauri_plugin_shell::ShellExt;

/// 统一封装 dev（std::process::Child）和 release（sidecar CommandChild）两种句柄
enum ServerHandle {
    Dev(std::process::Child),
    #[cfg(not(debug_assertions))]
    Sidecar(tauri_plugin_shell::process::CommandChild),
}

impl ServerHandle {
    fn kill(self) {
        match self {
            Self::Dev(mut child) => {
                #[cfg(unix)]
                {
                    let pid = child.id();
                    let _ = std::process::Command::new("kill")
                        .args(["-TERM", &pid.to_string()])
                        .status();
                    for _ in 0..30 {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        if matches!(child.try_wait(), Ok(Some(_))) {
                            return;
                        }
                    }
                    let _ = child.kill();
                }
                #[cfg(not(unix))]
                {
                    let _ = child.kill();
                }
            }
            #[cfg(not(debug_assertions))]
            Self::Sidecar(child) => {
                let _ = child.kill();
            }
        }
    }
}

struct ServerProcess(Mutex<Option<ServerHandle>>);

fn main() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                ])
                .level(log::LevelFilter::Info)
                .max_file_size(10_000_000)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_or_create_session,
            create_session,
            list_sessions,
            list_projects,
            add_project,
            remove_project,
            pick_folder,
            delete_session,
            read_session_messages,
        ])
        .setup(|app| {
            // Ctrl+C → app_handle.exit(0) → RunEvent::Exit → cleanup
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::signal::ctrl_c().await.ok();
                    log::info!("Ctrl+C received, shutting down");
                    app_handle.exit(0);
                });
            }

            #[cfg(debug_assertions)]
            {
                let server_dir = std::path::PathBuf::from(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../../../apps/server"
                ));
                match std::process::Command::new("bun")
                    .args(["run", "--watch", "src/index.ts"])
                    .current_dir(&server_dir)
                    .env("LOG_DIR", "/tmp")
                    .env("LOG_LEVEL", "info")
                    .spawn()
                {
                    Ok(child) => {
                        log::info!("Server started in dev mode (bun --watch)");
                        app.manage(ServerProcess(Mutex::new(Some(ServerHandle::Dev(child)))));
                    }
                    Err(e) => {
                        log::error!("Failed to start dev server: {e}");
                        app.manage(ServerProcess(Mutex::new(None)));
                    }
                }
            }

            #[cfg(not(debug_assertions))]
            {
                let result = (|| -> Result<_, Box<dyn std::error::Error>> {
                    let cmd = app.shell().sidecar("server")?;
                    Ok(cmd.spawn()?)
                })();

                match result {
                    Ok((rx, child)) => {
                        log::info!("Server sidecar started");
                        app.manage(ServerProcess(Mutex::new(Some(ServerHandle::Sidecar(child)))));
                        tauri::async_runtime::spawn(async move {
                            let mut rx = rx;
                            while rx.recv().await.is_some() {}
                        });
                    }
                    Err(e) => {
                        log::error!("Failed to start server sidecar: {e}");
                        app.manage(ServerProcess(Mutex::new(None)));
                    }
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                let handle = {
                    let state = app_handle.state::<ServerProcess>();
                    state.0.lock().ok().and_then(|mut g| g.take())
                };
                if let Some(handle) = handle {
                    log::info!("Stopping server");
                    handle.kill();
                }
            }
        });
}
