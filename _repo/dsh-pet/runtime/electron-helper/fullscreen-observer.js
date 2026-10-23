'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
function parseSample(line) {
  if (line.length > 16384) throw Error('Fullscreen probe output too large');
  const data = JSON.parse(line);
  if (!Array.isArray(data.screens) || data.screens.length > 32) throw Error('Invalid fullscreen probe sample');
  return data.screens.map((r) => {
    if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0)
      throw Error('Invalid monitor rectangle');
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}
function startObserver(onChange) {
  let child,
    timer,
    stopped = false,
    last = 0,
    buffer = '';
  const state = { status: process.platform === 'win32' ? 'starting' : 'unsupported', screens: [], error: '' };
  const publish = () => {
    if (state.status !== 'ready') state.screens = [];
    onChange({ ...state, screens: [...state.screens] });
  };
  if (process.platform === 'win32') {
    const executable = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    child = spawn(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, 'fullscreen-probe.ps1'),
        '-ParentProcessId',
        String(process.pid),
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text) => {
      buffer += text;
      if (buffer.length > 32768) {
        state.status = 'error';
        state.error = '全屏检测返回异常数据';
        buffer = '';
        publish();
        return;
      }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          state.screens = parseSample(line);
          state.status = 'ready';
          state.error = '';
          last = Date.now();
          publish();
        } catch {
          state.status = 'error';
          state.error = '无法读取全屏状态';
          publish();
        }
      }
    });
    let detail = '';
    child.stderr.on('data', (text) => {
      detail = (detail + String(text)).slice(-600);
    });
    child.on('error', () => {
      state.status = 'error';
      state.error = '无法启动 Windows 全屏检测';
      publish();
    });
    child.on('exit', () => {
      if (!stopped) {
        state.status = 'error';
        state.error = '全屏检测已退出；智能模式已退回普通窗口层。' + (detail ? ' 请检查 PowerShell 是否可运行。' : '');
        publish();
      }
    });
    const started = Date.now();
    timer = setInterval(() => {
      if (Date.now() - (last || started) > (last ? 2500 : 15000)) {
        state.status = 'error';
        state.error = '全屏检测无响应；智能模式已退回普通窗口层。';
        publish();
      }
    }, 1000);
    timer.unref?.();
  }
  publish();
  return {
    state,
    stop() {
      stopped = true;
      clearInterval(timer);
      child?.kill();
    },
  };
}
module.exports = { parseSample, startObserver };
