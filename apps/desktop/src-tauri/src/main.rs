#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, RunEvent};
use tauri_plugin_log::{Target, TargetKind};

/// 恢复或新建 session：
/// - 若 ~/.claude/projects/<encoded-cwd>/ 下存在 .jsonl 文件，返回最近修改的那个的 UUID；
/// - 否则创建新文件并返回新 UUID。
/// cwd 由前端传入（支持 ~ 展开，如 "~/.autory"）。
#[tauri::command]
fn get_or_create_session(cwd: String) -> Result<String, String> {
    // 展开 ~
    let expanded_cwd: PathBuf = if cwd.starts_with("~/") || cwd == "~" {
        let home = std::env::var("HOME")
            .map(PathBuf::from)
            .map_err(|_| "Cannot determine home directory".to_string())?;
        if cwd == "~" { home } else { home.join(&cwd[2..]) }
    } else {
        PathBuf::from(&cwd)
    };

    // 编码：将路径中的 / 和 . 替换为 -（与 Claude Code 保持一致）
    let encoded = expanded_cwd
        .to_str()
        .ok_or("Invalid cwd path")?
        .replace(['/', '.'], "-");

    // 构造目录 ~/.claude/projects/<encoded>/
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "Cannot determine home directory".to_string())?;
    let dir = home.join(".claude").join("projects").join(&encoded);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create session directory: {e}"))?;

    // 查找最近修改的、有真实对话数据的 .jsonl 文件（> 300 字节，排除仅含 snapshot 的 stub）
    let latest = std::fs::read_dir(&dir)
        .map_err(|e| format!("Cannot read session directory: {e}"))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.extension()?.to_str()? != "jsonl" { return None; }
            let metadata = entry.metadata().ok()?;
            if metadata.len() <= 300 { return None; } // 跳过 stub 文件
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

    // 无真实 session，返回空字符串——由服务端首条消息触发 SDK 建立新 session
    log::info!("No existing session found, starting fresh (cwd={cwd})");
    Ok(String::new())
}

/// 从 session .jsonl 文件中解析对话历史，返回 [{role, text}] 列表。
/// 从 session .jsonl 解析主链对话，返回结构化消息列表。
/// user:      { role: "user", text: "..." }
/// assistant: { role: "assistant", blocks: [ { type: "thinking"|"text"|"tool_use", ... } ] }
#[tauri::command]
fn read_session_messages(session_id: String, cwd: String) -> Result<Vec<serde_json::Value>, String> {
    // 展开 ~
    let expanded_cwd: PathBuf = if cwd.starts_with("~/") || cwd == "~" {
        let home = std::env::var("HOME")
            .map(PathBuf::from)
            .map_err(|_| "Cannot determine home directory".to_string())?;
        if cwd == "~" { home } else { home.join(&cwd[2..]) }
    } else {
        PathBuf::from(&cwd)
    };

    let encoded = expanded_cwd
        .to_str()
        .ok_or("Invalid cwd")?
        .replace(['/', '.'], "-");

    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "Cannot determine home directory".to_string())?;
    let file = home
        .join(".claude")
        .join("projects")
        .join(&encoded)
        .join(format!("{session_id}.jsonl"));

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
            // 只取第一个 text block（跳过 tool_result）
            let text = content_arr.iter().find_map(|b| {
                if b.get("type")?.as_str()? == "text" {
                    b.get("text")?.as_str().map(|s| s.to_string())
                } else { None }
            });
            if let Some(text) = text {
                // 跳过 slash command（如 /compact）
                if !text.is_empty() && !text.starts_with('/') {
                    messages.push(serde_json::json!({ "role": "user", "text": text }));
                }
            }
        } else {
            // assistant：保留 thinking / text / tool_use block
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
                        // 跳过 slash command 的内部回复
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
                // Unix：先发 SIGTERM，等待最多 3s，超时再 SIGKILL
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
        .invoke_handler(tauri::generate_handler![get_or_create_session, read_session_messages])
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
                // Dev 模式：直接用系统 bun --hot，支持热重载
                let server_dir = std::path::PathBuf::from(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../../../apps/server"
                ));
                match std::process::Command::new("bun")
                    .args(["run", "--hot", "src/index.ts"])
                    .current_dir(&server_dir)
                    .env("LOG_DIR", "/tmp")
                    .env("LOG_LEVEL", "info")
                    .spawn()
                {
                    Ok(child) => {
                        log::info!("Server started in dev mode (bun --hot)");
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
                // Release 模式：使用编译好的 sidecar
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
                // 用内层块让 state 和 MutexGuard 在 kill() 之前 drop
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
