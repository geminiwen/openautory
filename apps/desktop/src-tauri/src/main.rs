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
    preview: String, // 第一条 user 消息，截取 80 字符
}

/// 列出指定 cwd 下所有有效 session，按修改时间降序排列。
#[tauri::command]
fn list_sessions(cwd: String) -> Result<Vec<SessionInfo>, String> {
    let dir = session_dir(&cwd)?;
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

            // 读取第一条非 slash-command 的 user 消息作为 preview
            let content = std::fs::read(&path).ok()?;
            let preview = content
                .split(|&b| b == b'\n')
                .filter(|line| !line.is_empty())
                .find_map(|line| {
                    let d: serde_json::Value = serde_json::from_slice(line).ok()?;
                    if d.get("type")?.as_str()? != "user" { return None; }
                    if d.get("isSidechain").and_then(|v| v.as_bool()).unwrap_or(false) {
                        return None;
                    }
                    let content_arr = d.get("message")?.get("content")?.as_array()?;
                    content_arr.iter().find_map(|b| {
                        if b.get("type")?.as_str()? != "text" { return None; }
                        let text = b.get("text")?.as_str()?;
                        if text.is_empty() || text.starts_with('/') { return None; }
                        Some(text.chars().take(80).collect::<String>())
                    })
                })
                .unwrap_or_default();

            Some(SessionInfo { id, modified: modified_ms, preview })
        })
        .collect();

    sessions.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(sessions)
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

        let content_arr = match d.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
            Some(arr) => arr,
            None => continue,
        };

        if t == "user" {
            let text = content_arr.iter().find_map(|b| {
                if b.get("type")?.as_str()? == "text" {
                    b.get("text")?.as_str().map(|s| s.to_string())
                } else { None }
            });
            if let Some(text) = text {
                if !text.is_empty() && !text.starts_with('/') {
                    messages.push(serde_json::json!({ "role": "user", "text": text }));
                }
            }
        } else {
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
                messages.push(serde_json::json!({ "role": "assistant", "blocks": blocks }));
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
        .invoke_handler(tauri::generate_handler![
            get_or_create_session,
            list_sessions,
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
