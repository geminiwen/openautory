import React from 'react';
import ReactDOM from 'react-dom/client';
import {
  attachConsole,
  debug,
  info,
  warn,
  error,
} from '@tauri-apps/plugin-log';
import App from './App';
import './styles.css';

async function setup() {
  // Route Rust log messages → browser devtools console
  await attachConsole();

  // Route browser console.* → Tauri log plugin → log file
  const _log = console.log.bind(console);
  const _debug = console.debug.bind(console);
  const _warn = console.warn.bind(console);
  const _error = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    _log(...args);
    void info(args.map(String).join(' '));
  };
  console.debug = (...args: unknown[]) => {
    _debug(...args);
    void debug(args.map(String).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    _warn(...args);
    void warn(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    _error(...args);
    void error(args.map(String).join(' '));
  };
}

setup()
  .catch(console.error)
  .finally(() => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  });
