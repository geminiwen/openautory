#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager, RunEvent};
use tauri_plugin_log::{Target, TargetKind};

#[derive(Clone, serde::Serialize)]
struct ServerLog {
    stream: String,
    line: String,
}

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

fn encode_cwd(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn session_dir(cwd: &str) -> Result<PathBuf, String> {
    let expanded = expand_home(cwd)?;
    let encoded = encode_cwd(
        expanded.to_str().ok_or("Invalid cwd path")?,
    );
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

// ── MCP config ────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize)]
struct McpConfig {
    #[serde(rename = "mcpServers", default)]
    mcp_servers: serde_json::Value,
}

#[tauri::command]
fn read_mcp_config(cwd: String) -> Result<McpConfig, String> {
    let expanded = expand_home(&cwd)?;
    let config_path = expanded.join(".mcp.json");
    if !config_path.exists() {
        return Ok(McpConfig { mcp_servers: serde_json::json!({}) });
    }
    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Cannot read .mcp.json: {e}"))?;
    let config: McpConfig = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid .mcp.json: {e}"))?;
    Ok(config)
}

#[tauri::command]
fn write_mcp_config(cwd: String, config: McpConfig) -> Result<(), String> {
    let expanded = expand_home(&cwd)?;
    let config_path = expanded.join(".mcp.json");
    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Cannot serialize config: {e}"))?;
    std::fs::write(&config_path, json)
        .map_err(|e| format!("Cannot write .mcp.json: {e}"))?;
    log::info!("MCP config written to {}", config_path.display());
    Ok(())
}

// ── skills ────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct SkillInfo {
    name: String,
    description: String,
    content: String,
}

fn parse_frontmatter(raw: &str) -> (String, String) {
    // Extract description from ---\n...\n--- frontmatter block
    if !raw.starts_with("---") {
        return (String::new(), String::new());
    }
    let after_first = &raw[3..];
    let Some(end_idx) = after_first.find("\n---") else {
        return (String::new(), String::new());
    };
    let fm_block = &after_first[..end_idx];
    let mut name = String::new();
    let mut description = String::new();
    for line in fm_block.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("name:") {
            name = rest.trim().trim_matches('"').trim_matches('\'').to_string();
        } else if let Some(rest) = trimmed.strip_prefix("description:") {
            description = rest.trim().trim_matches('"').trim_matches('\'').to_string();
        }
    }
    (name, description)
}

#[tauri::command]
fn list_skills(cwd: String) -> Result<Vec<SkillInfo>, String> {
    let expanded = expand_home(&cwd)?;
    let skills_dir = expanded.join(".claude").join("skills");
    if !skills_dir.exists() {
        return Ok(vec![]);
    }
    let mut skills = Vec::new();
    let entries = std::fs::read_dir(&skills_dir)
        .map_err(|e| format!("Cannot read skills directory: {e}"))?;
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path.is_dir() { continue; }
        let skill_file = path.join("SKILL.md");
        if !skill_file.exists() { continue; }
        let dir_name = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let content = std::fs::read_to_string(&skill_file)
            .map_err(|e| format!("Cannot read {}: {e}", skill_file.display()))?;
        let (_name, description) = parse_frontmatter(&content);
        skills.push(SkillInfo {
            name: dir_name,
            description,
            content,
        });
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

#[tauri::command]
fn write_skill(cwd: String, name: String, content: String) -> Result<(), String> {
    let expanded = expand_home(&cwd)?;
    let skill_dir = expanded.join(".claude").join("skills").join(&name);
    std::fs::create_dir_all(&skill_dir)
        .map_err(|e| format!("Cannot create skill directory: {e}"))?;
    let skill_file = skill_dir.join("SKILL.md");
    std::fs::write(&skill_file, &content)
        .map_err(|e| format!("Cannot write SKILL.md: {e}"))?;
    log::info!("Skill written: {} (cwd={})", name, cwd);
    Ok(())
}

#[tauri::command]
fn delete_skill(cwd: String, name: String) -> Result<(), String> {
    let expanded = expand_home(&cwd)?;
    let skill_dir = expanded.join(".claude").join("skills").join(&name);
    if skill_dir.exists() {
        std::fs::remove_dir_all(&skill_dir)
            .map_err(|e| format!("Cannot delete skill directory: {e}"))?;
    }
    log::info!("Skill deleted: {} (cwd={})", name, cwd);
    Ok(())
}

#[tauri::command]
async fn import_skills_zip(cwd: String, source: String, path: String) -> Result<Vec<String>, String> {
    let expanded = expand_home(&cwd)?;
    let skills_dir = expanded.join(".claude").join("skills");
    std::fs::create_dir_all(&skills_dir)
        .map_err(|e| format!("Cannot create skills directory: {e}"))?;

    let zip_bytes: Vec<u8> = if source == "url" {
        reqwest::blocking::get(&path)
            .map_err(|e| format!("Download failed: {e}"))?
            .bytes()
            .map_err(|e| format!("Failed to read response: {e}"))?
            .to_vec()
    } else {
        std::fs::read(&path)
            .map_err(|e| format!("Cannot read ZIP file: {e}"))?
    };

    let cursor = std::io::Cursor::new(&zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| format!("Invalid ZIP file: {e}"))?;

    // ── Validation pass: collect top-level dirs and check structure ──────
    let mut top_level_dirs: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut has_skill_md = false;

    for i in 0..archive.len() {
        let file = archive.by_index(i)
            .map_err(|e| format!("Cannot read ZIP entry: {e}"))?;
        let Some(enclosed_name) = file.enclosed_name().map(|p| p.to_path_buf()) else {
            return Err("ZIP 包含不安全的路径".to_string());
        };

        let components: Vec<_> = enclosed_name.components().collect();
        if components.is_empty() { continue; }

        // Record top-level directory name
        let top = components[0].as_os_str().to_str().unwrap_or("").to_string();
        if top.is_empty() { continue; }

        // Skip macOS resource fork directory
        if top == "__MACOSX" { continue; }

        // Skip directory entries themselves (e.g. "skill-name/")
        if file.is_dir() {
            top_level_dirs.insert(top);
            continue;
        }

        // All files must be under a single top-level directory
        if components.len() < 2 {
            return Err(format!(
                "ZIP 结构不合法：文件 \"{}\" 不在子目录中。ZIP 应包含一个文件夹，文件夹内至少有 SKILL.md",
                enclosed_name.display()
            ));
        }

        top_level_dirs.insert(top);

        let file_name = enclosed_name.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        if file_name == "SKILL.md" {
            has_skill_md = true;
        }
    }

    if top_level_dirs.is_empty() {
        return Err("ZIP 文件为空".to_string());
    }
    if top_level_dirs.len() != 1 {
        return Err(format!(
            "ZIP 结构不合法：应只包含一个文件夹，但发现了 {} 个顶层目录：{}",
            top_level_dirs.len(),
            top_level_dirs.into_iter().collect::<Vec<_>>().join(", ")
        ));
    }
    if !has_skill_md {
        return Err("ZIP 结构不合法：文件夹内缺少 SKILL.md".to_string());
    }

    let skill_name = top_level_dirs.into_iter().next().unwrap();

    // Validate skill name format
    if !skill_name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        || skill_name.starts_with('-')
    {
        return Err(format!(
            "Skill 名称不合法：\"{}\"，仅限小写字母、数字和连字符",
            skill_name
        ));
    }

    // ── Extract pass ────────────────────────────────────────────────────────
    let cursor2 = std::io::Cursor::new(&zip_bytes);
    let mut archive2 = zip::ZipArchive::new(cursor2)
        .map_err(|e| format!("Invalid ZIP file: {e}"))?;

    let target_dir = skills_dir.join(&skill_name);
    std::fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Cannot create directory: {e}"))?;

    for i in 0..archive2.len() {
        let mut file = archive2.by_index(i)
            .map_err(|e| format!("Cannot read ZIP entry: {e}"))?;
        if file.is_dir() { continue; }
        let Some(enclosed_name) = file.enclosed_name().map(|p| p.to_path_buf()) else { continue };

        // Strip the top-level directory prefix, write remaining path under target_dir
        let components: Vec<_> = enclosed_name.components().collect();
        if components.len() < 2 { continue; }

        // Skip macOS resource fork directory
        let top = components[0].as_os_str().to_str().unwrap_or("");
        if top == "__MACOSX" { continue; }
        let rel_path: PathBuf = components[1..].iter().collect();
        let target_file = target_dir.join(&rel_path);

        if let Some(parent) = target_file.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create directory: {e}"))?;
        }

        let mut out = std::fs::File::create(&target_file)
            .map_err(|e| format!("Cannot create file: {e}"))?;
        std::io::copy(&mut file, &mut out)
            .map_err(|e| format!("Cannot write file: {e}"))?;
    }

    log::info!("Imported skill \"{}\" from ZIP (cwd={})", skill_name, cwd);
    Ok(vec![skill_name])
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
/// 从字符串中提取指定 XML 标签的内容，如 `<tag>content</tag>` → `Some("content")`
fn extract_xml_tag(s: &str, tag: &str) -> Option<String> {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    let start = s.find(&open)? + open.len();
    let end = s[start..].find(&close)? + start;
    let content = s[start..end].trim();
    if content.is_empty() { None } else { Some(content.to_string()) }
}

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
        // context compaction 摘要和仅 transcript 可见的消息不在 UI 展示
        if d.get("isCompactSummary").and_then(|v| v.as_bool()).unwrap_or(false) { continue; }
        if d.get("isVisibleInTranscriptOnly").and_then(|v| v.as_bool()).unwrap_or(false) { continue; }

        if t == "user" {
            let msg_content = match d.get("message").and_then(|m| m.get("content")) {
                Some(c) => c,
                None => continue,
            };
            let raw = if let Some(s) = msg_content.as_str() {
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
            // 解析 Claude Code 协议 XML 标签
            let mut is_command_output = false;
            let text = if raw.starts_with('<') {
                if raw.starts_with("<task-notification>") {
                    // 原样显示，后续再决定如何处理
                    raw
                } else if raw.starts_with("<command-name>") || raw.starts_with("<command-message>") {
                    // slash command：提取命令名和参数，加 / 前缀与 WS 实时路径保持一致
                    let cmd = extract_xml_tag(&raw, "command-name")
                        .or_else(|| extract_xml_tag(&raw, "command-message"))
                        .unwrap_or_default();
                    let args = extract_xml_tag(&raw, "command-args").unwrap_or_default();
                    let display = if args.is_empty() { format!("/{}", cmd) } else { format!("/{} {}", cmd, args) };
                    if cmd.is_empty() { continue; }
                    display
                } else if raw.starts_with("<local-command-stdout>") {
                    is_command_output = true;
                    extract_xml_tag(&raw, "local-command-stdout").unwrap_or_default()
                } else if raw.starts_with("<local-command-stderr>") {
                    is_command_output = true;
                    extract_xml_tag(&raw, "local-command-stderr").unwrap_or_default()
                } else {
                    raw
                }
            } else {
                raw
            };
            if text.is_empty() { continue; }
            let mut msg = serde_json::json!({ "role": "user", "text": text });
            if is_command_output { msg["isCommandOutput"] = serde_json::json!(true); }
            messages.push(msg);
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

// ── shell PATH resolution ─────────────────────────────────────────────────────

/// 从用户的 login shell（zsh / bash）中读取 PATH 环境变量。
/// macOS GUI 应用不继承终端 shell 的 PATH，需要主动获取。
fn get_shell_path() -> Option<String> {
    for shell in &["zsh", "bash"] {
        if let Ok(output) = std::process::Command::new(shell)
            .args(["-ilc", "echo $PATH"])
            .stderr(std::process::Stdio::null())
            .output()
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                // 取最后一行非空内容（interactive shell 可能输出其他内容）
                if let Some(path) = stdout.lines().rev().find(|l| !l.trim().is_empty()) {
                    let path = path.trim();
                    if !path.is_empty() {
                        log::info!("Resolved PATH from {shell}: {path}");
                        return Some(path.to_string());
                    }
                }
            }
        }
    }
    log::warn!("Failed to resolve PATH from login shell, using inherited PATH");
    None
}

// ── server process management ─────────────────────────────────────────────────

#[cfg(not(debug_assertions))]
use tauri_plugin_shell::ShellExt;

/// 统一封装 dev（std::process::Child）和 release（sidecar CommandChild）两种句柄
enum ServerHandle {
    #[cfg(debug_assertions)]
    Dev(std::process::Child),
    #[cfg(not(debug_assertions))]
    Sidecar(tauri_plugin_shell::process::CommandChild),
}

impl ServerHandle {
    fn kill(self) {
        match self {
            #[cfg(debug_assertions)]
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
            read_mcp_config,
            write_mcp_config,
            list_skills,
            write_skill,
            delete_skill,
            import_skills_zip,
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

            let shell_path = get_shell_path();

            #[cfg(debug_assertions)]
            {
                let server_dir = std::path::PathBuf::from(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../../../apps/server"
                ));
                let mut cmd = std::process::Command::new("bun");
                cmd.args(["run", "--watch", "src/index.ts"])
                    .current_dir(&server_dir)
                    .env("LOG_DIR", "/tmp")
                    .env("LOG_LEVEL", "info")
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped());
                {
                    let base = shell_path.as_deref().unwrap_or("");
                    let combined = format!("{}:{}", server_dir.display(), base);
                    cmd.env("PATH", combined);
                }
                match cmd.spawn()
                {
                    Ok(mut child) => {
                        log::info!("Server started in dev mode (bun --watch)");

                        // Spawn threads to read stdout/stderr and emit events
                        let stdout = child.stdout.take();
                        let stderr = child.stderr.take();
                        let app_handle = app.handle().clone();

                        if let Some(stdout) = stdout {
                            let handle = app_handle.clone();
                            std::thread::spawn(move || {
                                use std::io::BufRead;
                                let reader = std::io::BufReader::new(stdout);
                                for line in reader.lines() {
                                    let Ok(line) = line else { break };
                                    let _ = handle.emit("server-log", ServerLog {
                                        stream: "stdout".into(),
                                        line,
                                    });
                                }
                            });
                        }

                        if let Some(stderr) = stderr {
                            let handle = app_handle.clone();
                            std::thread::spawn(move || {
                                use std::io::BufRead;
                                let reader = std::io::BufReader::new(stderr);
                                for line in reader.lines() {
                                    let Ok(line) = line else { break };
                                    let _ = handle.emit("server-log", ServerLog {
                                        stream: "stderr".into(),
                                        line,
                                    });
                                }
                            });
                        }

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
                    let mut cmd = app.shell().sidecar("server")?;
                    // 把 sidecar 二进制所在目录加到 PATH，方便 server 找到同目录下的脚本/工具
                    let sidecar_dir = std::env::current_exe()
                        .ok()
                        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
                    let base = shell_path.as_deref().unwrap_or("");
                    let path_val = match sidecar_dir {
                        Some(dir) => format!("{}:{}", dir.display(), base),
                        None => base.to_string(),
                    };
                    cmd = cmd.env("PATH", &path_val);
                    Ok(cmd.spawn()?)
                })();

                match result {
                    Ok((rx, child)) => {
                        log::info!("Server sidecar started");
                        app.manage(ServerProcess(Mutex::new(Some(ServerHandle::Sidecar(child)))));
                        let app_handle = app.handle().clone();
                        tauri::async_runtime::spawn(async move {
                            use tauri_plugin_shell::process::CommandEvent;
                            let mut rx = rx;
                            while let Some(event) = rx.recv().await {
                                match event {
                                    CommandEvent::Stdout(bytes) => {
                                        let line = String::from_utf8_lossy(&bytes).to_string();
                                        let _ = app_handle.emit("server-log", ServerLog {
                                            stream: "stdout".into(),
                                            line,
                                        });
                                    }
                                    CommandEvent::Stderr(bytes) => {
                                        let line = String::from_utf8_lossy(&bytes).to_string();
                                        let _ = app_handle.emit("server-log", ServerLog {
                                            stream: "stderr".into(),
                                            line,
                                        });
                                    }
                                    _ => {}
                                }
                            }
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

#[cfg(test)]
mod tests {
    use super::encode_cwd;

    #[test]
    fn replaces_slashes_and_dots() {
        assert_eq!(
            encode_cwd("/Users/geminiwen/Code/openautory"),
            "-Users-geminiwen-Code-openautory"
        );
    }

    #[test]
    fn replaces_underscores() {
        assert_eq!(
            encode_cwd("/Users/cosmos_pro/.autory"),
            "-Users-cosmos-pro--autory"
        );
    }

    #[test]
    fn replaces_spaces() {
        assert_eq!(
            encode_cwd("/Users/my user/project"),
            "-Users-my-user-project"
        );
    }

    #[test]
    fn preserves_alphanumeric() {
        assert_eq!(encode_cwd("abc123"), "abc123");
    }

    #[test]
    fn replaces_all_special_characters() {
        assert_eq!(
            encode_cwd("/home/user@host:~/my-project (v2)"),
            "-home-user-host---my-project--v2-"
        );
    }
}
