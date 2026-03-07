#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{Manager, RunEvent};
use tauri_plugin_log::{Target, TargetKind};

#[cfg(not(debug_assertions))]
use tauri_plugin_shell::ShellExt;

/// 统一封装 dev（std::process::Child）和 release（sidecar CommandChild）两种句柄
enum ServerHandle {
    Dev(std::process::Child),
    #[cfg(not(debug_assertions))]
    Sidecar(tauri_plugin_shell::process::CommandChild),
}

impl ServerHandle {
    // 消耗 self，避免 CommandChild::kill(self) 的所有权问题
    fn kill(self) {
        match self {
            Self::Dev(mut child) => {
                let _ = child.kill();
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
        .setup(|app| {
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
            if let RunEvent::ExitRequested { .. } = event {
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
